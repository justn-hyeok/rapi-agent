#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi

snapshot=$(mktemp /tmp/rapi-restore-smoke.XXXXXX.sql)
cleanup() {
  "${compose[@]}" exec -T postgres dropdb -U rapi --if-exists rapi_restore_smoke >/dev/null 2>&1 || true
  rm -f "$snapshot"
}
trap cleanup EXIT

"${compose[@]}" exec -T postgres pg_dump -U rapi --no-owner --no-privileges rapi > "$snapshot"
"${compose[@]}" exec -T postgres dropdb -U rapi --if-exists rapi_restore_smoke
"${compose[@]}" exec -T postgres createdb -U rapi rapi_restore_smoke
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U rapi -d rapi_restore_smoke < "$snapshot" >/dev/null

tables=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_restore_smoke -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public';")
chatops_tables=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_restore_smoke -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('chatops_runs', 'chatops_events', 'chatops_memory', 'chatops_memory_events');")
if [[ "$tables" -lt 19 ]]; then
  echo "Restore smoke expected at least 19 tables, found $tables" >&2
  exit 1
fi

if [[ "$chatops_tables" -ne 4 ]]; then
  echo "Restore smoke expected all 4 ChatOps capability tables, found $chatops_tables" >&2
  exit 1
fi

echo "Backup restore verified: $tables tables including 4 ChatOps tables."
