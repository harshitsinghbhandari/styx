// styx-scene: puts the cloud db into a nice default state for judges to see
// the moment the console loads: the P-101 -> P-102 -> P-103 promise chain
// (active), a couple of historical commitments (one fulfilled, one broken),
// and a few precedents. Everything goes through the real kernel functions
// (createPromise, transitionCommitment, linkDependency, precedentStore),
// same pattern as styx-e2e, never a hand-written INSERT.
//
// Reuses the agents styx-seed already created (alice/bob/carol/repair) and
// only clears the commitment-side tables before rebuilding, so operator
// API keys already handed out in ~/.styx-cloud-agents.env stay valid across
// repeated runs -- agents and resources are left untouched.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'node:crypto';

// Relative import, not the "@styx/kernel" package specifier: same reasoning
// as scripts/lambda/e2e/index.ts (no "main"/"exports" in kernel's package.json).
type Kernel = typeof import('../../../kernel/src/index.js');
type PrecedentsModule = typeof import('../../../kernel/src/precedents.js');

interface SceneResult {
  chain: string[]; // P-101, P-102, P-103 ids, in order
  historical: { fulfilled: string; broken: string };
  precedents: number;
}

let coldStart: Promise<{ kernel: Kernel; precedents: PrecedentsModule }> | null = null;

async function init(): Promise<{ kernel: Kernel; precedents: PrecedentsModule }> {
  const ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: '/styx/database-url', WithDecryption: true }));
  const databaseUrl = res.Parameter?.Value;
  if (!databaseUrl) throw new Error('SSM /styx/database-url returned no value');
  // kernel/src/db/pool.ts builds its Pool from process.env.DATABASE_URL at
  // import time, so the env var must land before either import below.
  process.env.DATABASE_URL = databaseUrl;
  const [kernel, precedents] = await Promise.all([
    import('../../../kernel/src/index.js'),
    import('../../../kernel/src/precedents.js'),
  ]);
  return { kernel, precedents };
}

type CommitmentRow = Awaited<ReturnType<Kernel['createPromise']>>['commitment'];

async function activePromise(
  kernel: Kernel,
  debtorId: string,
  creditorId: string,
  deliver: string,
  idempotencyPrefix: string,
): Promise<CommitmentRow> {
  const created = await kernel.createPromise({
    debtorAgentId: debtorId,
    creditorAgentId: creditorId,
    terms: { deliver, deadline: new Date(Date.now() + 7 * 24 * 3600_000).toISOString() },
    idempotencyKey: `${idempotencyPrefix}-create`,
  });
  const activated = await kernel.transitionCommitment({
    commitmentId: created.commitment.id,
    action: 'activate',
    actorId: debtorId,
    expectedVersion: created.commitment.version,
    idempotencyKey: `${idempotencyPrefix}-activate`,
  });
  return activated.commitment;
}

export async function handler(): Promise<SceneResult> {
  if (!coldStart) coldStart = init().catch((err) => {
    coldStart = null;
    throw err;
  });
  const { kernel, precedents } = await coldStart;

  const { rows: agentRows } = await kernel.pool.query<{ name: string; id: string }>(
    "SELECT name, id FROM agents WHERE name IN ('alice', 'bob', 'carol', 'repair')",
  );
  const byName = Object.fromEntries(agentRows.map((r) => [r.name, r.id]));
  if (!byName.alice || !byName.bob || !byName.carol) {
    throw new Error('seed agents alice/bob/carol not found; run styx-seed first');
  }

  // Fresh commitment slate on every run. Deliberately not agents/resources:
  // repeated runs must not invalidate keys already handed to the operator.
  await kernel.pool.query('DELETE FROM commitment_events');
  await kernel.pool.query('DELETE FROM commitment_dependencies');
  await kernel.pool.query('DELETE FROM operation_results');
  await kernel.pool.query('DELETE FROM commitments');
  await kernel.pool.query('DELETE FROM precedents').catch(() => {});

  const runId = randomUUID();

  // P-101 -> P-102 -> P-103: active promise chain via linkDependency
  // (dependsOnId points from the dependent commitment to what it needs).
  const p101 = await activePromise(kernel, byName.alice, byName.carol, 'schema migration', `scene-${runId}-p101`);
  const p102 = await activePromise(kernel, byName.alice, byName.bob, 'API endpoints', `scene-${runId}-p102`);
  await kernel.linkDependency({ commitmentId: p102.id, dependsOnId: p101.id, actorAgentId: byName.alice });
  const p103 = await activePromise(kernel, byName.alice, byName.bob, 'frontend wiring', `scene-${runId}-p103`);
  await kernel.linkDependency({ commitmentId: p103.id, dependsOnId: p102.id, actorAgentId: byName.alice });

  // A couple of historical commitments, unrelated to the chain: one fulfilled, one broken.
  const fulfilledActive = await activePromise(kernel, byName.carol, byName.alice, 'design review', `scene-${runId}-hist-f`);
  const fulfilled = await kernel.transitionCommitment({
    commitmentId: fulfilledActive.id,
    action: 'fulfill',
    actorId: byName.carol,
    expectedVersion: fulfilledActive.version,
    idempotencyKey: `scene-${runId}-hist-f-fulfill`,
  });

  const brokenActive = await activePromise(kernel, byName.bob, byName.carol, 'legacy migration', `scene-${runId}-hist-b`);
  const broken = await kernel.transitionCommitment({
    commitmentId: brokenActive.id,
    action: 'break',
    actorId: byName.bob,
    expectedVersion: brokenActive.version,
    idempotencyKey: `scene-${runId}-hist-b-break`,
    reason: 'demo: superseded by a later approach',
  });

  // A few precedents so the console's precedents view is never empty.
  const precedentSeeds = [
    {
      situation: 'resource conflict on task:build-auth between two agents',
      resolution: 'the losing transaction took the next queued task instead',
      outcome: { resolved: true },
    },
    {
      situation: 'commitment broken mid-chain, dependents cascaded at_risk',
      resolution: 'repair agent linked a replacement commitment and repaired the dependents',
      outcome: { resolved: true },
    },
    {
      situation: 'agent process crashed mid-reservation',
      resolution: 'a fresh agent instance read the obligation back via MCP and resumed it',
      outcome: { resolved: true },
    },
  ];
  for (const p of precedentSeeds) {
    await precedents.precedentStore.record(p);
  }

  // eslint-disable-next-line no-console
  console.log('scene: chain', [p101.id, p102.id, p103.id].join(' -> '), 'historical', fulfilled.commitment.id, broken.commitment.id);

  return {
    chain: [p101.id, p102.id, p103.id],
    historical: { fulfilled: fulfilled.commitment.id, broken: broken.commitment.id },
    precedents: precedentSeeds.length,
  };
}
