#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi

"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U rapi -d rapi <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (name)
SELECT '0001_phase_zero.sql'
WHERE to_regclass('public.sources') IS NOT NULL
ON CONFLICT DO NOTHING;
SQL

for migration in packages/db/migrations/*.sql; do
  name=$(basename "$migration")
  applied=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi -Atc \
    "SELECT 1 FROM schema_migrations WHERE name = '$name';")
  if [[ "$applied" == "1" ]]; then
    continue
  fi
  "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U rapi -d rapi < "$migration"
  "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U rapi -d rapi -c \
    "INSERT INTO schema_migrations (name) VALUES ('$name') ON CONFLICT DO NOTHING;" >/dev/null
  echo "Applied $name"
done
