#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p backups

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="backups/rapi-$stamp.sql"
"${compose[@]}" exec -T postgres pg_dump -U rapi --no-owner --no-privileges rapi > "$target"
chmod 600 "$target"
echo "$target"
