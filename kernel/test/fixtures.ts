import type { Pool } from 'pg';

export interface FixtureAgents {
  alice: string;
  bob: string;
  carol: string;
  repair: string;
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE commitment_events, commitment_dependencies, operation_results, commitments, resources, agents CASCADE');
}

export async function seedAgents(pool: Pool): Promise<FixtureAgents> {
  const insert = async (name: string, kind: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (name, kind, api_key_hash) VALUES ($1, $2, 'test-hash') RETURNING id`,
      [name, kind],
    );
    return rows[0].id;
  };
  return {
    alice: await insert('alice', 'buyer'),
    bob: await insert('bob', 'buyer'),
    carol: await insert('carol', 'seller'),
    repair: await insert('repair', 'repair'),
  };
}

// Fleet fixture per v3-plan: 'task:build-auth' (capacity 1), 'deploy-slot'
// (capacity 1), 'ci-runner' (capacity 2).
export async function seedResources(pool: Pool, ownerAgentId: string): Promise<void> {
  await pool.query(
    `INSERT INTO resources (key, owner_agent, capacity) VALUES
       ('task:build-auth', $1, 1),
       ('deploy-slot', $1, 1),
       ('ci-runner', $1, 2)`,
    [ownerAgentId],
  );
}
