import { describe, it, expect } from 'vitest';
import { SessionStore } from '../src/store.js';

describe('SessionStore', () => {
  it('finds an appended message by a keyword contained in its content', () => {
    const store = new SessionStore(':memory:', 'test-agent');
    const sessionId = store.startSession('cli');
    store.appendMessage(sessionId, 'user', 'please refactor the parser module');
    store.appendMessage(sessionId, 'assistant', 'sure, starting on the parser now');

    const results = store.search('parser');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe(sessionId);
    expect(results.some((r) => r.content.includes('refactor the parser'))).toBe(true);

    store.close();
  });

  it('a query containing FTS5 operator characters (: * ^ - " ()) is treated as literal text, not syntax', () => {
    const store = new SessionStore(':memory:', 'test-agent');
    const sessionId = store.startSession('cli');
    store.appendMessage(sessionId, 'note', 'claimed task:hotfix-42 (commitment abc-123)');
    store.appendMessage(sessionId, 'note', 'unrelated message about widgets');

    const results = store.search('claimed task:hotfix-42');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('task:hotfix-42');

    // each of these used to throw "no such column" / a SQL logic error before sanitization
    expect(() => store.search('a "quoted" phrase')).not.toThrow();
    expect(() => store.search('prefix* search')).not.toThrow();
    expect(() => store.search('^initial token')).not.toThrow();
    expect(() => store.search('(parens) here')).not.toThrow();
    expect(() => store.search('a-hyphenated-word')).not.toThrow();

    store.close();
  });

  it('a query matching nothing returns an empty array', () => {
    const store = new SessionStore(':memory:', 'test-agent');
    const sessionId = store.startSession('cli');
    store.appendMessage(sessionId, 'user', 'hello there');

    expect(store.search('zzzznomatchzzzz')).toEqual([]);
    expect(store.search('')).toEqual([]);
    expect(store.search('   ')).toEqual([]);

    store.close();
  });

  it('search is cross-session: messages in a different session are still found', () => {
    const store = new SessionStore(':memory:', 'test-agent');
    const sessionA = store.startSession('cli');
    const sessionB = store.startSession('discord');
    store.appendMessage(sessionA, 'user', 'talking about elephants');
    store.appendMessage(sessionB, 'user', 'talking about giraffes');

    const results = store.search('giraffes');
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBe(sessionB);

    store.close();
  });

  it('writeCompactionSummary writes a row that search can find', () => {
    const store = new SessionStore(':memory:', 'test-agent');
    const sessionId = store.startSession('cli');
    store.writeCompactionSummary(sessionId, 'session summary: migrated the auth layer to tokens');

    const results = store.search('auth layer');
    expect(results.length).toBe(1);
    expect(results[0].role).toBe('summary');
    expect(results[0].content).toContain('migrated the auth layer');

    store.close();
  });

  it('endSession sets ended_at and end_reason, visible via recentSessions', () => {
    const store = new SessionStore(':memory:', 'test-agent');
    const sessionId = store.startSession('cli');
    store.endSession(sessionId, 'user_exit');

    const recent = store.recentSessions();
    const found = recent.find((s) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.endedAt).not.toBeNull();
    expect(typeof found!.endedAt).toBe('number');

    store.close();
  });

  it('recentSessions returns sessions most-recent-first', async () => {
    const store = new SessionStore(':memory:', 'test-agent');
    const first = store.startSession('cli');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.startSession('discord');

    const recent = store.recentSessions();
    expect(recent[0].id).toBe(second);
    expect(recent[1].id).toBe(first);

    store.close();
  });
});
