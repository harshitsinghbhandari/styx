// Wake relay: subscribes to the kernel API's SSE stream (GET /v1/events,
// kernel/src/api/sse.ts) and calls wake() on affected fleet members
// in-process. Three wake-target categories per event, matching "debtor,
// creditor, at_risk targets" from the brief:
//   - the commitment's debtor, on 'activated' (a mission just got assigned
//     to it) and 'flagged_at_risk' (its own obligation is now at risk);
//   - the commitment's creditor, on the same events, if different from the
//     debtor;
//   - every fleet member running the repair role, on 'flagged_at_risk'
//     specifically, regardless of whether they are that commitment's
//     debtor or creditor -- repair is a system-wide watcher over the whole
//     graph, not scoped to its own obligations.
// Sequential, not fire-and-forget: events are processed one at a time in
// SSE order, and each affected wake is awaited before moving to the next
// event, so a scene driving the relay can assert on state immediately
// after the events it triggered have been fully processed.
import type { StyxAgent, WakeReason } from './agent.js';
import type { StyxClient } from './client.js';

export interface RelayEvent {
  eventType: string;
  data: Record<string, unknown>;
}

export interface RelayOptions {
  /** Any authenticated client; used only to open the SSE stream and to look up a commitment's debtor/creditor. */
  client: StyxClient;
  /** Kernel agent id -> the fleet member with that identity, for debtor/creditor wake targeting. */
  agentsById: Map<string, StyxAgent>;
  /** Fleet members running the repair role, woken on every flagged_at_risk. */
  repairAgents: StyxAgent[];
  onError?: (err: unknown) => void;
  /** Observability hook for scenes: fires after each event is fully handled (all its wakes awaited). */
  onEvent?: (evt: RelayEvent) => void;
}

const WAKE_WORTHY = new Set(['activated', 'flagged_at_risk']);

export interface Relay {
  stop: () => void;
  /** Resolves once the relay's read loop has actually exited, for clean shutdown in scenes/tests. */
  stopped: Promise<void>;
}

export function startRelay(opts: RelayOptions): Relay {
  const controller = new AbortController();
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const loop = async (): Promise<void> => {
    try {
      for await (const evt of opts.client.watchEvents(controller.signal)) {
        await handleEvent(evt, opts);
        opts.onEvent?.(evt);
      }
    } catch (err) {
      if (!controller.signal.aborted) opts.onError?.(err);
    } finally {
      resolveStopped();
    }
  };
  void loop();

  return { stop: () => controller.abort(), stopped };
}

async function handleEvent(evt: RelayEvent, opts: RelayOptions): Promise<void> {
  if (!WAKE_WORTHY.has(evt.eventType)) return;
  const commitmentId = evt.data.commitment_id as string | undefined;
  if (!commitmentId) return;

  const commitment = await opts.client.getCommitment(commitmentId);
  const reason: WakeReason =
    evt.eventType === 'flagged_at_risk' ? { kind: 'at_risk', commitmentId } : { kind: 'mission_assigned', commitmentId };

  const woken = new Set<string>();
  const wakeOnce = async (agent: StyxAgent | undefined): Promise<void> => {
    if (!agent || woken.has(agent.name)) return;
    woken.add(agent.name);
    await agent.wake(reason).catch((err) => opts.onError?.(err));
  };

  await wakeOnce(opts.agentsById.get(commitment.debtor_agent_id));
  await wakeOnce(opts.agentsById.get(commitment.creditor_agent_id));

  if (evt.eventType === 'flagged_at_risk') {
    for (const repairAgent of opts.repairAgents) {
      await wakeOnce(repairAgent);
    }
  }
}
