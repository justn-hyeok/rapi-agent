#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi
# A unique disposable instance; never select the production Compose project or DB.
compose+=(-p "rapi-e2e-$$" -f compose.test.yaml)
trap '"${compose[@]}" down --volumes >/dev/null' EXIT
"${compose[@]}" up -d --wait postgres
endpoint=$("${compose[@]}" port postgres 5432)
test_port=${endpoint##*:}
[[ "$test_port" =~ ^[0-9]+$ ]]
for migration in packages/db/migrations/*.sql; do
  "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U rapi -d rapi_test < "$migration" >/dev/null
done
# The new migration must also tolerate reapplication after an interrupted migrator.
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U rapi -d rapi_test \
  < packages/db/migrations/0004_chatops_capabilities.sql >/dev/null
DATABASE_URL="postgresql://rapi:rapi-local-only@127.0.0.1:$test_port/rapi_test" \
  ./node_modules/.bin/tsx --test --test-concurrency=1 tests/e2e/*.test.ts
