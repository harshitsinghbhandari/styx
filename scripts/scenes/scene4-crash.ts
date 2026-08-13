// Scene 4 (v3-plan): kill -9 an agent mid-mission; a fresh process for the
// SAME agent identity discovers its obligations via the API and resumes.
// Agents may die, commitments survive. This scene runs the worker as a
// real child process (agent/src/cli/scene-worker.ts), not in-process like
// scenes 1-3, so it can genuinely be killed.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, seedAgent, seedResource, startSceneKernel, ok, section, finish, waitFor } from './lib.js';

const SCENE = 'scene4-crash';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const workerScript = path.join(repoRoot, 'agent', 'src', 'cli', 'scene-worker.ts');
const RESOURCE_KEY = 'task:crash-test';

interface ChildResult {
  stdout: string;
  code: number | null;
}

function runChild(args: string[]): { child: ReturnType<typeof spawn>; done: Promise<ChildResult> } {
  const child = spawn('npx', ['tsx', workerScript, ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`  [child stderr] ${chunk.toString()}`);
  });
  const done = new Promise<ChildResult>((resolve) => {
    child.on('close', (code) => resolve({ stdout, code }));
  });
  return { child, done };
}

async function main(): Promise<void> {
  const kernel = await startSceneKernel();
  await resetDb(kernel.pool);

  const dispatcher = await seedAgent(kernel.pool, 'dispatcher', 'seller');
  await seedResource(kernel.pool, RESOURCE_KEY, 1, dispatcher.id);
  const worker = await seedAgent(kernel.pool, 'crash-worker', 'worker');

  section('mid-mission: a child process claims the task, then we kill -9 it');
  const claimArgs = ['claim', kernel.baseUrl, worker.id, worker.apiKey, worker.name, RESOURCE_KEY];
  const claim = runChild(claimArgs);

  // Poll the kernel directly for the claim landing, rather than parsing
  // the child's stdout stream for its CLAIMED line: this is the same
  // evidence a real relay-driven observer would use, and it sidesteps any
  // coupling to Node's stdout chunk buffering timing.
  await waitFor(async () => {
    const { rows } = await kernel.pool.query(`SELECT status FROM commitments WHERE resource_key = $1`, [RESOURCE_KEY]);
    return rows.length === 1 && rows[0].status === 'active';
  }, 5000);
  console.log('  claim landed (task:crash-test is active)');

  claim.child.kill('SIGKILL');
  const claimResult = await claim.done;
  ok(claimResult.code === null || claimResult.code !== 0, `the claiming process was killed, not a clean exit (code/signal: ${claimResult.code})`);
  ok(claimResult.stdout.includes('CLAIMED'), `the claiming process printed CLAIMED before it was killed`);

  const { rows: afterKill } = await kernel.pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM commitments WHERE resource_key = $1`,
    [RESOURCE_KEY],
  );
  ok(afterKill.length === 1, `exactly one commitment exists for ${RESOURCE_KEY} after the crash (found ${afterKill.length})`);
  ok(afterKill[0]?.status === 'active', `it is still active: the kernel does not know or care that the agent process died`);
  const originalCommitmentId = afterKill[0]?.id;

  section('a fresh process for the same identity discovers its obligations and resumes');
  const resumeArgs = ['resume', kernel.baseUrl, worker.id, worker.apiKey, worker.name, RESOURCE_KEY];
  const resume = runChild(resumeArgs);
  const resumeResult = await resume.done;
  console.log(resumeResult.stdout.trim().split('\n').map((l) => `  child: ${l}`).join('\n'));

  ok(resumeResult.code === 0, `the resume process exited cleanly (code ${resumeResult.code})`);
  const foundLine = resumeResult.stdout.split('\n').find((l) => l.startsWith('FOUND'));
  ok(!!foundLine && foundLine.includes(originalCommitmentId ?? ''), `resume discovered the original commitment via getObligations (${foundLine})`);

  const resumedLine = resumeResult.stdout.split('\n').find((l) => l.startsWith('RESUMED'));
  ok(!!resumedLine && resumedLine.startsWith('RESUMED 1 '), `resume's idempotent re-claim still names exactly one commitment for the resource (${resumedLine})`);

  section('no duplicate commitments exist');
  const { rows: finalRows } = await kernel.pool.query<{ id: string }>(
    `SELECT id FROM commitments WHERE resource_key = $1`,
    [RESOURCE_KEY],
  );
  ok(finalRows.length === 1, `exactly one commitment total for ${RESOURCE_KEY} (found ${finalRows.length})`);
  ok(finalRows[0]?.id === originalCommitmentId, `it is the SAME commitment the crashed process created, not a new one`);

  await kernel.close();
  finish(SCENE);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nFAIL: ${SCENE} (uncaught error)`);
  process.exit(1); // force exit: an open SSE connection or in-flight child process can otherwise keep the event loop alive
});
