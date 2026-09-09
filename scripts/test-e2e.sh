#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi

test_database=rapi_test
"${compose[@]}" exec -T postgres dropdb --if-exists --force -U rapi "$test_database"
"${compose[@]}" exec -T postgres createdb -U rapi "$test_database"

for migration in packages/db/migrations/*.sql; do
  "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U rapi -d "$test_database" < "$migration" >/dev/null
done

DATABASE_URL="postgresql://rapi:rapi-local-only@127.0.0.1:5432/$test_database" \
  ./node_modules/.bin/tsx --test tests/e2e/*.test.ts
