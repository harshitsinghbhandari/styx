// Seeds demo agents + resources for the day2 smoke flow. Prints each
// agent's raw API key once; only the sha256 hash is stored in the DB.
import { randomBytes, createHash } from 'node:crypto';
import { makePool } from '../kernel/src/db/pool.js';

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

async function main(): Promise<void> {
  const pool = makePool();

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

  console.log('seeded agents (API keys shown once):');
  for (const agent of AGENTS) {
    console.log(`  ${agent.name.padEnd(8)} id=${ids[agent.name]}  key=${keys[agent.name]}`);
  }
  console.log('seeded resources: task:build-auth (1), deploy-slot (1), ci-runner (2), owner=carol');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
