// Engine-level Styx attachment: the point of the whole exercise. The runner
// talks to the kernel library directly (no HTTP), through the exported
// kernel functions plus its exported pg Pool for the handful of queries the
// kernel does not itself wrap (creating a resource row, reading commitments
// back out by run). Imported by relative path into kernel/src rather than
// the '@styx/kernel' package specifier: kernel/package.json ships no
// main/exports field yet (it is the other agent's file, out of bounds here),
// so the bare specifier does not resolve. The relative import reaches the
// same workspace source either way.
import type { Pool } from 'pg';
import {
  createPromise,
  transitionCommitment,
  linkDependency,
  reserveResource,
  getCommitment,
} from '../../kernel/src/index.js';
import type { CommitmentRow } from '../../kernel/src/kinds/registry.js';
import type { PipelineDef, StageDef } from './definition.js';
import type { Outcome } from './reducer.js';

const UNIQUE_VIOLATION = '23505';

export function resourceKey(runId: string, stage: string): string {
  return `task:${runId}:${stage}`;
}

/**
 * Per-run task resources, capacity 1 each, created once at run start and
 * owned by the runner agent. Idempotent: safe to call from more than one
 * engine instance racing the same run.
 */
export async function ensureStageResources(
  pool: Pool,
  runId: string,
  def: PipelineDef,
  runnerAgentId: string,
): Promise<void> {
  for (const stage of def.stages) {
    await pool.query(
      `INSERT INTO resources (key, owner_agent, capacity) VALUES ($1, $2, 1)
       ON CONFLICT (key) DO NOTHING`,
      [resourceKey(runId, stage.id), runnerAgentId],
    );
  }
}

function deadlineFor(stage: StageDef, runStartedAt: string): string {
  const base = new Date(runStartedAt).getTime();
  const spanMs = stage.timeout_s ? stage.timeout_s * 1000 : 24 * 60 * 60 * 1000;
  return new Date(base + spanMs).toISOString();
}

/**
 * Create (or, on replay, fetch) the stage's promise commitment and activate
 * it. Day 2 has no distinct owning agents per stage (agent executor is Day
 * 3), so the runner agent is both debtor and creditor of its own stage
 * promises: it is simultaneously the party that owes the stage's delivery
 * (today, by literally running the command itself) and the party the
 * delivery is owed to. This also happens to be what makes a single actor
 * id legal for every transition role the commitment ever needs (activate
 * and fulfill require 'debtor', revoke requires 'creditor').
 * ponytail: single-identity debtor/creditor is a Day 2 stand-in; Day 3's
 * agent executor gives each stage a real owning agent as debtor, runner
 * stays creditor.
 */
export async function createStageCommitment(
  pool: Pool,
  runId: string,
  stage: StageDef,
  runnerAgentId: string,
  runStartedAt: string,
): Promise<CommitmentRow> {
  const { commitment } = await createPromise(
    {
      debtorAgentId: runnerAgentId,
      creditorAgentId: runnerAgentId,
      terms: { deliver: stage.id, run: runId, deadline: deadlineFor(stage, runStartedAt) },
      idempotencyKey: `${runId}:${stage.id}:create-promise`,
    },
    pool,
  );

  if (commitment.status === 'draft') {
    await transitionCommitment(
      {
        commitmentId: commitment.id,
        action: 'activate',
        actorId: runnerAgentId,
        expectedVersion: commitment.version,
        idempotencyKey: `${runId}:${stage.id}:activate`,
      },
      pool,
    );
  }

  const fresh = await getCommitment(commitment.id, pool);
  return fresh ?? commitment;
}

/** Mirrors the DAG: stage commitment depends_on each of its needs' commitments. Tolerates a duplicate link from a racing second engine instance. */
export async function linkStageDependencies(
  pool: Pool,
  commitmentId: string,
  dependsOnCommitmentIds: string[],
): Promise<void> {
  for (const dependsOnId of dependsOnCommitmentIds) {
    try {
      await linkDependency({ commitmentId, dependsOnId }, pool);
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    }
  }
}

/**
 * Reserve this stage's task resource. attemptKey must be unique per engine
 * instance (not per run+stage) so two racing engines genuinely contend for
 * capacity instead of one replaying the other's cached success: the
 * kernel's idempotency table would otherwise hand a losing engine a replay
 * of the winner's result under a shared key, defeating the race entirely.
 */
export async function reserveStage(
  pool: Pool,
  runId: string,
  stage: string,
  runnerAgentId: string,
  attemptKey: string,
): Promise<void> {
  await reserveResource(
    {
      debtorAgentId: runnerAgentId,
      creditorAgentId: runnerAgentId,
      terms: { resource: resourceKey(runId, stage), quantity: 1 },
      idempotencyKey: `${runId}:${stage}:reserve:${attemptKey}`,
    },
    pool,
  );
}

type Action = 'fulfill' | 'break' | 'revoke';

/**
 * succeeded/succeeded_unverified -> fulfill, failed/timed_out (and the
 * Day 3 no_signal/no_output) -> break: both legal from 'active' and
 * 'at_risk' (v1-spec 7 / kernel/src/transition.ts TRANSITIONS table), so
 * these two are outcome-only decisions.
 *
 * cancelled/skipped is not: the kernel has no at_risk -> revoke edge (only
 * draft/active can revoke). A stage the reducer cascades to skipped because
 * an upstream sibling broke is exactly the case where the kernel's own
 * cascadeAtRisk has already flagged this same commitment at_risk (it
 * depends_on the broken one) by the time we get here. 'break' is legal from
 * at_risk and, for a stage that died because of an upstream break, is the
 * more honest terminal state anyway: it was not willingly cancelled, its
 * dependency failed out from under it.
 */
function actionFor(outcome: Outcome, currentStatus: string): Action | null {
  switch (outcome) {
    case 'succeeded':
    case 'succeeded_unverified':
      return 'fulfill';
    case 'failed':
    case 'timed_out':
    case 'no_signal':
    case 'no_output':
      return 'break';
    case 'cancelled':
    case 'skipped':
      return currentStatus === 'at_risk' ? 'break' : 'revoke';
    default:
      return null;
  }
}

/** Transition the stage's commitment per the outcome taxonomy. Idempotency key '<run>:<stage>:<action>'. */
export async function transitionStageCommitment(
  pool: Pool,
  runId: string,
  stage: string,
  commitmentId: string,
  outcome: Outcome,
  runnerAgentId: string,
  reason?: string,
): Promise<void> {
  const current = await getCommitment(commitmentId, pool);
  if (!current) throw new Error(`stage commitment vanished: ${commitmentId}`);
  // Already terminal (a racing engine or a retry already settled it): the
  // deterministic '<run>:<stage>:<action>' idempotency key handles the
  // matching-action replay case; a different action reaching an
  // already-terminal commitment (e.g. cascade skip after the winner already
  // fulfilled) has nothing left to do.
  if (!['active', 'at_risk', 'draft'].includes(current.status)) return;

  const action = actionFor(outcome, current.status);
  if (!action) return;

  await transitionCommitment(
    {
      commitmentId,
      action,
      actorId: runnerAgentId,
      expectedVersion: current.version,
      idempotencyKey: `${runId}:${stage}:${action}`,
      reason,
    },
    pool,
  );
}

export interface StageKernelStatus {
  stage: string;
  commitmentId: string;
  status: string;
}

/**
 * The kernel is the store of record for run status; run.json is display
 * only. This answers purely from commitments rows keyed by terms.run,
 * never from in-memory RunState.
 */
export async function runnerStatus(runId: string, pool: Pool): Promise<StageKernelStatus[]> {
  const { rows } = await pool.query<{ id: string; status: string; deliver: string }>(
    `SELECT id, status, terms->>'deliver' AS deliver FROM commitments
     WHERE kind = 'promise' AND terms->>'run' = $1
     ORDER BY terms->>'deliver'`,
    [runId],
  );
  return rows.map((r) => ({ stage: r.deliver, commitmentId: r.id, status: r.status }));
}
