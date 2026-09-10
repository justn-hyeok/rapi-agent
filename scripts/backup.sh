#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
backup_directory=${RAPI_BACKUP_DIRECTORY:-backups}
backup_status_file=${BACKUP_STATUS_FILE:-backups/backup-status.json}
backup_retention=${BACKUP_RETENTION_COUNT:-7}
mkdir -p "$backup_directory" "$(dirname "$backup_status_file")"
DATABASE_URL=${DATABASE_URL:-postgresql://rapi:rapi-local-only@127.0.0.1:5432/rapi}
export DATABASE_URL

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_directory/rapi-$stamp.dump"
temporary="$target.$$.tmp"
status_temporary="$backup_status_file.$$.tmp"
cleanup() {
  rm -f "$temporary" "$status_temporary"
}
record_failure() {
  exit_code=$?
  trap - ERR
  node - "$backup_status_file" "$status_temporary" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [source, target] = process.argv.slice(2);
let previous = {};
try { previous = JSON.parse(readFileSync(source, "utf8")); } catch {}
writeFileSync(target, `${JSON.stringify({
  ...previous,
  state: "failed",
  lastFailureAt: new Date().toISOString(),
})}\n`, { mode: 0o600 });
NODE
  chmod 600 "$status_temporary"
  mv "$status_temporary" "$backup_status_file"
  exit "$exit_code"
}
trap cleanup EXIT
trap record_failure ERR
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump --format=custom --no-owner --no-privileges --file="$temporary" "$DATABASE_URL"
elif [[ "$DATABASE_URL" == "postgresql://rapi:rapi-local-only@127.0.0.1:5432/rapi" ]]; then
  compose=(docker compose)
  if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    compose=(sudo docker compose)
  fi
  "${compose[@]}" exec -T postgres pg_dump --format=custom -U rapi --no-owner --no-privileges rapi > "$temporary"
else
  echo "A pg_dump version compatible with the remote PostgreSQL server is required" >&2
  exit 1
fi
chmod 600 "$temporary"
mv "$temporary" "$target"
chmod 600 "$target"
successful_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"state":"success","lastSuccessAt":"%s","file":"%s"}\n' "$successful_at" "$target" > "$status_temporary"
chmod 600 "$status_temporary"
mv "$status_temporary" "$backup_status_file"
trap - ERR
find "$backup_directory" -maxdepth 1 -type f -name 'rapi-*.dump' -printf '%T@ %p\n' \
  | sort -rn \
  | tail -n "+$((backup_retention + 1))" \
  | cut -d' ' -f2- \
  | xargs -r rm --
echo "$target"
