// Scripted end-to-end demo: `npm run demo` from runner/. Runs
// demo/pipeline.yaml through the engine against the local kernel and
// prints status read back FROM the kernel (the store of record), not from
// the in-memory RunState.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefinitionFile } from '../src/definition.js';
import { Engine } from '../src/engine.js';
import { runnerStatus } from '../src/styx.js';
import { pool } from '../../kernel/src/db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const def = loadDefinitionFile(path.join(here, 'pipeline.yaml'));
  const runId = randomUUID();
  console.log(`starting run ${runId} (${def.name})`);

  const engine = new Engine(runId, def, { runsDir: path.join(here, '..', '.styx-runs') });
  const finalState = await engine.start();

  console.log(`\nlocal reducer view: run ${finalState.status}`);
  for (const [stage, s] of Object.entries(finalState.stages)) {
    console.log(`  ${stage}: ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
  }

  const kernelStatus = await runnerStatus(runId, pool);
  console.log(`\nkernel-derived status (store of record):`);
  for (const s of kernelStatus) {
    console.log(`  ${s.stage}: ${s.status}  [commitment ${s.commitmentId}]`);
  }

  console.log(`\nrun folder: .styx-runs/${runId}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
