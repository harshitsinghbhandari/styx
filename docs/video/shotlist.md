# Styx demo video shotlist

Practical shot-by-shot guide for recording against `docs/video/script.md`.
Read `docs/v3-plan.md` ("The hackathon slice") and the four scene scripts
in `scripts/scenes/` before recording; this list assumes you already know
what each scene asserts.

## Setup before hitting record

- Local CockroachDB running:
  `docker run -d --name styx-crdb -p 26257:26257 -p 8080:8080 cockroachdb/cockroach:latest start-single-node --insecure`
- Schema applied once (the `record-scene*.sh` wrappers also do a full
  drop+recreate before each scene, so this is belt-and-suspenders):
  `psql postgresql://root@localhost:26257/defaultdb?sslmode=disable -c "CREATE DATABASE styx;"`
  then apply `kernel/src/db/schema.sql`, `kernel/src/db/precedents.sql`,
  `kernel/src/db/router.sql` against `postgresql://root@localhost:26257/styx?sslmode=disable`.
- Run each `scripts/demo/record-sceneN.sh` from the repo root once,
  off-camera, to confirm all four pass on your machine before you record
  for real. Nothing is worse than a live FAIL.

## Screen setup

- Recording resolution: 1920x1080. Record at this native size, do not
  scale up from something smaller; the terminal text and the console's
  DAG panel both need to survive YouTube's re-encode.
- Terminal font size: 18-20pt, a high-contrast dark theme (the default
  Styx console is dark, match it so cuts between terminal and browser
  don't flash bright). Full window width, no side panels open in the
  terminal app itself.

## Panes

One terminal pane, full screen, nothing split. Every scene script is a
single sequential stdout stream (even scene 1's "two workers claim at
once" happens inside one process, one log) so a second pane would only
add clutter, not information. Keep the terminal as the single source of
truth for what actually happened; it is where the PASS/FAIL assertions
print.

One browser window, at 1920x1080, for the cutaway shots described below.

## Browser: live URL vs local console dev server

Recommendation: use the **live public URL**
(http://styx-alb-2003374125.us-east-1.elb.amazonaws.com/) for every
browser shot, and do not stand up the local console dev server
(`cd ui && npm run dev`) during the take.

Reason: each scene script starts its own in-process kernel on an
ephemeral port and each `record-sceneN.sh` wrapper drops and recreates
the `styx` database before running, so there is no stable local URL a
browser could point at that would show the exact state a given scene
run just produced. Wiring a persistent local kernel + UI to sit in sync
with per-scene ephemeral kernels mid-recording is fragile and not worth
the risk for a hackathon take. The live URL is stable, already deployed,
needs no extra process babysitting, and is the same console judges will
open themselves. Browser shots are atmosphere and establishing shots
(the dark theme, the DAG panel, the ticker, the inspector, the BREAK
button), not a live mirror of the terminal's exact commitment IDs.

## Shot-by-shot

**0:00-0:15 Cold open**
- Black screen, type the two lines from script.md by hand or with a
  typing animation tool. No terminal, no browser yet.
- Cut to the Styx name card (same treatment: typed text on black).

**0:15-0:50 Scene 1: Conflict**
- Cut to terminal, full screen, sitting at the repo root.
- Run: `./scripts/demo/record-scene1.sh`
- Let the DB reset banner and pause play on screen briefly, then let the
  scene's own output scroll: both workers claiming, the winner/loser
  split, the `RESOURCE_CONFLICT` note, task:hotfix-43 picked up by the
  loser, and the closing `PASS: scene1-conflict`.
- Optional 2-3s cutaway to the live console's ticker mid-scene if you
  want a visual beat under the voiceover; not required, the terminal
  output alone carries the scene.

**0:50-1:25 Scene 2: Cascade**
- Terminal still full screen.
- Run: `./scripts/demo/record-scene2.sh`
- On screen: chain seeded (P-101 -> P-102 -> P-103), `break P-101`
  section header, then the `ok` lines for P-101 broken / P-102 at_risk /
  P-103 at_risk, then the "the relay woke both owners" section, then
  `PASS: scene2-cascade`.
- Cut to the live console's DAG panel for 3-5s right as the voiceover
  says "flags everything downstream" if you want the visual of the DAG
  nodes colored in; this is an atmosphere shot from the live deploy, not
  literally this run's data (see the URL note above).

**1:25-2:05 Scene 3: Repair**
- Terminal still full screen.
- Run: `./scripts/demo/record-scene3.sh`
- This wrapper runs the scene TWICE, back to back, with its own banner
  and pause in between. Recommendation: record both runs live, in one
  continuous take, rather than pre-seeding a precedent off-camera
  beforehand. Reasons: the wrapper already resets the whole local DB
  (including precedents) once at the start and then runs the scene
  twice unattended, so a single invocation is fully reproducible from a
  clean state every time, with no separate "did I remember to pre-seed"
  step to desync from the live take. The two runs together are fast
  (local single-node CRDB, no network calls in the repair reasoning
  step), so the live double-run costs only a few extra seconds of
  screen time, not a dead-air wait.
- On screen for run 1: "first run: no prior precedent yet".
- On screen for run 2: "ACCRETION: this looks like a second run, a prior
  precedent is already retrievable", then later "ACCRETION PROVEN: this
  run retrieved a precedent recorded by an earlier run".
- If the two full runs feel long in the edit, this is a fine place to
  speed up or trim the middle of run 1's output in post; keep the
  ACCRETION PROVEN line in run 2 untouched.

**2:05-2:35 Scene 4: Crash**
- Terminal still full screen.
- Run: `./scripts/demo/record-scene4.sh`
- This is the one beat to call out explicitly, since it is the most
  visually dramatic and the easiest to blink and miss:
  1. Section header: "mid-mission: a child process claims the task,
     then we kill -9 it."
  2. Line: "claim landed (task:crash-test is active)": the real child
     process has claimed the resource over HTTP.
  3. The kill itself has no announcement text (the script sends
     SIGKILL silently, in character with a real crash); what you will
     see on screen is the child process's log simply stop, followed
     immediately by the two `ok` lines confirming it was killed, not a
     clean exit, and that it had printed CLAIMED before dying.
  4. Section header: "a fresh process for the same identity discovers
     its obligations and resumes."
  5. Lines prefixed `child:` from the new process, then `FOUND ...`
     (it discovered the original commitment via getObligations) and
     `RESUMED 1 ...` (it re-claimed that same commitment, not a new
     one).
  6. Section header: "no duplicate commitments exist", then
     `PASS: scene4-crash`.
- No manual operator action needed anywhere in this scene; the kill
  happens inside the script itself. Do not cut away during this scene,
  the whole point is watching the crash and resume happen live in one
  unbroken terminal stream.

**2:35-2:50 Close**
- Cut to a prepared architecture slide (produced separately, not part
  of this kit), then a card with the live demo URL:
  http://styx-alb-2003374125.us-east-1.elb.amazonaws.com/
- Read the close line from script.md over the slide.
