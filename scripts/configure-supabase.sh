#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  echo "운영 백업용 PostgreSQL client가 필요합니다. 먼저 sudo apt install postgresql-client 를 실행하세요." >&2
  exit 1
fi
IFS= read -r -s -p "Supabase Session pooler 관리자 URL (5432): " admin_url
printf '\n'
if [[ -z "$admin_url" ]]; then
  echo "관리자 URL이 필요합니다." >&2
  exit 1
fi

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"; unset admin_url' EXIT
runtime_file="${temporary}/runtime-url"
printf '%s' "$admin_url" | node scripts/prepare-supabase.mjs "$runtime_file"
unset admin_url

node --env-file=.env scripts/drain-db.mjs
node --env-file=.env -e 'import {spawnSync} from "node:child_process"; const r=spawnSync("./scripts/backup.sh",{stdio:"inherit",env:process.env}); process.exit(r.status??1)'

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
previous="${temporary}/previous.env"
cp .env "$previous"
chmod 600 "$previous"
receipt_root="/home/justn/omp-workspaces-supabase-${stamp}"
node scripts/update-environment.mjs --from-file DATABASE_URL "$runtime_file" OMP_WORKSPACE_ROOT "$receipt_root"

services=(rapi-chat.service rapi-worker.service rapi-bot.service rapi-monitor.service rapi-omp.service)
root=()
if [[ $EUID -ne 0 ]]; then root=(sudo); fi
rollback() {
  echo "새 DB readiness 실패: 기존 연결로 복귀합니다." >&2
  "${root[@]}" install -o justn -g justn -m 0600 "$previous" .env
  "${root[@]}" systemctl restart "${services[@]}" || true
}
trap 'rollback; rm -rf "$temporary"' ERR
"${root[@]}" systemctl stop "${services[@]}"
mkdir -p "$receipt_root"
chmod 700 "$receipt_root"
"${root[@]}" systemctl start "${services[@]}"

for attempt in {1..12}; do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3000/ready >/dev/null &&
     curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3100/ready >/dev/null &&
     curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3400/ready >/dev/null; then
    trap 'rm -rf "$temporary"; unset admin_url' EXIT
    echo "빈 Supabase DB로 전환했고 새 OMP receipt 경로를 적용했습니다: $receipt_root"
    exit 0
  fi
  sleep 3
done
false
