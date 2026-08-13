#!/usr/bin/env bash
# Thin wrapper around the styx-migrate Lambda (built and deployed out of
# band, already applied kernel/src/db/{schema,precedents,router}.sql to the
# cloud cluster once). It takes no payload: it re-applies its bundled SQL
# files against its own DATABASE_URL env var, which is idempotent because
# every one of those files is CREATE TABLE IF NOT EXISTS. Run this after
# schema.sql/precedents.sql/router.sql change, to push the change to the
# cloud cluster the same way it was applied the first time.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-styx}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

OUT_FILE="$(mktemp)"
trap 'rm -f "$OUT_FILE"' EXIT

echo "[cloud-migrate] invoking styx-migrate..."
aws lambda invoke --function-name styx-migrate --cli-read-timeout 60 --payload '{}' "$OUT_FILE" >/dev/null
cat "$OUT_FILE"
echo

echo "[cloud-migrate] recent logs:"
aws logs tail /aws/lambda/styx-migrate --since 2m || true
