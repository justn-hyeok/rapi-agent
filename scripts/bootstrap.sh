#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required." >&2
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)' || {
  echo "Node.js 22.13 or newer is required." >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker with Compose v2 is required." >&2
  exit 1
fi

npm ci
docker compose up -d postgres
./scripts/migrate.sh
./scripts/verify-db.sh
npm run check
npm run test:e2e
npm run restart:smoke
npm run restore:smoke
npm run audit:prod

echo "rapi-agent development environment is ready."
