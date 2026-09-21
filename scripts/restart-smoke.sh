#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

restart_project=${RESTART_SMOKE_PROJECT:-}
restart_database=${RESTART_SMOKE_DATABASE:-}
if [[ ! "$restart_project" =~ ^rapi-restart-[a-z0-9-]+$ ]]; then
  echo "RESTART_SMOKE_PROJECT must be a disposable rapi-restart-* project." >&2
  exit 2
fi
if [[ "$restart_database" != "rapi_test" ]]; then
  echo "RESTART_SMOKE_DATABASE must be rapi_test." >&2
  exit 2
fi
if [[ -n "${RESTART_SMOKE_ARTIFACT:-}" && ! "$RESTART_SMOKE_ARTIFACT" =~ ^tests/artifacts/[a-z0-9_-]+\.json$ ]]; then
  echo "RESTART_SMOKE_ARTIFACT must be a tests/artifacts/*.json path." >&2
  exit 2
fi

compose=(docker compose -p "$restart_project" -f compose.test.yaml)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose -p "$restart_project" -f compose.test.yaml)
fi
cleanup() {
  "${compose[@]}" down --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" up -d --wait postgres
endpoint=$("${compose[@]}" port postgres 5432)
restart_port=${endpoint##*:}
[[ "$restart_port" =~ ^[0-9]+$ ]]
restart_url="postgresql://rapi:rapi-local-only@127.0.0.1:$restart_port/$restart_database"
DATABASE_URL="$restart_url" node scripts/migrate.mjs >/dev/null

"${compose[@]}" exec -T postgres psql -U rapi -d "$restart_database" -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE IF NOT EXISTS restart_smoke_probe(id integer PRIMARY KEY); INSERT INTO restart_smoke_probe(id) VALUES (1) ON CONFLICT DO NOTHING;" >/dev/null
before=$("${compose[@]}" exec -T postgres psql -U rapi -d "$restart_database" -Atc \
  "SELECT (SELECT count(*) FROM raw_events) || ':' || (SELECT count(*) FROM delivery_attempts) || ':' || (SELECT count(*) FROM restart_smoke_probe);")

"${compose[@]}" restart postgres >/dev/null
for _ in $(seq 1 30); do
  "${compose[@]}" exec -T postgres pg_isready -U rapi -d "$restart_database" >/dev/null && break
  sleep 1
done
"${compose[@]}" exec -T postgres pg_isready -U rapi -d "$restart_database" >/dev/null

after=$("${compose[@]}" exec -T postgres psql -U rapi -d "$restart_database" -Atc \
  "SELECT (SELECT count(*) FROM raw_events) || ':' || (SELECT count(*) FROM delivery_attempts) || ':' || (SELECT count(*) FROM restart_smoke_probe);")

if [[ "$before" != "$after" ]]; then
  echo "Persistent state changed across PostgreSQL restart: $before -> $after" >&2
  exit 1
fi

if [[ -n "${RESTART_SMOKE_ARTIFACT:-}" ]]; then
  mkdir -p tests/artifacts
  RESTART_PROJECT="$restart_project" RESTART_DATABASE="$restart_database" \
    RESTART_BEFORE="$before" RESTART_AFTER="$after" \
    RESTART_ARTIFACT="$RESTART_SMOKE_ARTIFACT" node --input-type=module -e '
      import { writeFile } from "node:fs/promises";
      import { restartSmokeArtifact } from "./scripts/restart-smoke-artifact.mjs";
      const artifact = restartSmokeArtifact({
        project: process.env.RESTART_PROJECT,
        database: process.env.RESTART_DATABASE,
        before: process.env.RESTART_BEFORE,
        after: process.env.RESTART_AFTER,
      });
      await writeFile(process.env.RESTART_ARTIFACT, `${JSON.stringify(artifact)}\n`);
    '
fi

echo "Restart recovery verified: $after"
