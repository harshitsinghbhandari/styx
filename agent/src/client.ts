// Thin HTTP client over the kernel API (kernel/src/api/routes.ts). One
// choke point for every Styx tool call an agent makes: auth header,
// idempotency key, JSON in/out, typed error surfacing. No retry logic here
// beyond what fetch gives for free -- idempotency keys make a caller-side
// retry safe, but this package leaves retrying to the caller (the agent
// loop can decide whether a failure is worth a second wake).

export interface CommitmentRow {
  id: string;
  kind: string;
  protocol_version: string;
  debtor_agent_id: string;
  creditor_agent_id: string;
  resource_key: string | null;
  terms: Record<string, unknown>;
  status: string;
  valid_until: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CommitmentEventRow {
  id: string;
  commitment_id: string;
  sequence: number;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_agent_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CreationResult {
  commitment: CommitmentRow;
  event: CommitmentEventRow;
  replayed: boolean;
}

export interface TransitionResult {
  commitment: CommitmentRow;
  event: CommitmentEventRow;
  cascaded: unknown[];
  replayed: boolean;
}

export interface Precedent {
  id: string;
  situation: string;
  resolution: string;
  outcome: Record<string, unknown>;
  source_event: string | null;
  created_at: string;
}

export interface Graph {
  nodes: CommitmentRow[];
  edges: { from: string; to: string }[];
}

/** Typed mirror of kernel/src/api/errors.ts sendError()'s JSON shapes. */
export class StyxApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
    public body: unknown,
  ) {
    super(message);
    this.name = 'StyxApiError';
  }
}

export interface StyxClientOptions {
  baseUrl?: string;
  apiKey: string;
  /** This agent's name, used only to build idempotency keys ('<agent>:<mission>:<action>'), never sent as an identity claim -- the API key is the identity. */
  agentName: string;
}

async function parseJsonOrThrow(res: Response): Promise<any> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new StyxApiError(res.status, body.type ?? 'UNKNOWN', body.message ?? res.statusText, body);
  }
  return body;
}

export class StyxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly agentName: string;

  constructor(opts: StyxClientOptions) {
    this.baseUrl = opts.baseUrl ?? process.env.STYX_API_URL ?? 'http://localhost:4000';
    this.apiKey = opts.apiKey;
    this.agentName = opts.agentName;
  }

  /** '<agent>:<mission>:<action>', the idempotency key convention this whole package uses so a retried call after a crash never double-commits. */
  idempotencyKey(mission: string, action: string): string {
    return `${this.agentName}:${mission}:${action}`;
  }

  private async request(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return parseJsonOrThrow(res);
  }

  async createPromise(args: {
    debtorAgentId: string;
    creditorAgentId: string;
    terms: { deliver: string; deadline: string; [key: string]: unknown };
    mission: string;
    action?: string;
  }): Promise<CreationResult> {
    return this.request('POST', '/v1/commitments', {
      body: { debtorAgentId: args.debtorAgentId, creditorAgentId: args.creditorAgentId, terms: args.terms },
      idempotencyKey: this.idempotencyKey(args.mission, args.action ?? 'create'),
    });
  }

  async reserveResource(args: {
    debtorAgentId: string;
    creditorAgentId: string;
    terms: { resource: string; quantity: number; window?: { from: string; to: string }; [key: string]: unknown };
    mission: string;
    action?: string;
  }): Promise<CreationResult> {
    return this.request('POST', '/v1/reservations', {
      body: { debtorAgentId: args.debtorAgentId, creditorAgentId: args.creditorAgentId, terms: args.terms },
      idempotencyKey: this.idempotencyKey(args.mission, args.action ?? 'reserve'),
    });
  }

  async transition(args: {
    commitmentId: string;
    action: 'activate' | 'fulfill' | 'break' | 'revoke';
    expectedVersion: number;
    mission: string;
    reason?: string;
    evidence?: Record<string, unknown>;
  }): Promise<TransitionResult> {
    return this.request('POST', `/v1/commitments/${args.commitmentId}/transitions`, {
      body: { action: args.action, expectedVersion: args.expectedVersion, reason: args.reason, evidence: args.evidence },
      idempotencyKey: this.idempotencyKey(args.mission, args.action),
    });
  }

  async repair(args: { commitmentId: string; mission: string; reason?: string }): Promise<TransitionResult> {
    return this.request('POST', `/v1/commitments/${args.commitmentId}/repair`, {
      body: { reason: args.reason },
      idempotencyKey: this.idempotencyKey(args.mission, 'repair'),
    });
  }

  async linkDependency(args: { commitmentId: string; dependsOnId: string; dependencyType?: string }): Promise<void> {
    await this.request('POST', `/v1/commitments/${args.commitmentId}/dependencies`, {
      body: { dependsOnId: args.dependsOnId, dependencyType: args.dependencyType },
    });
  }

  async getCommitment(id: string): Promise<CommitmentRow> {
    return this.request('GET', `/v1/commitments/${id}`);
  }

  async getObligations(agentId: string): Promise<CommitmentRow[]> {
    return this.request('GET', `/v1/agents/${agentId}/obligations`);
  }

  async getGraph(commitmentId: string): Promise<Graph> {
    return this.request('GET', `/v1/commitments/${commitmentId}/graph`);
  }

  async getHistory(commitmentId: string): Promise<CommitmentEventRow[]> {
    return this.request('GET', `/v1/commitments/${commitmentId}/history`);
  }

  async searchPrecedents(situation: string, limit = 5): Promise<Precedent[]> {
    return this.request('POST', '/v1/precedents/search', { body: { situation, limit } });
  }

  async recordPrecedent(args: { situation: string; resolution: string; outcome?: Record<string, unknown> }): Promise<void> {
    await this.request('POST', '/v1/precedents', { body: args });
  }

  /**
   * Async iterator over the kernel's SSE stream (kernel/src/api/sse.ts).
   * One line of framing per event; yields the parsed payload plus its
   * event_type. Used by relay.ts to map events to wakes; the /v1/events
   * endpoint requires auth like everything else.
   */
  async *watchEvents(signal: AbortSignal, since?: string): AsyncGenerator<{ eventType: string; data: Record<string, unknown> }> {
    const url = new URL(`${this.baseUrl}/v1/events`);
    if (since) url.searchParams.set('since', since);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal });
    if (!res.ok || !res.body) {
      throw new StyxApiError(res.status, 'SSE_CONNECT_FAILED', `could not open event stream: ${res.status}`, null);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let eventType = 'message';
        let data: string | undefined;
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice('event: '.length);
          else if (line.startsWith('data: ')) data = line.slice('data: '.length);
        }
        if (data === undefined || eventType === 'connected') continue;
        try {
          yield { eventType, data: JSON.parse(data) };
        } catch {
          // heartbeat comments and malformed frames are skipped, not fatal
        }
      }
    }
  }
}
