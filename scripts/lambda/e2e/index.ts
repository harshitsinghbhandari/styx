// styx-e2e: proves the kernel + changefeed pipeline end to end against the
// cloud cluster. It bundles the real kernel library (createPromise,
// transitionCommitment) rather than issuing raw SQL, so the exercised path
// is the one runner/agent will actually use: create a throwaway promise,
// activate it, then break it. Each transition writes a commitment_events
// row, which the CREATE CHANGEFEED on commitment_events picks up and
// forwards to styx-router.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'node:crypto';

interface E2eResult {
  commitmentId: string;
  events: string[]; // event_type sequence observed
}

// Relative import, not the "@styx/kernel" package specifier: kernel's
// package.json has no "main"/"exports" field (it is consumed as workspace
// source, not a built package), so plain Node/esbuild resolution of the
// bare specifier fails. router/src and scripts/seed.ts already reach into
// kernel/src the same way.
type Kernel = typeof import('../../../kernel/src/index.js');

let coldStart: Promise<Kernel> | null = null;

async function init(): Promise<Kernel> {
  const ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: '/styx/database-url', WithDecryption: true }));
  const databaseUrl = res.Parameter?.Value;
  if (!databaseUrl) throw new Error('SSM /styx/database-url returned no value');
  process.env.DATABASE_URL = databaseUrl;
  // kernel/src/db/pool.ts creates its Pool as a top-level const read from
  // process.env.DATABASE_URL at import time, so the env var must land
  // before this import, same reasoning as router/src/lambda.ts.
  return import('../../../kernel/src/index.js');
}

export async function handler(): Promise<E2eResult> {
  if (!coldStart) coldStart = init().catch((err) => {
    coldStart = null;
    throw err;
  });
  const kernel = await coldStart;

  const { rows: agentRows } = await kernel.pool.query<{ name: string; id: string }>(
    "SELECT name, id FROM agents WHERE name IN ('alice', 'carol')",
  );
  const byName = Object.fromEntries(agentRows.map((r) => [r.name, r.id]));
  const debtorId = byName.alice;
  const creditorId = byName.carol;
  if (!debtorId || !creditorId) {
    throw new Error('seed agents alice/carol not found; run styx-seed first');
  }

  const runId = randomUUID();
  const events: string[] = [];

  const created = await kernel.createPromise({
    debtorAgentId: debtorId,
    creditorAgentId: creditorId,
    terms: { deliver: `e2e-smoke-${runId}`, deadline: new Date(Date.now() + 3600_000).toISOString() },
    idempotencyKey: `e2e-create-${runId}`,
  });
  events.push(created.event.event_type);

  const activated = await kernel.transitionCommitment({
    commitmentId: created.commitment.id,
    action: 'activate',
    actorId: debtorId,
    expectedVersion: created.commitment.version,
    idempotencyKey: `e2e-activate-${runId}`,
  });
  events.push(activated.event.event_type);

  const broken = await kernel.transitionCommitment({
    commitmentId: created.commitment.id,
    action: 'break',
    actorId: debtorId,
    expectedVersion: activated.commitment.version,
    idempotencyKey: `e2e-break-${runId}`,
    reason: 'styx-e2e throwaway promise',
  });
  events.push(broken.event.event_type);

  // eslint-disable-next-line no-console
  console.log('e2e: commitment', created.commitment.id, 'events', events.join(' -> '));

  return { commitmentId: created.commitment.id, events };
}
