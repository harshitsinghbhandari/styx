// styx-seed: seeds the cloud db with the same demo agents + resources as
// scripts/seed.ts. Not a straight import of that file: seed.ts runs its
// work as a side-effecting main() over the local pool and process.exit()s,
// which is the wrong shape for a Lambda handler; this replicates its
// inserts against a pool built from the SSM-resolved cloud DATABASE_URL.
// ponytail: duplicated insert logic instead of refactoring seed.ts to
// export a reusable function, to keep this change inside scripts/ without
// touching the local demo script's committed shape.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';

interface AgentSeed {
  name: string;
  kind: string;
}

const AGENTS: AgentSeed[] = [
  { name: 'alice', kind: 'buyer' },
  { name: 'bob', kind: 'buyer' },
  { name: 'carol', kind: 'seller' },
  { name: 'repair', kind: 'repair' },
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let poolPromise: Promise<Pool> | null = null;

async function getPool(): Promise<Pool> {
  const ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: '/styx/database-url', WithDecryption: true }));
  const connectionString = res.Parameter?.Value;
  if (!connectionString) throw new Error('SSM /styx/database-url returned no value');
  return new Pool({ connectionString, max: 3 });
}

export async function handler(): Promise<{ agents: Record<string, { id: string; apiKey: string }> }> {
  if (!poolPromise) poolPromise = getPool().catch((err) => {
    poolPromise = null;
    throw err;
  });
  const pool = await poolPromise;

  await pool.query(
    'TRUNCATE commitment_events, commitment_dependencies, operation_results, commitments, resources, agents CASCADE',
  );

  const ids: Record<string, string> = {};
  const keys: Record<string, string> = {};

  for (const agent of AGENTS) {
    const apiKey = randomBytes(24).toString('hex');
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO agents (name, kind, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
      [agent.name, agent.kind, sha256(apiKey)],
    );
    ids[agent.name] = rows[0].id;
    keys[agent.name] = apiKey;
  }

  await pool.query(
    `INSERT INTO resources (key, owner_agent, capacity) VALUES
       ('task:build-auth', $1, 1),
       ('deploy-slot', $1, 1),
       ('ci-runner', $1, 2)`,
    [ids.carol],
  );

  // eslint-disable-next-line no-console
  console.log('styx-seed: seeded agents', Object.keys(ids).join(', '), 'and 3 resources, owner=carol');

  const agents: Record<string, { id: string; apiKey: string }> = {};
  for (const agent of AGENTS) {
    agents[agent.name] = { id: ids[agent.name], apiKey: keys[agent.name] };
  }
  return { agents };
}
