#!/usr/bin/env bash
# End-to-end day 2 flow: seed, start API, make a reservation over HTTP,
# break a commitment, watch the changefeed deliver to the router handler
# and the router emit a wake-up. Local CockroachDB only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_URL="postgresql://root@localhost:26257/styx?sslmode=disable"
ADMIN_URL="postgresql://root@localhost:26257/defaultdb?sslmode=disable"
API_PORT=4100
ROUTER_PORT=8797
WAKE_PORT=7191
CERT_DIR="$(mktemp -d)"

CHANGEFEED_JOB=""

# npx/tsx fork children, so `kill $!` on the wrapper subshell often leaves
# the real node process holding the port; killing by port is what actually
# frees it for the next run.
kill_port() {
  local port="$1"
  lsof -ti ":$port" 2>/dev/null | xargs -r kill >/dev/null 2>&1 || true
}

cleanup() {
  echo "--- cleanup ---"
  kill_port "$API_PORT"
  kill_port "$ROUTER_PORT"
  kill_port "$WAKE_PORT"
  if [ -n "$CHANGEFEED_JOB" ]; then
    psql "$DB_URL" -c "CANCEL JOB $CHANGEFEED_JOB;" >/dev/null 2>&1 || true
  fi
  rm -rf "$CERT_DIR"
}
trap cleanup EXIT

echo "--- 0. clear any leftovers from a previous run ---"
kill_port "$API_PORT"
kill_port "$ROUTER_PORT"
kill_port "$WAKE_PORT"

echo "--- 1. reset schema ---"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS styx;" -c "CREATE DATABASE styx;" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/schema.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/precedents.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/kernel/src/db/router.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "SET CLUSTER SETTING kv.rangefeed.enabled = true;" >/dev/null

echo "--- 2. seed demo agents + resources ---"
SEED_OUT="$(cd "$ROOT/kernel" && DATABASE_URL="$DB_URL" npx tsx ../scripts/seed.ts)"
echo "$SEED_OUT"
ALICE_ID=$(echo "$SEED_OUT" | grep '^  alice' | sed -n 's/.*id=\([^ ]*\).*/\1/p')
ALICE_KEY=$(echo "$SEED_OUT" | grep '^  alice' | sed -n 's/.*key=\(.*\)/\1/p')
CAROL_ID=$(echo "$SEED_OUT" | grep '^  carol' | sed -n 's/.*id=\([^ ]*\).*/\1/p')

echo "--- 3. start kernel API on :$API_PORT ---"
(cd "$ROOT/kernel" && DATABASE_URL="$DB_URL" PORT="$API_PORT" npx tsx src/api/start.ts) > /tmp/day2-api.log 2>&1 &

echo "--- 4. start wake relay (day 3 stand-in) on :$WAKE_PORT ---"
cat > "$CERT_DIR/wake-relay.js" <<EOF
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log('WAKE:', body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen($WAKE_PORT, () => console.log('wake relay on :$WAKE_PORT'));
EOF
node "$CERT_DIR/wake-relay.js" > /tmp/day2-wake-relay.log 2>&1 &

echo "--- 5. generate self-signed cert + start router (HTTPS) on :$ROUTER_PORT ---"
openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 1 -nodes -subj "/CN=localhost" >/dev/null 2>&1
(cd "$ROOT/router" && \
  DATABASE_URL="$DB_URL" \
  ROUTER_PORT="$ROUTER_PORT" \
  ROUTER_TLS_CERT_FILE="$CERT_DIR/cert.pem" \
  ROUTER_TLS_KEY_FILE="$CERT_DIR/key.pem" \
  WAKE_URL="http://localhost:$WAKE_PORT/wake" \
  npx tsx src/local.ts) > /tmp/day2-router.log 2>&1 &

sleep 2
echo "api log:"; cat /tmp/day2-api.log
echo "router log:"; cat /tmp/day2-router.log

echo "--- 6. point a changefeed at the router ---"
CHANGEFEED_JOB=$(psql "$DB_URL" -t -A -c "CREATE CHANGEFEED FOR TABLE commitment_events INTO 'webhook-https://localhost:$ROUTER_PORT?insecure_tls_skip_verify=true' WITH updated, resolved='3s';")
echo "changefeed job: $CHANGEFEED_JOB"
sleep 2

echo "--- 7. alice reserves task:build-auth over HTTP ---"
RESERVE_RESPONSE=$(curl -s -X POST "http://localhost:$API_PORT/v1/reservations" \
  -H "Authorization: Bearer $ALICE_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: smoke-reserve-1" \
  -d "{\"debtorAgentId\":\"$ALICE_ID\",\"creditorAgentId\":\"$CAROL_ID\",\"terms\":{\"resource\":\"task:build-auth\",\"quantity\":1}}")
echo "$RESERVE_RESPONSE"
COMMITMENT_ID=$(echo "$RESERVE_RESPONSE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).commitment.id))")
VERSION=$(echo "$RESERVE_RESPONSE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).commitment.version))")

echo "--- 8. break it ---"
BREAK_RESPONSE=$(curl -s -X POST "http://localhost:$API_PORT/v1/commitments/$COMMITMENT_ID/transitions" \
  -H "Authorization: Bearer $ALICE_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: smoke-break-1" \
  -d "{\"action\":\"break\",\"expectedVersion\":$VERSION,\"reason\":\"smoke test\"}")
echo "$BREAK_RESPONSE"

echo "--- 9. wait for changefeed delivery ---"
sleep 6

echo "--- router log ---"
cat /tmp/day2-router.log
echo "--- wake relay log ---"
cat /tmp/day2-wake-relay.log

if grep -q "$COMMITMENT_ID" /tmp/day2-wake-relay.log; then
  echo "SMOKE PASS: changefeed delivered the break event and the router emitted a wake-up"
  exit 0
else
  echo "SMOKE FAIL: no wake-up observed for commitment $COMMITMENT_ID"
  exit 1
fi
