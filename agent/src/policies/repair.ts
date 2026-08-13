// Repair role: woken on at_risk. Deterministic decision tree (no LLM
// decides anything here, per v3-plan/hermes.md: LLM only touches the
// cosmetic proposal text via the reason() hook):
//   - if the at_risk commitment has a dependency that is already ACTIVE
//     (its own repair already landed, or it was never really the broken
//     one), repair directly -- no new commitment, no new link, see
//     kernel/src/repair.ts for why that is a legal repair.
//   - else if every dependency is terminal (broken/revoked) or there are
//     none, propose+create+activate a brand-new replacement commitment,
//     link it in as dependency_type 'replaces', then repair.
//   - else (a dependency is itself still at_risk, not yet resolved),
//     defer: this commitment cannot be repaired until that one is.
// After a successful repair, recurse into this commitment's own
// dependents (read straight off the same graph fetch) so one wake heals a
// whole cascade, not just the one commitment named in the wake reason.
import type { RolePolicy, WakeContext } from '../agent.js';
import type { StyxClient } from '../client.js';
import { defaultReason, type ReasonFn } from '../reason.js';

export interface RepairConfig {
  reason?: ReasonFn;
}

function situationFor(deliver: string): string {
  return `commitment for '${deliver}' is at_risk: an upstream dependency broke`;
}

async function repairCascade(
  client: StyxClient,
  ownAgentId: string,
  reason: ReasonFn,
  note: (message: string) => void,
  commitmentId: string,
  visited: Set<string>,
): Promise<void> {
  if (visited.has(commitmentId)) return;
  visited.add(commitmentId);

  const commitment = await client.getCommitment(commitmentId);
  if (commitment.status !== 'at_risk') {
    note(`${commitmentId} is ${commitment.status}, nothing to repair`);
    return;
  }

  const graph = await client.getGraph(commitmentId);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const dependencyIds = [...new Set(graph.edges.filter((e) => e.from === commitmentId).map((e) => e.to))];
  const dependencyStatuses = dependencyIds.map((id) => nodeById.get(id)?.status ?? 'unknown');

  const anyActive = dependencyStatuses.some((s) => s === 'active');
  const anyAtRisk = dependencyStatuses.some((s) => s === 'at_risk');

  const deliver = typeof commitment.terms.deliver === 'string' ? commitment.terms.deliver : commitmentId;

  if (anyActive) {
    note(`${commitmentId} ('${deliver}') has a healed dependency already active; repairing directly, no new link`);
    await client.repair({ commitmentId, mission: commitmentId, reason: 'dependency healed, no new replacement needed' });
    note(`repaired ${commitmentId}`);
  } else if (anyAtRisk) {
    note(`${commitmentId} ('${deliver}') is still blocked on an at_risk dependency; deferring`);
    return;
  } else {
    const situation = situationFor(deliver);
    const precedents = await client.searchPrecedents(situation, 5);
    note(`searched precedents for '${situation}': found ${precedents.length}`);

    const proposal = await reason({ situation, precedents });
    note(`proposal: ${proposal}`);

    // The replacement's debtor must be this repair agent itself: it is the
    // repair agent's own authenticated client that calls activate() next,
    // and activate requires the caller to BE the debtor (kernel/src/transition.ts
    // TRANSITIONS['draft'].activate.roles === ['debtor']). The original
    // commitment's creditor stays the creditor: they are still the party
    // owed delivery, now via this replacement.
    const created = await client.createPromise({
      debtorAgentId: ownAgentId,
      creditorAgentId: commitment.creditor_agent_id,
      terms: { deliver: `${deliver} (replacement)`, deadline: (commitment.terms.deadline as string) ?? commitment.valid_until ?? '2099-01-01T00:00:00Z' },
      mission: commitmentId,
      action: 'create-replacement',
    });
    await client.transition({
      commitmentId: created.commitment.id,
      action: 'activate',
      expectedVersion: created.commitment.version,
      mission: commitmentId,
    });
    note(`created replacement ${created.commitment.id} for ${commitmentId}`);

    await client.linkDependency({ commitmentId, dependsOnId: created.commitment.id, dependencyType: 'replaces' });
    note(`linked ${created.commitment.id} as a replacement for ${commitmentId}`);

    await client.repair({ commitmentId, mission: commitmentId, reason: proposal });
    note(`repaired ${commitmentId}`);

    await client.recordPrecedent({
      situation,
      resolution: proposal,
      outcome: { resolved: true, replacement_id: created.commitment.id, repaired_commitment_id: commitmentId },
    });
    note('recorded precedent');
  }

  const dependentIds = [...new Set(graph.edges.filter((e) => e.to === commitmentId).map((e) => e.from))];
  for (const dependentId of dependentIds) {
    await repairCascade(client, ownAgentId, reason, note, dependentId, visited);
  }
}

export function repairPolicy(config: RepairConfig = {}): RolePolicy {
  const reason = config.reason ?? defaultReason();
  return {
    name: 'repair',
    async onWake(ctx: WakeContext): Promise<void> {
      if (ctx.reason.kind !== 'at_risk') {
        ctx.note(`repair agent ignoring a ${ctx.reason.kind} wake, nothing at_risk named`);
        return;
      }
      await repairCascade(ctx.agent.client, ctx.agent.agentId, reason, ctx.note, ctx.reason.commitmentId, new Set());
    },
  };
}
