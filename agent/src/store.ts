// Per-agent SQLite session log with FTS5 search, via Node's built-in
// node:sqlite (Node 26 here ships SQLite with FTS5 compiled in already).
// ponytail: no better-sqlite3 fallback for pre-24 Node; add one there if this package ever needs to run on an older Node.

// Fetched via process.getBuiltinModule rather than a static `import` because
// this repo's pinned Vite/vite-node does not yet list "sqlite" among the
// node: builtins it externalizes, and would otherwise try (and fail) to
// resolve it as an npm package during transform.
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

export interface SearchResult {
  sessionId: string;
  messageId: number;
  role: string;
  content: string;
  snippet: string;
}

export interface RecentSession {
  id: string;
  source: string;
  startedAt: number;
  endedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  source TEXT NOT NULL,
  started_at REAL NOT NULL,
  ended_at REAL,
  end_reason TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp REAL NOT NULL,
  compacted INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

/**
 * FTS5's query syntax gives meaning to `:` (column filter), `*` (prefix),
 * `^` (initial-token), `-`/`"`/parens (NOT/phrase/grouping): a raw query
 * containing any of those (e.g. "claimed task:hotfix-42", a completely
 * ordinary note this package writes) throws a SQL logic error rather than
 * matching literally. Wrapping every whitespace-separated token in its own
 * quoted phrase sidesteps all of that -- each token is matched literally,
 * FTS5 ANDs the phrases together the same as an unquoted bare-word query
 * would -- at the cost of dropping real FTS5 operator support, which this
 * package's plain keyword/substring search never needed anyway (mirrors
 * Hermes' own _sanitize_fts5_query, see research/hermes.md 2b).
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

export class SessionStore {
  private readonly db: DatabaseSyncType;
  private readonly agentName: string;

  constructor(dbPath: string, agentName: string) {
    this.agentName = agentName;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // :memory: databases reject WAL; best-effort only, not fatal
    }
  }

  startSession(source: string): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO sessions (id, agent_name, source, started_at) VALUES (?, ?, ?, ?)')
      .run(id, this.agentName, source, Date.now() / 1000);
    return id;
  }

  appendMessage(sessionId: string, role: string, content: string): void {
    this.db
      .prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(sessionId, role, content, Date.now() / 1000);
  }

  endSession(sessionId: string, reason: string): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?')
      .run(Date.now() / 1000, reason, sessionId);
  }

  /** Compaction/session-end summaries are just searchable message rows, not a separate pipeline. */
  writeCompactionSummary(sessionId: string, summary: string): void {
    this.appendMessage(sessionId, 'summary', summary);
  }

  search(query: string, limit = 5): SearchResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT m.session_id AS sessionId, m.id AS messageId, m.role AS role, m.content AS content,
                snippet(messages_fts, 0, '**', '**', '...', 8) AS snippet
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{
        sessionId: string;
        messageId: number | bigint;
        role: string;
        content: string;
        snippet: string;
      }>;
    return rows.map((r) => ({
      sessionId: r.sessionId,
      messageId: Number(r.messageId),
      role: r.role,
      content: r.content,
      snippet: r.snippet,
    }));
  }

  recentSessions(limit = 10): RecentSession[] {
    const rows = this.db
      .prepare(
        `SELECT id, source, started_at AS startedAt, ended_at AS endedAt
         FROM sessions
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; source: string; startedAt: number; endedAt: number | null }>;
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
    }));
  }

  close(): void {
    this.db.close();
  }
}
