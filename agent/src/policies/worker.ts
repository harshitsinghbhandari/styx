// Worker role: claims a backlog task (a capacity-1 resource reservation),
// does trivial deterministic "work" (no shell, no LLM -- this is scene
// fixture work, not a real coding agent). On a lost claim race
// (ResourceConflict, kernel/src/errors.ts) it moves on to the next task in
// its list instead of giving up -- this is scene1's whole point.
//
// The winning reservation is deliberately left ACTIVE, not fulfilled: a
// reservation's capacity accounting (kernel/src/kinds/reservation.ts) only
// counts active/at_risk rows, so fulfilling it would free the slot right
// back up for a second claimant, defeating the "exactly one owner, ever"
// guarantee a backlog task needs. Active is the durable claim; fulfilling
// a *delivery promise* for the work product (a different commitment kind)
// is the roadmap step once a scene actually needs one.
import type { RolePolicy, WakeContext } from '../agent.js';
import { StyxApiError } from '../client.js';

export interface WorkerConfig {
  /** Ordered backlog task resource keys ('task:<id>') to attempt, in order, on every wake. */
  backlogTasks: string[];
}

export function workerPolicy(config: WorkerConfig): RolePolicy {
  return {
    name: 'worker',
    async onWake(ctx: WakeContext): Promise<void> {
      const { agent, note } = ctx;

      for (const taskKey of config.backlogTasks) {
        let reservation;
        try {
          // ponytail: debtor and creditor are both this worker, the same
          // Day 2 single-identity stand-in runner/src/styx.ts documents --
          // a backlog claim has no separate "party owed the reservation".
          reservation = await agent.client.reserveResource({
            debtorAgentId: agent.agentId,
            creditorAgentId: agent.agentId,
            terms: { resource: taskKey, quantity: 1 },
            mission: taskKey,
          });
        } catch (err) {
          if (err instanceof StyxApiError && err.type === 'RESOURCE_CONFLICT') {
            note(`lost the claim race on ${taskKey}: ${err.type} (available ${JSON.stringify(err.body)})`);
            continue;
          }
          throw err;
        }

        note(`claimed ${taskKey} (commitment ${reservation.commitment.id})`);
        note(`working on ${taskKey}`);
        note(`done with ${taskKey}, keeping the claim active`);
        return;
      }

      note('no backlog task available to claim');
    },
  };
}
