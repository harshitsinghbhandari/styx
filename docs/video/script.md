# Styx demo video script

Adapted from `docs/v1-spec.md` section 16 for the system actually built (see
`docs/v3-plan.md`, "The hackathon slice"): a coding-agent fleet on a shared
backlog, not the original GPU marketplace. Target runtime: 2:50, under the
3:00 hackathon limit. Spoken pace assumed ~150 words per minute.

Live demo URL (show it at least once, cold open or close):
http://styx-alb-2003374125.us-east-1.elb.amazonaws.com/

Fixture used throughout: resources `task:<id>` (capacity 1 each),
`deploy-slot` (capacity 1), `ci-runner` (capacity 2). Promise chain
P-101 (schema migration) -> P-102 (API endpoints) -> P-103 (frontend
wiring).

---

## 0:00-0:15: Cold open

Black screen. One line typed out, no voiceover yet:

> "Everyone is building agents that remember the past.
> We built agents that remember the future."

Cut to the Styx name card, also typed:

> "An oath sworn on the Styx bound even the gods."

---

## 0:15-0:50: Scene 1: Conflict (35s)

ON SCREEN: terminal, `scripts/scenes/scene1-conflict.ts` running. Two
worker agents (`alice-worker`, `bob-worker`) both fire a claim on the same
backlog task, `task:hotfix-42`, over the real HTTP API, at the same
moment.

VOICEOVER:
"Two workers in the same coding-agent fleet go for the same backlog task
at once. One serializable transaction wins: task:hotfix-42 goes active.
The other doesn't get a crash, it gets a typed ResourceConflict, and
takes the next task on the list instead. This is CockroachDB's default
isolation doing product work."

---

## 0:50-1:25: Scene 2: Cascade (35s)

ON SCREEN: terminal, `scripts/scenes/scene2-cascade.ts` running (or a cut
to the console's DAG panel showing P-101 -> P-102 -> P-103). BREAK is
called on P-101, the schema migration.

VOICEOVER:
"Break the schema migration, P-101. One transaction walks the dependency
graph and flags everything downstream, at_risk, in the same commit that
broke P-101: the API endpoints, the frontend wiring. No separate job
queued after the fact. The owners of P-102 and P-103 wake up already
knowing."

---

## 1:25-2:05: Scene 3: Repair (40s)

ON SCREEN: terminal, `scripts/scenes/scene3-repair.ts` running twice
back to back (see `docs/video/shotlist.md` for the exact framing).

VOICEOVER:
"P-102's owner wakes on the at_risk event, searches precedents, a table
of past repairs held as vectors in CockroachDB, and finds one that
matches. It proposes a replacement commitment, links it in, and the
graph rewires around the damage. P-101 stays broken. Repair does not undo
the past, it routes around it. Run it again, and the fleet finds the
precedent it just made for itself."

---

## 2:05-2:35: Scene 4: Crash (30s)

ON SCREEN: terminal, `scripts/scenes/scene4-crash.ts` running. A real
child process claims `task:crash-test`, then the script `kill -9`'s it
mid-mission. A fresh process for the same agent identity comes up right
after.

VOICEOVER:
"A worker claims a task. Mid-mission, we kill -9 it. It's gone. A fresh
process for the same agent identity asks the kernel what it's still on
the hook for, and resumes the exact same commitment. Not a duplicate,
the same one. Agents may die. Commitments survive."

---

## 2:35-2:50: Close (15s)

ON SCREEN: architecture slide, then the live demo URL card
(http://styx-alb-2003374125.us-east-1.elb.amazonaws.com/).

VOICEOVER:
"Agents reason freely. They mutate committed state only through Styx's
invariant-enforcing kernel. Promises they cannot accidentally break."

---

Total: 2:50 (170s of scripted beats), 10s under the 3:00 cap.
