#!/usr/bin/env bash
# Resets local CockroachDB and runs Scene 3 (Repair) TWICE back to back, to
# prove precedent accretion live: the second run must retrieve the
# precedent the first run recorded. Only one DB reset happens here, up
# front, covering every table including precedents; the scene script's own
# resetDb(keepPrecedents: true) call governs the gap between the two runs.
# See docs/video/shotlist.md for the recording recommendation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_URL="postgresql://root@localhost:26257/styx?sslmode=disable"
ADMIN_URL="postgresql://root@localhost:26257/defaultdb?sslmode=disable"

echo "=== STYX DEMO: Scene 3 - Repair ==="
sleep 2

echo "--- resetting local schema (covers precedents too; only reset in this script) ---"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS styx;" -c "CREATE DATABASE styx;" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/schema.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/precedents.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/router.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "SET CLUSTER SETTING kv.rangefeed.enabled = true;" >/dev/null

cd "$ROOT"

echo "--- run 1 of 2: no prior precedent yet ---"
sleep 2
DATABASE_URL="$DB_URL" npx tsx scripts/scenes/scene3-repair.ts

echo "--- run 2 of 2: accretion proof (should retrieve run 1's precedent) ---"
sleep 2
DATABASE_URL="$DB_URL" npx tsx scripts/scenes/scene3-repair.ts

echo "=== STYX DEMO: Scene 3 complete ==="
