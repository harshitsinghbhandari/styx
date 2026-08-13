import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { pool } from '../src/db.js';
import { handler, type ChangefeedBatch } from '../src/handler.js';

interface WakeReceiver {
  server: Server;
  url: string;
  received: unknown[];
}

async function startWakeReceiver(): Promise<WakeReceiver> {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200);
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('receiver did not bind');
  return { server, url: `http://127.0.0.1:${address.port}`, received };
}

async function seedCommitmentEvent(): Promise<{ eventId: string; commitmentId: string; debtor: string; creditor: string }> {
  const insertAgent = async (name: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO agents (name, kind, api_key_hash) VALUES ($1, 'buyer', 'x') RETURNING id",
      [name],
    );
    return rows[0].id;
  };
  const debtor = await insertAgent(`debtor-${randomUUID()}`);
  const creditor = await insertAgent(`creditor-${randomUUID()}`);
  const { rows: commitmentRows } = await pool.query<{ id: string }>(
    `INSERT INTO commitments (kind, debtor_agent_id, creditor_agent_id, terms, status)
     VALUES ('promise', $1, $2, '{}', 'active') RETURNING id`,
    [debtor, creditor],
  );
  const commitmentId = commitmentRows[0].id;
  const { rows: eventRows } = await pool.query<{ id: string }>(
    `INSERT INTO commitment_events (commitment_id, sequence, event_type, from_status, to_status, payload)
     VALUES ($1, 1, 'created', NULL, 'active', '{}') RETURNING id`,
    [commitmentId],
  );
  return { eventId: eventRows[0].id, commitmentId, debtor, creditor };
}

let receiver: WakeReceiver;

beforeEach(async () => {
  receiver = await startWakeReceiver();
});

afterAll(async () => {
  await pool.end();
});

describe('router idempotency (v1-spec test 8)', () => {
  it('duplicate delivery of the same changefeed event produces exactly one wake-up round', async () => {
    const { eventId, commitmentId, debtor, creditor } = await seedCommitmentEvent();

    const batch: ChangefeedBatch = {
      payload: [
        {
          after: {
            id: eventId,
            commitment_id: commitmentId,
            sequence: 1,
            event_type: 'created',
            from_status: null,
            to_status: 'active',
          },
        },
      ],
    };

    const first = await handler({ headers: {}, body: JSON.stringify(batch) }, pool, `${receiver.url}/wake`);
    const second = await handler({ headers: {}, body: JSON.stringify(batch) }, pool, `${receiver.url}/wake`);

    expect(JSON.parse(first.body).woken).toBe(2); // debtor + creditor
    expect(JSON.parse(second.body).woken).toBe(0); // deduped, no re-delivery

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM processed_events WHERE event_id = $1', [
      eventId,
    ]);
    expect(rows[0].n).toBe(1);

    // give the fire-and-forget wake POSTs a tick to land
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receiver.received).toHaveLength(2);
    expect(new Set(receiver.received.map((w) => (w as { agent: string }).agent))).toEqual(new Set([debtor, creditor]));
  });

  it('ignores resolved checkpoint messages with no payload', async () => {
    const res = await handler({ headers: {}, body: JSON.stringify({ resolved: '123.0' }) }, pool, `${receiver.url}/wake`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, resolved: '123.0' });
  });

  it('rejects a bad shared secret when one is configured', async () => {
    process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
    try {
      const res = await handler(
        { headers: { 'x-styx-webhook-secret': 'wrong' }, body: JSON.stringify({ payload: [] }) },
        pool,
        `${receiver.url}/wake`,
      );
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.WEBHOOK_SHARED_SECRET;
    }
  });
});
