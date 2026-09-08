#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi

before=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi -Atc \
  "SELECT (SELECT count(*) FROM raw_events) || ':' || (SELECT count(*) FROM delivery_attempts);")

"${compose[@]}" restart postgres >/dev/null
./scripts/verify-db.sh >/dev/null

after=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi -Atc \
  "SELECT (SELECT count(*) FROM raw_events) || ':' || (SELECT count(*) FROM delivery_attempts);")

if [[ "$before" != "$after" ]]; then
  echo "Persistent state changed across PostgreSQL restart: $before -> $after" >&2
  exit 1
fi

echo "Restart recovery verified: $after"
