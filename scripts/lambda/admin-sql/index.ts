// styx-admin-sql: runs a list of plain SQL statements against the cloud
// CockroachDB cluster, one at a time, tolerating per-statement failure so a
// caller can run something like "SET CLUSTER SETTING ..." (which a Basic
// tier cluster may already have on, or may forbid outright) followed by a
// CREATE CHANGEFEED that should still run regardless. This is the extension
// of the styx-migrate pattern: same cold-start SSM resolution, but the SQL
// comes from the invoke payload instead of being baked into the bundle.
//
// NEVER logs or echoes DATABASE_URL. Statements are logged (they are
// operator-authored SQL, not secrets); results include row data the caller
// asked for (e.g. a changefeed job_id) but nothing pulled from env.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { Pool, type QueryResult } from 'pg';

interface AdminSqlEvent {
  statements: string[];
}

interface StatementResult {
  statement: string;
  ok: boolean;
  rowCount?: number | null;
  rows?: unknown[];
  error?: string;
}

interface AdminSqlResult {
  results: StatementResult[];
}

// CREATE CHANGEFEED ... WITH extra_headers='{"x-styx-webhook-secret": "<value>"}'
// embeds a secret literally in the SQL text. Redact it everywhere this
// statement is surfaced (CloudWatch logs and the invoke response), so the
// only place the value lives is SSM and the caller's own process memory.
function redact(statement: string): string {
  return statement.replace(/(extra_headers\s*=\s*')[^']*(')/i, '$1<redacted>$2');
}

let poolPromise: Promise<Pool> | null = null;

async function getPool(): Promise<Pool> {
  const ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: '/styx/database-url', WithDecryption: true }));
  const connectionString = res.Parameter?.Value;
  if (!connectionString) throw new Error('SSM /styx/database-url returned no value');
  return new Pool({ connectionString, max: 3 });
}

export async function handler(event: AdminSqlEvent): Promise<AdminSqlResult> {
  if (!poolPromise) poolPromise = getPool().catch((err) => {
    poolPromise = null;
    throw err;
  });
  const pool = await poolPromise;

  const results: StatementResult[] = [];
  for (const statement of event.statements ?? []) {
    const logged = redact(statement);
    // eslint-disable-next-line no-console
    console.log('admin-sql: running', logged);
    try {
      const res: QueryResult = await pool.query(statement);
      results.push({ statement: logged, ok: true, rowCount: res.rowCount, rows: res.rows });
      // eslint-disable-next-line no-console
      console.log('admin-sql: ok', logged, 'rowCount', res.rowCount);
    } catch (err) {
      const message = (err as Error).message;
      results.push({ statement: logged, ok: false, error: message });
      // eslint-disable-next-line no-console
      console.error('admin-sql: failed', logged, message);
    }
  }
  return { results };
}
