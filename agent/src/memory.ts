// Bounded MEMORY.md store: one flat file per agent, plain-text entries
// joined by a section-sign delimiter, hard character cap. Rejects writes
// that would overflow the cap instead of truncating, so nothing is ever
// silently lost -- callers repair over the cap via replace()/remove().

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DELIMITER = '\n\xa7\n';
const DEFAULT_CAP = 8000;
const RULE = '='.repeat(38);

export class MemoryCapExceeded extends Error {
  constructor(
    public used: number,
    public cap: number,
    public entries: string[],
  ) {
    super(
      `memory cap exceeded: would use ${used}/${cap} chars across ${entries.length} entries -- consolidate via replace() or drop via remove()`,
    );
    this.name = 'MemoryCapExceeded';
  }
}

export class MemoryStore {
  private readonly filePath: string;
  private readonly cap: number;

  constructor(dir: string, cap: number = DEFAULT_CAP) {
    mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'MEMORY.md');
    this.cap = cap;
  }

  private readEntries(): string[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    if (raw === '') return [];
    return raw.split(DELIMITER);
  }

  private writeEntries(entries: string[]): void {
    writeFileSync(this.filePath, entries.join(DELIMITER), 'utf8');
  }

  private findUniqueMatch(entries: string[], needle: string): number {
    const matches: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].includes(needle)) matches.push(i);
    }
    if (matches.length === 0) throw new Error(`no entry contains "${needle}"`);
    if (matches.length > 1) {
      throw new Error(`ambiguous match: "${needle}" appears in ${matches.length} entries`);
    }
    return matches[0];
  }

  add(content: string): void {
    const entries = this.readEntries();
    if (entries.includes(content)) return; // exact duplicate: silent no-op
    const next = [...entries, content];
    const used = next.join(DELIMITER).length;
    if (used > this.cap) throw new MemoryCapExceeded(used, this.cap, entries);
    this.writeEntries(next);
  }

  replace(oldText: string, newContent: string): void {
    const entries = this.readEntries();
    const idx = this.findUniqueMatch(entries, oldText);
    const next = [...entries];
    next[idx] = newContent;
    const used = next.join(DELIMITER).length;
    if (used > this.cap) throw new MemoryCapExceeded(used, this.cap, entries);
    this.writeEntries(next);
  }

  remove(oldText: string): void {
    const entries = this.readEntries();
    const idx = this.findUniqueMatch(entries, oldText);
    const next = entries.filter((_, i) => i !== idx);
    this.writeEntries(next);
  }

  /** Pure read, no side effects: caller freezes this once per session. */
  snapshot(): string {
    const entries = this.readEntries();
    const body = entries.join(DELIMITER);
    const used = body.length;
    const pct = this.cap === 0 ? 0 : Math.round((used / this.cap) * 100);
    const header = `MEMORY (agent notes) [${pct}% -- ${used.toLocaleString('en-US')}/${this.cap.toLocaleString('en-US')} chars]`;
    return `${RULE}\n${header}\n${RULE}\n${body}`;
  }
}
