#!/usr/bin/env bash
# Resets local CockroachDB and runs Scene 1 (Conflict) for recording.
# See docs/video/shotlist.md for when to run this during the take.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_URL="postgresql://root@localhost:26257/styx?sslmode=disable"
ADMIN_URL="postgresql://root@localhost:26257/defaultdb?sslmode=disable"

echo "=== STYX DEMO: Scene 1 - Conflict ==="
sleep 2

echo "--- resetting local schema ---"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS styx;" -c "CREATE DATABASE styx;" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/schema.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/precedents.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/router.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "SET CLUSTER SETTING kv.rangefeed.enabled = true;" >/dev/null

echo "--- running scene1-conflict ---"
cd "$ROOT"
DATABASE_URL="$DB_URL" npx tsx scripts/scenes/scene1-conflict.ts

echo "=== STYX DEMO: Scene 1 complete ==="
