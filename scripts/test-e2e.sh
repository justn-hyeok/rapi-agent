#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# e2e imports workspace packages through their dist exports; build first so the
# suite also runs when an upstream check step was skipped or never built.
npm run build >/dev/null

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi
# A unique disposable instance; never select the production Compose project or DB.
compose+=(-p "rapi-e2e-$$" -f compose.test.yaml)
migration_fixture=$(mktemp -d)
trap 'rm -rf "$migration_fixture"; "${compose[@]}" down --volumes >/dev/null' EXIT
"${compose[@]}" up -d --wait postgres
endpoint=$("${compose[@]}" port postgres 5432)
test_port=${endpoint##*:}
[[ "$test_port" =~ ^[0-9]+$ ]]
test_database_url="postgresql://rapi:rapi-local-only@127.0.0.1:$test_port/rapi_test"
DATABASE_URL="$test_database_url" node scripts/migrate.mjs &
first_migrator=$!
DATABASE_URL="$test_database_url" node scripts/migrate.mjs &
second_migrator=$!
wait "$first_migrator"
wait "$second_migrator"
DATABASE_URL="$test_database_url" node scripts/migrate.mjs

"${compose[@]}" exec -T postgres createdb -U rapi rapi_migration_recovery_test
recovery_url="postgresql://rapi:rapi-local-only@127.0.0.1:$test_port/rapi_migration_recovery_test"
cat >"$migration_fixture/0001_base.sql" <<'SQL'
BEGIN;
CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE recovery_probe(id integer PRIMARY KEY);
INSERT INTO schema_migrations(name) VALUES('0001_base.sql');
COMMIT;
SQL
cat >"$migration_fixture/0002_change.sql" <<'SQL'
BEGIN;
ALTER TABLE recovery_probe ADD COLUMN value text;
SELECT deliberately_missing_function();
INSERT INTO schema_migrations(name) VALUES('0002_change.sql');
COMMIT;
SQL
if DATABASE_URL="$recovery_url" RAPI_MIGRATIONS_DIRECTORY="$migration_fixture" node scripts/migrate.mjs; then
  echo "중간 실패 migration이 성공으로 처리됐습니다." >&2
  exit 1
fi
rolled_back=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_migration_recovery_test -Atc \
  "SELECT count(*) FROM information_schema.columns WHERE table_name='recovery_probe' AND column_name='value'")
[[ "$rolled_back" == "0" ]]
cat >"$migration_fixture/0002_change.sql" <<'SQL'
BEGIN;
ALTER TABLE recovery_probe ADD COLUMN value text;
INSERT INTO schema_migrations(name) VALUES('0002_change.sql');
COMMIT;
SQL
DATABASE_URL="$recovery_url" RAPI_MIGRATIONS_DIRECTORY="$migration_fixture" node scripts/migrate.mjs
recovered=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi_migration_recovery_test -Atc \
  "SELECT count(*) FROM schema_migrations WHERE name='0002_change.sql'")
[[ "$recovered" == "1" ]]
DATABASE_URL="$test_database_url" \
  ./node_modules/.bin/tsx --test --test-concurrency=1 tests/e2e/*.test.ts
