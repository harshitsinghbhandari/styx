import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A fresh run id and its own scratch run-folder root, so parallel test files never collide. */
export function freshRun(): { runId: string; runsDir: string } {
  return { runId: randomUUID(), runsDir: mkdtempSync(path.join(tmpdir(), 'styx-runner-test-')) };
}
