import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore, MemoryCapExceeded } from '../src/memory.js';

function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'styx-agent-test-'));
}

describe('MemoryStore', () => {
  it('add then snapshot round-trips content and shows correct usage percentage', () => {
    const dir = scratchDir();
    const store = new MemoryStore(dir, 100);
    store.add('hello world');
    const snap = store.snapshot();
    expect(snap).toContain('hello world');
    // used = 'hello world'.length = 11, cap = 100 -> 11%
    expect(snap).toContain('[11% -- 11/100 chars]');
  });

  it('add of an exact duplicate is a silent no-op', () => {
    const dir = scratchDir();
    const store = new MemoryStore(dir, 100);
    store.add('same entry');
    const before = store.snapshot();
    store.add('same entry');
    const after = store.snapshot();
    expect(after).toBe(before);
    expect((after.match(/same entry/g) ?? []).length).toBe(1);
  });

  it('add exceeding the cap throws MemoryCapExceeded and leaves the file unchanged', () => {
    const dir = scratchDir();
    const store = new MemoryStore(dir, 20);
    store.add('12345'); // 5 chars, within cap
    const filePath = path.join(dir, 'MEMORY.md');
    const before = readFileSync(filePath, 'utf8');

    let thrown: unknown;
    try {
      store.add('this is definitely way too long to fit');
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(MemoryCapExceeded);
    const err = thrown as MemoryCapExceeded;
    expect(err.cap).toBe(20);
    expect(err.used).toBeGreaterThan(20);
    expect(err.entries).toEqual(['12345']);

    const after = readFileSync(filePath, 'utf8');
    expect(after).toBe(before);
  });

  it('replace with an ambiguous substring throws and leaves the file unchanged', () => {
    const dir = scratchDir();
    const store = new MemoryStore(dir, 1000);
    store.add('the quick fox');
    store.add('a quick rabbit');
    const filePath = path.join(dir, 'MEMORY.md');
    const before = readFileSync(filePath, 'utf8');

    expect(() => store.replace('quick', 'slow')).toThrow(/ambiguous/);

    const after = readFileSync(filePath, 'utf8');
    expect(after).toBe(before);
  });

  it('replace with a substring matching zero entries throws', () => {
    const dir = scratchDir();
    const store = new MemoryStore(dir, 1000);
    store.add('one entry here');
    expect(() => store.replace('nonexistent text', 'new')).toThrow(/no entry contains/);
  });

  it('replace with a unique substring match succeeds and snapshot reflects the new text', () => {
    const dir = scratchDir();
    const store = new MemoryStore(dir, 1000);
    store.add('the quick fox');
    store.add('a lazy dog');
    store.replace('quick fox', 'slow turtle');
    const snap = store.snapshot();
    expect(snap).toContain('slow turtle');
    expect(snap).not.toContain('the quick fox');
    expect(snap).toContain('a lazy dog');
  });

  it('remove with a unique substring match deletes that entry', () => {
    const dir = scratchDir();
    const store = new MemoryStore(dir, 1000);
    store.add('keep this one');
    store.add('delete this one');
    store.remove('delete this');
    const snap = store.snapshot();
    expect(snap).toContain('keep this one');
    expect(snap).not.toContain('delete this one');
  });

  it('a fresh MemoryStore pointed at the same directory sees entries written by a prior instance', () => {
    const dir = scratchDir();
    const store1 = new MemoryStore(dir, 1000);
    store1.add('persisted entry');

    const store2 = new MemoryStore(dir, 1000);
    const snap = store2.snapshot();
    expect(snap).toContain('persisted entry');
  });
});
