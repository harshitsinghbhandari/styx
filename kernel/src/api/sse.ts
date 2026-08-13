import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

const POLL_MS = 400;
const HEARTBEAT_MS = 15000;

interface EventRow {
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

// ponytail: poll tail, changefeed-driven push if latency matters. CockroachDB
// changefeeds already carry this data out via router/ (day 2 pipeline); this
// endpoint exists so the UI does not need its own webhook receiver.
export function registerEventsRoute(app: FastifyInstance, pool: Pool): void {
  app.get('/v1/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const since = (request.query as { since?: string }).since;
    let cursorTs = since ?? new Date().toISOString();
    let cursorId = '00000000-0000-0000-0000-000000000000';

    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    reply.raw.write('event: connected\ndata: {}\n\n');

    while (!closed) {
      // created_at is selected as text: pg's Date parser truncates
      // CockroachDB's microsecond-precision TIMESTAMPTZ to milliseconds,
      // which made the round-tripped cursor always compare less than the
      // row it came from and redelivered the same row forever.
      const { rows } = await pool.query<EventRow>(
        `SELECT id, commitment_id, sequence, event_type, from_status, to_status,
                actor_agent_id, reason, payload, created_at::text AS created_at
         FROM commitment_events
         WHERE created_at > $1::timestamptz OR (created_at = $1::timestamptz AND id > $2)
         ORDER BY created_at, id
         LIMIT 500`,
        [cursorTs, cursorId],
      );
      for (const row of rows) {
        cursorTs = row.created_at;
        cursorId = row.id;
        reply.raw.write(`id: ${row.id}\nevent: ${row.event_type}\ndata: ${JSON.stringify(row)}\n\n`);
      }
      if (closed) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    clearInterval(heartbeat);
    reply.raw.end();
  });
}
