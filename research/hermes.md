# Hermes Agent: design brief for a stripped TypeScript clone

Source: github.com/NousResearch/hermes-agent, cloned shallow to /tmp/research-hermes.
License: MIT, Copyright 2025 Nous Research. No attribution/copyleft obligation for a
design-only reimplementation, we are not vendoring their code.

## 1. Stack and repo layout

Large, mature, mostly-Python monorepo (Python 3.11, uv-managed) with TypeScript frontends.
Not a small project: `cli.py` is 859KB, `hermes_state.py` (DB layer) is 508KB, ~25,000 tests.

- `run_agent.py` / `agent/`: core `AIAgent` class and conversation loop.
- `hermes_state*.py`: SQLite session/message store, FTS5 search, schema, migrations.
- `tools/`: one file per tool, self-registered into a central registry.
- `plugins/memory/`: pluggable external memory providers (Honcho, Mem0, etc).
- `cron/`: scheduler. `gateway/`, `plugins/platforms/`: messaging adapters.
- `skills/`, `optional-skills/`: bundled agentskills.io-format skill library.
- `ui-tui/` (TS terminal UI), `web/` (TS chat + admin SPA), `apps/desktop/` (Electron shell).
- `website/`: Docusaurus docs site, not a product surface.

## 2. Memory and storage layer (priority)

Three overlapping systems the README compresses into one sentence. Separated below.

### 2a. Session storage (message log)

Every turn (CLI/gateway/cron/subagent) persists to one shared SQLite DB, `~/.hermes/state.db`
(one DB per Hermes profile, not per session). WAL mode by default (`database.journal_mode`),
with automatic fallback to `DELETE` journal mode on filesystems that reject WAL (network
mounts). On macOS, `PRAGMA synchronous=FULL` + `checkpoint_fullfsync=1` are forced, because
macOS's `synchronous=NORMAL` default doesn't actually `fsync()` and has caused btree
corruption in the wild. Source: `hermes_state.py` (`SessionDB`), schema (`SCHEMA_SQL`) in
`hermes_state_common.py:197-374`, current `SCHEMA_VERSION = 25`.

```sql
CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);
-- prompts de-duplicated by hash, referenced from sessions.system_prompt_hash, GC'd when unreferenced

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                 -- format YYYYMMDD_HHMMSS_<hex>
    source TEXT NOT NULL,                -- 'cli'|'telegram'|'cron'|'subagent'...
    user_id TEXT, model TEXT, system_prompt_hash TEXT,
    parent_session_id TEXT,              -- lineage: compression splits, branches, delegates
    started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
    message_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0, title TEXT, title_source TEXT,  -- title unique among non-NULL
    cwd TEXT, git_branch TEXT, git_repo_root TEXT,     -- workspace scoping
    archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id),
    FOREIGN KEY (system_prompt_hash) REFERENCES system_prompts(hash)
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT,  -- JSON string
    tool_name TEXT, timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT,
    reasoning TEXT,
    active INTEGER NOT NULL DEFAULT 1,   -- 0 = archived (compaction/rewind/undo)
    compacted INTEGER NOT NULL DEFAULT 0,-- 1 = "summarized away" but still FTS-searchable
    api_content TEXT   -- byte-fidelity sidecar for wire content when it differs from `content`
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content, tool_name, tool_calls, content='messages', content_rowid='id'
);
```

Additive columns are reconciled declaratively at startup (`_reconcile_columns()` diffs live
columns against `SCHEMA_SQL`, `ALTER TABLE ADD COLUMN`s the gap), only structural changes get a
version-gated migration path. `session_model_usage` (per-model/task cost attribution),
`state_meta` (generic KV, FTS rebuild markers), `gateway_routing`, `compression_locks`,
`async_delegations` exist too but are not needed for a stripped clone.

FTS5 kept in sync via three triggers (insert/update/delete) on `messages`, external-content
mode. CJK/trigram tokenizer variants exist too (a custom loadable extension re-emits CJK runs
as overlapping bigrams, and the trigram index excludes `role='tool'` rows since tool output is
mostly noise for substring search), skip both unless CJK/substring search matters.

Write path: `append_message()` does one INSERT + a `sessions` counter UPDATE inside
`BEGIN IMMEDIATE` (acquires the WAL write lock at transaction start rather than lazily, to
avoid a deadlock class; fails fast on contention instead of blocking). App-level retry: 15
attempts, jittered backoff 20-150ms, widening to 250ms-1s after 2s of sustained contention.
Per-connection SQLite `busy_timeout` is a short 1s, deliberately shorter than SQLite's 30s
default, since the app-level jittered retry is the real contention handler (SQLite's own
deterministic backoff produces convoy effects when several processes share one file). WAL
checkpoint (PASSIVE) every 50 successful writes; a bounded FTS5 `'merge'` (not `'optimize'`,
which was seen holding the write lock 9-18s on a 10GB DB) every 1000 writes. Compaction
(`archive_and_compact`, see 2f) is not a simple append: in one transaction it flips currently
active rows to `active=0, compacted=1` and inserts the new compacted rows as fresh `active=1`
rows, archived rows stay on disk and in the FTS index, just excluded from what's replayed to
the model.

Directly portable to `better-sqlite3`/`node:sqlite`: one `sessions` + one `messages` table +
FTS5 virtual table with triggers. Worth copying the retry/jitter/checkpoint numbers verbatim
if multiple Styx agents share one DB file. The `active`/`compacted` soft-delete pair (rather
than deleting rows) is worth copying too, it's what keeps compacted history searchable.

### 2b. FTS5 session search tool (cross-session recall, no LLM)

Exposed as `session_search` (`tools/session_search_tool.py`). Its own docstring contradicts the
README: "no LLM calls anywhere, every shape returns actual messages from the DB." Signature:
`session_search(query="", role_filter=None, limit=3, session_id=None, around_message_id=None,
window=5, sort=None)`, shape inferred from which args are present, no explicit mode flag:

1. **discovery** (`query`): FTS5 MATCH, deduped by session lineage, top-N (clamped 1-10)
   sessions each with a highlighted snippet, a +/-5 message window, and "bookends" (first/last
   3 messages). Automation sessions (`source in kanban|subagent|tool`) hidden entirely; cron
   sessions demoted in ranking (not excluded) so recurring cron chatter can't drown out
   interactive sessions under bare BM25.
2. **scroll** (`session_id` + `around_message_id`): +/-`window` slice, no FTS, re-anchor on the
   returned edge id to page forward/backward.
3. **read** (`session_id` alone, no anchor): dumps the whole session.
4. **browse** (no args): recent sessions chronologically, titles + previews.

Query text is sanitized before hitting FTS5 (`_sanitize_fts5_query`): strips unmatched quotes,
quotes hyphenated terms, drops dangling boolean operators, caps input at 2048 chars.

The README's "LLM summarization" is real but lives elsewhere, its *output* just becomes
searchable because it's stored as an ordinary message row:
- **Compaction summaries** (`agent/context_compressor.py`): compacting a session writes a
  `[CONTEXT COMPACTION]` LLM-generated block into `messages`, inheriting FTS5 searchability.
- **Session titles** (`agent/title_generator.py`): instant zero-cost derived title, later
  upgraded by one cheap-tier LLM call. Provenance-ordered (`derived < llm < user`, never
  overwrites a user-typed title).

Clone takeaway: build discovery/scroll/browse as a pure DB query layer, zero LLM cost. When
compacting, write the summary as a normal message row, don't build a separate summarization
pipeline (Hermes explicitly deprecated an earlier version of that).

### 2c. Built-in curated memory (MEMORY.md / USER.md)

This is the actual "reinforcement nudge" system. File-based, not a DB table. Source:
`tools/memory_tool.py` (`MemoryStore`), glue in `agent/memory_manager.py`.

Two flat files under `~/.hermes/memories/`: `MEMORY.md` (agent's notes, 2200 char cap, ~800
tok) and `USER.md` (user profile, 1375 char cap, ~500 tok). Entries joined by a literal
delimiter, `ENTRY_DELIMITER = "\n§\n"`, no JSON, no frontmatter.

Tool surface (`memory`, three actions, no `read`):
- `add(target, content)`: exact duplicates rejected with a "no duplicate added" success.
- `replace(target, old_text, content)` / `remove(target, old_text)`: `old_text` is a short
  unique **substring** match, not a full-text key; ambiguous matches error out.

Every write scanned by `tools/threat_patterns.py` (prompt-injection, credential exfil,
invisible unicode) before acceptance, since content goes straight into the system prompt. A
second, independent scan runs at snapshot-build time (session start): a hit replaces that
entry's text with a `[BLOCKED: ...]` placeholder in the *rendered snapshot only*, the on-disk
entry is left untouched so the user can see and remove it via the memory tool.

No auto-compaction: a write exceeding the cap is **rejected**, not truncated. Error response
includes current usage and all current entries, instructing the model to consolidate (merge
via `replace`, drop via `remove`) and retry in the same turn. Bounded store, hard rejection
with self-service repair, never silent data loss, worth copying directly.

**Context injection** ("frozen snapshot," `agent/system_prompt.py`): memory is read from disk
and rendered into the system prompt **once, at session start**, as a fenced block with a
usage-percentage header:

```
======================================
MEMORY (your personal notes) [67% -- 1,474/2,200 chars]
======================================
User's project is a Rust web service at ~/code/myapi using Axum + SQLx
§
This machine runs Ubuntu 22.04, has Docker and Podman installed
```

Not refreshed mid-session, this preserves the provider's prompt-cache prefix. Writes during
the session hit disk immediately (visible next session, and in the tool's own response) but
don't appear in the live prompt until restart. **Single highest-value pattern to copy: inject
memory once per session as a static block, never live-refresh it.**

### 2d. Reinforcement nudges (exact trigger and mechanism)

Config: `memory.nudge_interval` (default **10**), `skills.creation_nudge_interval` (default
**10**, independent counter). Set in `agent/agent_init.py`. `agent._turns_since_memory`
increments once per completed **user** turn (`agent/turn_context.py`); at the interval,
`should_review_memory = True` and the counter resets. A separate per-tool-iteration counter
drives the skill-side nudge (`agent/codex_runtime.py`).

A "nudge" is not a message the user sees, it's a **background daemon-thread fork of the whole
agent**. `agent/turn_finalizer.py` checks the flags and calls
`agent._spawn_background_review(...)` (`agent/background_review.py`): forks a new `AIAgent` on
the parent's runtime (same model by default, reuses the warm prompt cache; can route to a
cheaper model via `auxiliary.background_review.*`, replaying a compact digest instead since a
different model can't share the cache). Fork's tool whitelist is hard-restricted to
memory/skill tools, denied everything else at runtime, and gets a fixed review prompt as a
user message. Memory prompt, paraphrased in full:

> "Review the conversation above and consider saving to memory if appropriate. Focus on: (1)
> has the user revealed things about themselves worth remembering, (2) expectations about how
> you should behave or work style. If something stands out, save it using the memory tool. If
> nothing is worth saving, say 'Nothing to save.' and stop."

Fork runs the normal conversation loop, may write directly (or stage to a pending-approval
queue if `memory.write_approval: true`); the main conversation and its prompt cache are never
touched. Two extra safety flags on the fork worth copying: `_persist_disabled = True` (the
fork's own harness turn never gets written into the live session, fixing a real prior bug
where the review's injected instruction got replayed as a standing instruction in the user's
actual session) and `compression_enabled = False` plus its own nudge counters zeroed (so the
review can't recursively trigger reviews). A one-line chat notification tells the user
something happened.

Clone takeaway: turn counter, fixed interval, on trigger fork a scoped background call with a
fixed nudge prompt and restricted tool access, writes land directly, fork never persists its
own turn into the real session. No cron, no separate process, fires inline off the counter.

Note: Hermes also has a separate, larger **Curator** (`agent/curator.py`) that is not this
per-turn nudge, it's an hours-cadence sweep (default weekly, inactivity-gated) over the whole
skill library for archival/consolidation. It reuses the same "forked review agent, restricted
tools" pattern but is a distinct, lower-frequency system, not needed for an MVP clone.

### 2e. Honcho (external "dialectic" user modeling, optional)

One of eight pluggable external memory providers (`plugins/memory/honcho/`), only one active
at a time, off by default. Honcho models a conversation as **peers** (one user peer, one AI
peer) in a shared workspace; a "dialectic" query is `peer.chat(query)`, a multi-pass LLM call
run on Honcho's own backend against that peer's accumulated representation, not a direct DB
read. Two injection layers, each on its own cadence, joined into the **user message** (not
system prompt, preserves caching): base context (session summary + user representation + peer
card, retrieval only, refreshed every `contextCadence` turns) and a dialectic supplement (1-3
chained `.chat()` passes, `dialecticDepth`, with an early-exit once a pass returns a
"sufficient" signal, i.e. >100 chars structured or >300 chars plain). Exact per-pass prompts:
pass 0 cold-start (no cached base context yet): *"Who is this person? What are their
preferences, goals, and working style? Focus on facts that would help an AI assistant be
immediately useful."*; pass 0 warm (base context exists): *"Given what's been discussed in
this session so far, what context about this user is most relevant to the current
conversation? Prioritize active context over biographical facts."*; pass 1 self-audit feeds
the prior answer back and asks what gaps remain; pass 2 reconciles both prior passes into a
final synthesis. Five tools also exposed directly (`honcho_profile`, `honcho_search`,
`honcho_context`, `honcho_reasoning`, `honcho_conclude`).

Not worth reimplementing, hosted third-party product. Transferable idea: **two-layer,
two-cadence injection into the user message** for anything that needs live per-turn context
without busting the system-prompt cache, could apply to commitment-kernel state in Styx.

### 2f. Retention / compaction policy

`agent/context_compressor.py` (`ContextCompressor`, 7386 lines; base ABC `ContextEngine` in
`agent/context_engine.py`). Two independent, interoperating layers:

**Batch compaction** (always on, the baseline): fires at `threshold_percent=0.50` of the
model's effective context window (85% for gateway auto-compression between turns), with
`protect_first_n=3` head messages and `protect_last_n=20` tail messages always kept verbatim.
Anti-thrashing: skip if the last two compressions each freed <10% of tokens, or under a
cooldown after a compression-call failure (429/5xx), to avoid retry storms. On fire: memory is
flushed to disk first, the unprotected middle (never splitting a tool call/result pair) is sent
to an auxiliary model with a structured, credential-redacting summarization prompt (explicit
instruction: *"NEVER include API keys, tokens, passwords, secrets, credentials, or connection
strings in the summary, replace any that appear with [REDACTED]"*), producing sections like
`## Historical Task`, `## Completed Actions`. Persisted via the `active=0,compacted=1` /
new-rows-inserted pattern from 2a, atomically. Optionally rotates to a new `parent_session_id`
lineage child.

**Micro-compaction** (opt-in, `compression.micro_compact: true`, default off): runs after
every N completed turns (`micro_compact_every_n_turns`, default 1), absorbing exactly one
exchange (one assistant turn + its tool results) into a single rolling cumulative summary.
User messages are never absorbed. When the rolling summary itself exceeds a token threshold
(default 2000), the next pass re-summarizes the summary instead of absorbing new content
("defrag"). Explicitly documented tradeoff: every pass rewrites already-sent history, breaking
the provider's prompt-cache prefix on every turn it fires, "a trade of one cost for another,
not a saving," which is why it defaults off. Skip this for a clone, the plain threshold-based
batch compaction above is the right default.

**Rewind is not compaction**: `/undo` soft-deletes rows too, but as `active=0, compacted=0`
(distinct from compaction's `compacted=1`), so rewound content stays hidden from
`session_search` (user "took it back") whereas compacted content stays discoverable there.
Worth copying this active/compacted 2-bit distinction if Styx wants both an undo and a
compaction path that behave differently under search.

Clone takeaway: token-threshold trigger, keep-first-3/last-20-verbatim, protect tool
call/result pairs, flush memory before compacting, one redaction-aware LLM summary for the
middle. Skip session lineage/rotation (compact in place) and skip micro-compaction (cache-hostile,
opt-in even in Hermes). If Styx wants both undo and compaction, give them distinct soft-delete
flags so they behave differently under search.

## 3. Agent loop and subagents (medium depth)

Core loop: `agent/conversation_loop.py`'s `run_conversation()`, one function shared by CLI,
gateway, cron, ACP, and subagents. Per turn:

1. Build/restore cached system prompt, preflight-compress if over threshold.
2. Loop while budget remains: call the provider; if tool calls present, validate/repair names,
   execute (single call inline; multiple calls split into parallel-safe "segments", read-only
   or non-overlapping-file tools run concurrently via thread pool, interactive/unsafe tools
   force a sequential barrier), append `role: "tool"` results, loop again.
3. No tool calls in the response is the terminal path, break. Also terminates on interrupt,
   budget exhaustion, or a guardrail halt.

Tool dispatch: tools self-register into a central `ToolRegistry` (name, schema, handler,
availability check) at import time. One choke point (`invoke_tool()`/`handle_function_call()`)
applies plugin hooks, coerces args to schema, dispatches, normalizes any exception into a
`{"error": ...}` result rather than crashing the turn. A few tools (`memory`, `session_search`,
`delegate_task`, `todo`) are intercepted before the registry since they mutate agent state
directly.

Subagents (`delegate_task` tool): spawns **new `AIAgent` instances in the same process**, not
new OS processes, run on a daemon thread pool, joined before `delegate_task` returns (or, for
backgrounded top-level delegations, results re-enter the parent conversation later as a
synthesized message off a completion queue). Child gets a fresh conversation (its goal as the
only message, independent iteration budget, default cap 50) but inherits credentials,
toolsets (strict subset, never a superset), and by default the parent's working
directory/shell container (a subagent's `cd` doesn't leak back). Filesystem isolation is
opt-in: `delegation.worktree_isolation` checks out a dedicated git worktree per child, pruned
after if clean and zero commits. Delegation depth capped (`role: leaf` cannot delegate
further, `role: orchestrator` can, up to `max_spawn_depth`, default 2).

Cron: jobs in `~/.hermes/cron/jobs.json` (atomic write, cross-process file lock). Pluggable
trigger (default in-process 60s tick loop) decides *when*; execution is always the same
`run_job()`: fresh `AIAgent`, **no conversation history**, unconditionally disables
`cronjob`/`messaging`/`clarify`/`memory` toolsets on it (recursion guard), optionally loads
attached skills as prepended context, runs the job prompt through the normal loop, delivers
the final text to a platform target. Budget is an *inactivity* timeout (default 600s idle, not
wall-clock), a long tool-calling job can run for hours if it keeps making progress.

## 4. Skills (medium depth)

Format: directory per skill, `SKILL.md` (YAML frontmatter: name, description, version,
platforms, a `metadata.hermes` tags/related-skills namespace) plus a fixed markdown section
order, optional `references/`, `templates/`, `scripts/` subdirs. House style layered on the
generic agentskills.io manifest convention.

Storage: `~/.hermes/skills/` is the single source of truth (bundled skills copied in on
install, hub-installed and agent-created skills land here too). Optional heavier catalog under
`optional-skills/`. Arbitrary `skills.external_dirs` scanned alongside, local shadows external
on name collision.

Loading is three-level progressive disclosure: compact `skills_list` index (name + one-liner)
always in the system prompt; `skill_view(name)` loads the full SKILL.md only when relevant;
`skill_view(name, file_path)` loads one support file on demand. Skills also work as slash
commands injecting SKILL.md as a fresh user message (not a system-prompt mutation, cache
survives).

Autonomous creation: two paths. `/learn` is a user-triggered prompt-construction helper, not a
tool, hands the live agent an authoring-standards instruction, lets it gather material with
existing tools, saves via `skill_manage`. The real self-improving loop is the **same
background-review fork from 2d**: on the skill-nudge trigger (or a combined prompt if both
fire), the fork gets told (paraphrased): "Update the skill library. Be ACTIVE, most sessions
should produce at least one update. Prefer patching a loaded or existing class-level skill
over creating a narrow new one. Protected skills (bundled, hub-installed, pinned, user-owned)
are off-limits." Writes are provenance-tagged (`created_by: "agent"`) so a separate
slow-cadence Curator (weekly, inactivity-triggered, no cron involved) can later auto-archive
stale agent-created skills (30 days unused -> stale, 90 -> archived, never auto-deleted)
without touching anything a human wrote.

## 5. MCP wiring (short)

Config under `mcp_servers:` in `config.yaml`: stdio servers get `command`/`args`/`env`, HTTP
servers get `url`/`headers` (OAuth 2.1+PKCE, mTLS, per-server tool include/exclude globs,
idle/lifetime process recycling for stdio). Every MCP tool registers into the same central
registry as native tools, namespaced `mcp__<server>__<tool>`, indistinguishable to the model
from a built-in. Hermes also runs the reverse direction: `hermes mcp serve` exposes its own
messaging gateway as a 10-tool stdio MCP server, so another MCP client can drive Hermes as a
channel.

## 6. Web UI

Yes, real: `web/` is a Vite + React 19 + TS SPA, served by a FastAPI backend
(`hermes_cli/web_server.py`) on port 9119 via `hermes dashboard`. Not just a settings panel,
`web/src/pages/` includes a full chat page plus sessions, skills, MCP, cron, models, channels,
plugins, config, and analytics pages, a genuine standalone admin + chat client.
`apps/desktop/` is an Electron shell around the same frontend/backend, not a separate
implementation. `website/` is documentation only.

## 7. Stripped TS agent for Styx

Goal: a fleet of coding agents, each with private cross-session memory, a skills dir, MCP
client access, and HTTP tools for the Styx commitment kernel.

**Copy near-verbatim:**
- SQLite `sessions` + `messages` + `messages_fts` (FTS5, triggers, WAL). Whole storage layer,
  directly portable to `better-sqlite3`/`node:sqlite`.
- The three-shape FTS5 search tool (discovery/scroll/browse), zero LLM cost.
- MEMORY.md-style bounded flat-file memory: delimiter-joined file(s), hard char cap,
  reject-and-instruct-to-consolidate on overflow, threat-pattern scan before write,
  frozen-snapshot injection once per session start (the single highest-value pattern here).
- The reinforcement nudge: per-turn counter, fixed interval (start at 10), on trigger a scoped
  background call (an async task is enough in Node, no real thread fork needed) with a fixed
  review prompt and a tool whitelist limited to memory/skill writes, direct writes to disk.
- Skill format: directory + `SKILL.md` (frontmatter + fixed sections) + support subdirs,
  three-level progressive disclosure.
- Compaction: token threshold trigger, protect-last-N verbatim, never split a tool
  call/result pair, flush memory first, one LLM-summary message replacing the middle, stored
  as a normal row so it's searchable for free.
- MCP tool merging under a namespaced `mcp__<server>__<tool>` name, per-server
  include/exclude filters.

**Drop entirely:** Honcho and the other external memory providers (hosted third-party
products); session lineage/parent chains; CJK/trigram FTS variants; multi-platform gateway;
cron scheduler complexity (webhook-armed scale-to-zero, script-backed jobs); the Curator's
separate slow-cadence archival pass; worktree isolation for subagents (useful later, not MVP);
the three-API-mode provider abstraction; the desktop Electron app and admin web dashboard; the
multi-level skill-write-approval/staging system (write freely first, add an approval gate only
if Styx's trust model needs it).

**HTTP tools for the commitment kernel:** no direct Hermes analog (it's mostly local-tool
oriented), but its MCP tool-wrapping pattern is the right template: define each Styx kernel
endpoint as a tool with a JSON schema, register it identically to a native tool (name, schema,
handler, availability check), let the model call it like any other tool. No separate "HTTP
tool" abstraction needed beyond that.

**Estimated build size:** storage layer (schema + FTS + write-retry logic) ~1 day, memory
store (flat-file + nudge fork) ~1 day, skills loader (directory scan + three-level disclosure)
~0.5 day, MCP client wiring (spawn stdio/connect HTTP, merge tool list) ~0.5-1 day depending on
how much of the MCP TS SDK is reused. Commitment-kernel HTTP tools are bespoke to Styx, not
estimated here. Roughly 3-4 focused days for everything in the copy list, excluding the core
agent loop (model call, tool dispatch, retry) which Styx presumably has or is building
separately.
