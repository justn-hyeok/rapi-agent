#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

restore_project=${RESTORE_SMOKE_PROJECT:-}
restore_database=${RESTORE_SMOKE_DATABASE:-}
if [[ ! "$restore_project" =~ ^rapi-restore-[a-z0-9-]+$ ]]; then
  echo "RESTORE_SMOKE_PROJECT must be a disposable rapi-restore-* project." >&2
  exit 2
fi
if [[ ! "$restore_database" =~ ^rapi_restore_smoke_[a-z0-9_]+$ ]]; then
  echo "RESTORE_SMOKE_DATABASE must be a disposable rapi_restore_smoke_* database." >&2
  exit 2
fi
if [[ -n "${RESTORE_SMOKE_ARTIFACT:-}" && ! "$RESTORE_SMOKE_ARTIFACT" =~ ^tests/artifacts/[a-z0-9_-]+\.json$ ]]; then
  echo "RESTORE_SMOKE_ARTIFACT must be a tests/artifacts/*.json path." >&2
  exit 2
fi

compose=(docker compose -p "$restore_project" -f compose.test.yaml)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose -p "$restore_project" -f compose.test.yaml)
fi

snapshot=$(mktemp /tmp/rapi-restore-smoke.XXXXXX.dump)
applied_migrations=$(mktemp /tmp/rapi-restore-migrations.XXXXXX.json)
cleanup() {
  "${compose[@]}" exec -T postgres dropdb -U rapi --if-exists "$restore_database" >/dev/null 2>&1 || true
  rm -f "$snapshot"
  rm -f "$applied_migrations"
}
trap cleanup EXIT

"${compose[@]}" up -d --wait postgres

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
"${compose[@]}" exec -T postgres dropdb -U rapi --if-exists "$restore_database"
"${compose[@]}" exec -T postgres createdb -U rapi "$restore_database"
"${compose[@]}" exec -T postgres pg_restore --exit-on-error --no-owner --no-privileges -U rapi -d "$restore_database" < "$snapshot" >/dev/null

tables=$("${compose[@]}" exec -T postgres psql -U rapi -d "$restore_database" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public';")
chatops_tables=$("${compose[@]}" exec -T postgres psql -U rapi -d "$restore_database" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('chatops_runs', 'chatops_events', 'chatops_memory', 'chatops_memory_events');")
if [[ "$tables" -lt 21 ]]; then
  echo "Restore smoke expected at least 21 tables, found $tables" >&2
  exit 1
fi
webhook_tables=$("${compose[@]}" exec -T postgres psql -U rapi -d "$restore_database" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('webhook_connections','webhook_receipts');")
if [[ "$webhook_tables" -ne 2 ]]; then
  echo "Restore smoke expected both managed webhook tables" >&2
  exit 1
fi

migration_records=$("${compose[@]}" exec -T postgres psql -U rapi -d "$restore_database" -Atc \
  "SELECT count(*) FROM schema_migrations;")
applied_json=$("${compose[@]}" exec -T postgres psql -U rapi -d "$restore_database" -Atc \
  "SELECT COALESCE(json_agg(name ORDER BY name)::text, '[]') FROM schema_migrations;")
printf '%s\n' "$applied_json" > "$applied_migrations"
node scripts/verify-migration-set.mjs \
  --directory packages/db/migrations \
  --applied "$applied_migrations" >/dev/null
constraints=$("${compose[@]}" exec -T postgres psql -U rapi -d "$restore_database" -Atc \
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

if [[ -n "${RESTORE_SMOKE_ARTIFACT:-}" ]]; then
  mkdir -p tests/artifacts
  RESTORE_PROJECT="$restore_project" RESTORE_DATABASE="$restore_database" \
    RESTORE_TABLES="$tables" RESTORE_MIGRATIONS="$migration_records" \
    RESTORE_CONSTRAINTS="$constraints" RESTORE_ARTIFACT="$RESTORE_SMOKE_ARTIFACT" \
    node --input-type=module -e '
      import { writeFile } from "node:fs/promises";
      import { restoreSmokeArtifact } from "./scripts/restore-smoke-artifact.mjs";
      const artifact = restoreSmokeArtifact({
        project: process.env.RESTORE_PROJECT,
        database: process.env.RESTORE_DATABASE,
        tables: Number(process.env.RESTORE_TABLES),
        migrations: Number(process.env.RESTORE_MIGRATIONS),
        constraints: Number(process.env.RESTORE_CONSTRAINTS),
      });
      await writeFile(process.env.RESTORE_ARTIFACT, `${JSON.stringify(artifact)}\n`);
    '
fi

echo "Backup restore verified: $tables tables, $migration_records migration records, $constraints constraints."
