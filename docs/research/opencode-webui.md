# opencode web UI: design brief for Styx's console

Source: github.com/anomalyco/opencode, cloned shallow to /tmp/research-opencode. Paths below are
relative to that clone's `packages/` directory. License: MIT across every package inspected (root
LICENSE and every `packages/*/package.json`, copyright opencode 2025). No divergence found.

## 1. Monorepo map

Bun workspaces + Turborepo. Effect-TS is the backbone across server and client (schemas, HttpApi,
Streams). Relevant packages:

- `opencode/` core agent engine.
- `server/` HTTP server: Effect `HttpApi` handlers for session, message, permission, fs, command,
  skill, event, pty, question, agent, provider, model, credential.
- `protocol/` typed API surface shared by server and clients: `HttpApiGroup` definitions, the
  event schema, OpenAPI generation.
- `schema/` raw Effect Schema definitions, code-generated into SDKs. `sdk/`, `sdk-next/`,
  `client/` are the generated typed clients.
- `ui/` shared Solid design system: ~87 primitive components, icon sprites, theme engine, i18n
  (70+ locales).
- `session-ui/` shared session/timeline rendering (~31 components): message parts, markdown
  streaming, diffs, tool cards, a `pierre/` sub-module for virtualization.
- `app/` the real web/desktop console (Solid + Vite), live read-write UI against a running
  opencode server, also wrapped by `desktop/` (Electron). Has Playwright e2e plus a dedicated
  timeline-stability perf suite.
- `web/` Astro + Starlight marketing/docs site, plus one genuinely separate web UI: the read-only
  session share page at `web/src/pages/s/[id].astro`.
- `console/` SST-deployed account/billing dashboard (SolidStart, Kobalte, Stripe, chart.js). Not
  session UI, not relevant to Styx.
- `tui/` terminal UI, also Solid (via `@opentui/solid`). Solid is the house framework everywhere,
  not just the web app.
- `docs/` a second, separate docs system (Mintlify-flavored); ignore.

Two web surfaces worth studying: the full **app console** and the minimal **share page**. No React
Flow, dagre, d3-force, cytoscape, or vis-network anywhere in the tree (checked package.json and
source grep for "DAG"). opencode's timeline is strictly linear, there is no DAG-view prior art
here; Styx builds that view from scratch.

## 2. Web UI architecture

**Stack**: SolidJS everywhere (not React). Vite for `app`/`console/app`/`desktop`; Astro for
`web`. Styling is plain CSS custom properties plus one hand-written `.css` file per component
colocated with its `.tsx` (no Tailwind despite a `ui/src/styles/tailwind/` folder name, that
folder just holds hand-written `colors.css`/`utilities.css`; no CSS-in-JS). `ui/src/styles/
theme.css` holds base tokens as CSS variables; `packages/ui` supplies ~87 primitives each with a
Storybook story; `packages/session-ui` builds session-specific composites on top. Testing: Bun
test plus Playwright, with a dedicated `timeline-stability` e2e suite proving opencode explicitly
guards against live-stream-induced layout jank.

**API shape** (`protocol/src/api.ts`, `server/src/handlers/`): every domain is an Effect
`HttpApiGroup` of typed REST endpoints composed into one `HttpApi`, OpenAPI generated from the
same schema, auth/error middleware wraps the whole API once. One source of truth for request/
response shapes and generated clients, at the cost of buying into Effect. The event stream is its
own group: `GET /api/event` returns `HttpApiSchema.StreamSse(...)`, real SSE not websockets.
`EventSchema` is one big discriminated union covering every domain event (`session.text.delta`,
`session.tool.input.delta`, `permission.v2.asked`, `message.part.updated`, etc). Server side
(`server/src/handlers/event.ts`): a bounded stream (capacity 256), prefixed with a synthetic
`server.connected` event, merged with a 15-second heartbeat comment to stop proxies closing the
connection, headers set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` so
reverse proxies don't buffer it away. The share page instead uses a raw WebSocket to
`/share_poll?id=<id>`, applying `{key, content}` patches (`session/info`, `session/message/<id>`,
`session/part`) into a Solid store via `reconcile()`, no auth, retry after 2s on drop. Good model
for a minimal read-only viewer.

**Streaming / live event rendering** (`app/src/context/server-sdk.tsx`, the pattern that matters
most for Styx):

1. Connect once via `for await (const event of eventApi.event.subscribe(...))`.
2. Push each event into a small queue, don't apply to the store immediately.
3. **Coalesce by identity**: delta events for the same message/part/field concatenate their text
   fragments into one accumulated event; other duplicate-key events (e.g. `lsp.updated`) replace
   the previous queued instance instead of stacking. A streaming LLM emits hundreds of
   character-deltas per second; the UI only needs the latest accumulated state.
4. **Frame-batched flush**: at most every ~16ms, applied inside one Solid `batch()`, so a burst of
   50 deltas costs one render pass.
5. **Yield during ingestion**: if 8ms pass without yielding while draining the iterator, await a
   zero-length timeout so a hot burst can't freeze the tab.
6. **Reconnect**: generation counter, 250ms backoff, `pagehide`/`pageshow` listeners pause/resume
   around bfcache navigation.

Queue -> coalesce -> batch-flush is the single most valuable pattern to port for a
commitment-transition ticker: bursts of fleet-wide transitions should cost one re-render per
frame, not one per event.

**Timeline rendering** (`app/src/pages/session/timeline/`), the direct analog of Styx's ticker:

- Raw messages/parts are never rendered directly. They're projected into a flat list of small
  **typed row records** (`timeline-row.ts`): `TurnGap`, `CommentStrip`, `UserMessage`,
  `TurnDivider`, `AssistantPart`, `Thinking`, `Retry`, `DiffSummary`, `Error`, each a tagged class
  carrying only IDs, not payload.
- `rows.ts` is a pure function: `(messages, flags) -> Row[]`, deterministic, unit-tested in
  isolation. Consecutive same-type parts get grouped so five tool calls render as one visual
  group.
- Each row has a stable derived key for list reconciliation, so a streaming sibling doesn't remount
  unrelated rows.
- List rendering (`message-timeline.tsx`, ~1900 lines) owns virtualization, auto-scroll-while-
  pinned, and scroll anchoring, backed by a ref-counted per-scroll-container virtualizer
  (`pierre/virtualizer.ts`).
- Markdown/syntax highlighting runs in a Web Worker with a "latest wins per key" queue: superseded
  highlight requests for a still-streaming block are dropped, not queued.

Net pattern: **events -> pure projection into typed row records -> keyed virtualized list -> heavy
per-row work offloaded**. Exactly the shape a commitment ticker wants: transitions -> typed rows
(Proposed, Committed, Executing, Fulfilled, Broken, TimedOut) -> virtualized feed -> detail
deferred to an inspector panel.

**Headless server / read-only client**: the share page proves this already works. Astro SSR does
one `fetch` for a JSON snapshot (`${apiUrl}/share_data?id=${id}`), hands a Solid component
(`client:only="solid"`, no hydration mismatch risk) the initial snapshot plus a live WebSocket URL.
No auth token, just an opaque ID in the URL and a public read endpoint. Maps directly onto "console
runs against a headless Styx server": initial state fetch plus a subscribe endpoint, client
reconstructs the rest.

## 3. Design language (concrete enough to copy)

- **Color**: `ui/src/theme/` defines a `DesktopTheme` JSON per theme (37 shipped: catppuccin,
  dracula, nord, gruvbox, tokyonight, github, solarized, monokai, rose-pine, etc). Each theme
  supplies a tiny **seed palette** per light/dark: `neutral`, `ink`, `primary`, `accent`,
  `success`, `warning`, `error`, `info`, `diffAdd`, `diffDelete`, plus optional fine overrides
  (`text-weak`, `syntax-keyword`...). `ui/src/theme/resolve.ts` **algorithmically expands** those
  ~10 seeds into full 12-step Radix-style scales by converting to OKLCH and applying hue/
  lightness/chroma shifts; derived colors like `diffAdd` fall back to a shifted `success` if unset.
  Most reusable idea in the whole repo: define ~10 semantic seeds, generate the rest, never
  hand-author a 12-step ramp per color per theme. `colors.css` also carries alpha variants at every
  step (`--gray-dark-alpha-1..12`) for overlays/borders without a separate opacity system.
- **Typography**: system sans/mono as CSS fallback, shipped fonts are Inter (sans) and JetBrains
  Mono Nerd Font (mono, chosen for icon-ligature glyphs). Docs site separately uses IBM Plex Mono,
  a minor inconsistency, not worth copying. Fixed scale: 13/14/16/20px, line-height 130% to 200%,
  tight negative letter-spacing only at larger sizes.
- **Spacing/radius/shadow**: single `0.25rem` spacing unit, radii `0.125rem` to `0.625rem`, shadows
  use the `light-dark()` CSS function so one token works in both themes without an override block.
- **Dark mode**: not a runtime re-derive; the whole scale is generated once per theme (light/dark
  are two variants of one seed palette), `light-dark()` used natively where it fits.
- **Density/feel**: dense but not heavy. Grouped tool calls, diffs and long output collapsed by
  default (`Accordion`/`Collapsible`), monospace only where content demands it, sans everywhere
  else, `text-shimmer`/`animated-number`/`typewriter` micro-animations for live states instead of
  bare spinners.

## 4. What Styx's console should copy

**Copy directly:**

1. **Event pipeline**: queue -> coalesce-by-identity -> batch flush on an animation-frame cadence
   -> one state-store transaction. Coalesce by `commitmentID` (or `commitmentID:field`), flush
   every ~16ms.
2. **Row-projection pattern**: never render raw commitment events directly. Define a small closed
   set of tagged row types (`Proposed`, `Committed`, `Executing`, `Progressed`, `Fulfilled`,
   `Broken`, `TimedOut`, `Reverted`, plus structural rows like agent-group headers) via a pure
   `(events, state) -> Row[]` function, IDs only, stable derived key. Keeps the renderer dumb and
   the feed logic unit-testable, same as opencode's `rows.ts`.
3. **Seed-palette-plus-generated-scale theming**: ~8 to 10 semantic seeds (background/ink, primary,
   one color per commitment state), generate 12-step scales via OKLCH shift (port
   `ui/src/theme/color.ts`, ~300 lines, MIT). Gets accessible contrast and alpha variants for free
   in both themes from one config object.
4. **Read-only headless client shape**: initial REST snapshot plus a `GET /events` SSE stream that
   opens with a synthetic "connected" event and a heartbeat comment every 10 to 15 seconds.
5. **Offload heavy text rendering** (agent reasoning, payload previews) to a worker with a
   "latest wins per key" queue, not one request per delta.

**Ignore:**

1. Effect-TS `HttpApi` machinery, overkill for a handful of Styx endpoints; plain typed fetch (or
   a thin OpenAPI client) is enough.
2. The dual-protocol compat layer, that exists for opencode's legacy deployed servers. Styx has no
   such burden.
3. 37 bundled themes and 70+ locales, ship one dark theme and English only.
4. The full `ui` (87 components) and `session-ui` (31 components) libraries, most is irrelevant to
   a status board plus DAG plus ticker plus inspector. Pull in 8 to 12 primitives worth (button,
   tabs, tooltip, tag, scroll area, spinner), hand-roll the rest.
5. Electron wrapper, WSL/updater code, the billing console: none applies to a browser-only ops
   console.
6. No DAG/graph rendering exists to copy. React Flow plus dagre/elk for layout is a genuinely new
   build, not an adaptation.

**Build size estimate** (one page: DAG + inspector + status board + ticker, against an existing
Styx server):

- DAG view (React Flow, custom node/edge renderers, dagre/elk layout): 2 to 3 days.
- Live SSE ticker (coalesce/batch pipeline, row projection, virtualized list via e.g.
  `@tanstack/virtual`): 1.5 to 2 days.
- Inspector panel (detail view driven by DAG/ticker selection, tabs for payload/history/errors):
  1 day.
- Status board (aggregate counts/health, stat tiles plus one small chart): 0.5 to 1 day.
- Theme/token setup (seed palette, generated scale, base component styles): 1 day porting the
  OKLCH generator, half a day with a fixed hand-picked scale instead.
- Wiring: initial fetch, SSE reconnect, empty/error/loading states: 1 day.

Total: roughly 7 to 9 focused days for a first solid version, given an existing typed Styx HTTP/SSE
API. The event-pipeline and row-projection patterns are the highest-leverage things to port
carefully; the rest is conventional CRUD-and-render work.
