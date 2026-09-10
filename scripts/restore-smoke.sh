#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi

snapshot=$(mktemp /tmp/rapi-restore-smoke.XXXXXX.dump)
cleanup() {
  "${compose[@]}" exec -T postgres dropdb -U rapi --if-exists rapi_restore_smoke >/dev/null 2>&1 || true
  rm -f "$snapshot"
}
trap cleanup EXIT

if [[ -n "${BACKUP_FILE:-}" ]]; then
  cp "$BACKUP_FILE" "$snapshot"
elif [[ "${RESTORE_LATEST_BACKUP:-false}" == "true" ]]; then
  backup_directory=${RAPI_BACKUP_DIRECTORY:-backups}
  latest=$(find "$backup_directory" -maxdepth 1 -type f -name 'rapi-*.dump' -printf '%T@ %p\n' \
    | sort -rn | head -n 1 | cut -d' ' -f2-)
  [[ -n "$latest" ]] || { echo "No backup found in $backup_directory" >&2; exit 1; }
  cp "$latest" "$snapshot"
elif [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --no-owner --no-privileges --file="$snapshot" "$DATABASE_URL"
else
  "${compose[@]}" exec -T postgres pg_dump --format=custom -U rapi --no-owner --no-privileges rapi > "$snapshot"
fi
"${compose[@]}" exec -T postgres dropdb -U rapi --if-exists rapi_restore_smoke
"${compose[@]}" exec -T postgres createdb -U rapi rapi_restore_smoke
"${compose[@]}" exec -T postgres pg_restore --exit-on-error --no-owner --no-privileges -U rapi -d rapi_restore_smoke < "$snapshot" >/dev/null

tables=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_restore_smoke -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public';")
chatops_tables=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_restore_smoke -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('chatops_runs', 'chatops_events', 'chatops_memory', 'chatops_memory_events');")
if [[ "$tables" -lt 21 ]]; then
  echo "Restore smoke expected at least 21 tables, found $tables" >&2
  exit 1
fi
webhook_tables=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_restore_smoke -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('webhook_connections','webhook_receipts');")
if [[ "$webhook_tables" -ne 2 ]]; then
  echo "Restore smoke expected both managed webhook tables" >&2
  exit 1
fi

migration_records=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_restore_smoke -Atc \
  "SELECT count(*) FROM schema_migrations;")
constraints=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_restore_smoke -Atc \
  "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype IN ('p','u','f','c');")
if [[ "$migration_records" -lt 7 ]]; then
  echo "Restore smoke expected at least 7 migration records, found $migration_records" >&2
  exit 1
fi
if [[ "$constraints" -lt 20 ]]; then
  echo "Restore smoke expected at least 20 public constraints, found $constraints" >&2
  exit 1
fi

if [[ "$chatops_tables" -ne 4 ]]; then
  echo "Restore smoke expected all 4 ChatOps capability tables, found $chatops_tables" >&2
  exit 1
fi

echo "Backup restore verified: $tables tables, $migration_records migration records, $constraints constraints."
