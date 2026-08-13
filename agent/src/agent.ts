// The stripped Hermes-design agent loop: wake(reason) -> read -> decide ->
// act -> sleep. Deterministic policy modules per role; no LLM anywhere in
// this file or in the worker/repair/breaker policies (agent/src/policies/*)
// -- the only place an LLM may appear in this whole package is the
// pluggable reason() hook (agent/src/reason.ts), used solely for the
// repair proposal's human-readable text, never for a decision this loop
// depends on to behave correctly.
import type { StyxClient } from './client.js';
import type { MemoryStore } from './memory.js';
import type { SessionStore } from './store.js';

export type WakeReason =
  | { kind: 'mission_assigned'; commitmentId: string }
  | { kind: 'at_risk'; commitmentId: string }
  // Manual/driver wake: scenes and the fleet's own bootstrap use this to
  // tell a worker "go look for backlog work" without a specific commitment
  // in mind, and to give the breaker utility a trigger.
  | { kind: 'poke'; note?: string };

export interface WakeContext {
  agent: StyxAgent;
  reason: WakeReason;
  sessionId: string;
  /** Append a line to this wake's session log; the mechanism scenes and tests use to verify what an agent actually did (session search), not stdout. */
  note(message: string): void;
}

export interface RolePolicy {
  name: string;
  onWake(ctx: WakeContext): Promise<void>;
}

export interface StyxAgentOptions {
  name: string;
  /** The kernel's agent id (agents.id), resolved once at fleet boot. */
  agentId: string;
  client: StyxClient;
  memory: MemoryStore;
  sessions: SessionStore;
  policy: RolePolicy;
}

/**
 * ponytail: one wake = one session. Hermes' real design lets a session span
 * many turns of one conversation; this stripped agent has no multi-turn
 * conversation at all (each wake is a single deterministic decide-and-act
 * pass), so collapsing wake and session is the honest simplification, not
 * a shortcut around something this package actually needs. If a role ever
 * needs multi-wake continuity beyond what MEMORY.md and session search
 * already give it, promote to a longer-lived session then.
 */
export class StyxAgent {
  readonly name: string;
  readonly agentId: string;
  readonly client: StyxClient;
  readonly memory: MemoryStore;
  readonly sessions: SessionStore;
  private readonly policy: RolePolicy;

  constructor(opts: StyxAgentOptions) {
    this.name = opts.name;
    this.agentId = opts.agentId;
    this.client = opts.client;
    this.memory = opts.memory;
    this.sessions = opts.sessions;
    this.policy = opts.policy;
  }

  async wake(reason: WakeReason): Promise<void> {
    const sessionId = this.sessions.startSession(reason.kind);
    // Frozen snapshot injection: MEMORY.md is read once here and never
    // re-read for the rest of this wake, even if the policy itself writes
    // to memory mid-wake (that write lands on disk immediately, per
    // MemoryStore, but only becomes visible to a FUTURE wake's snapshot).
    const snapshot = this.memory.snapshot();
    this.sessions.appendMessage(sessionId, 'system', snapshot);
    this.sessions.appendMessage(sessionId, 'wake', JSON.stringify(reason));

    const note = (message: string): void => {
      this.sessions.appendMessage(sessionId, 'note', message);
    };

    try {
      await this.policy.onWake({ agent: this, reason, sessionId, note });
      this.sessions.endSession(sessionId, 'ok');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sessions.appendMessage(sessionId, 'error', message);
      this.sessions.endSession(sessionId, 'error');
      throw err;
    }
  }
}
