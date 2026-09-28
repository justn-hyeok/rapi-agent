#!/usr/bin/env bash
set -euo pipefail

# R30: prepare and verify a versioned release. This script never changes a
# service, database, live checkout, or current-release pointer.
repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$repo_root"

expected_sha=${RAPI_RELEASE_SHA:-}
release_root=${RAPI_RELEASE_ROOT:-}
if [[ ! "$expected_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "RAPI_RELEASE_SHA must be the full 40-character candidate commit SHA." >&2
  exit 2
fi
if [[ ! "$release_root" = /* || ! -d "$release_root" || -L "$release_root" ]]; then
  echo "RAPI_RELEASE_ROOT must be an existing, absolute, non-symlink directory." >&2
  exit 2
fi
release_root=$(cd "$release_root" && pwd -P)
if [[ "$release_root" == "$repo_root" || "$release_root" == "$repo_root"/* ]]; then
  echo "RAPI_RELEASE_ROOT must be outside the source checkout." >&2
  exit 2
fi

actual_sha=$(git rev-parse --verify HEAD)
if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "Candidate SHA differs from HEAD; refusing to stage a different revision." >&2
  exit 2
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Source checkout has a diff or untracked files; commit and verify the exact candidate first." >&2
  exit 2
fi

# git archive excludes local secrets and build output. A fresh npm ci proves
# that the candidate is reproducible without this checkout's node_modules.
stage=$(mktemp -d "$release_root/rapi-${expected_sha:0:12}-XXXXXX")
printf '%s\n' "Staging $expected_sha at $stage"
git archive --format=tar -o "$stage/.source.tar" "$expected_sha"
tar -xf "$stage/.source.tar" -C "$stage"
rm "$stage/.source.tar"
if [[ -e "$stage/.env" ]]; then
  echo "Candidate archive contains .env; refusing to verify or manifest this release." >&2
  exit 2
fi

(
  cd "$stage"
  # Never let a caller's production DB or backup variables redirect a smoke
  # drill. Each database test uses its own disposable Compose project.
  unset DATABASE_URL BACKUP_FILE RESTORE_LATEST_BACKUP RAPI_BACKUP_DIRECTORY
  unset MIGRATION_DATABASE_URL
  unset PRIVACY_HMAC_KEY PRIVACY_STATUS_FILE RAPI_PRIVACY_LEDGER_FILE RAPI_BACKUP_CATALOG_FILE
  unset RAPI_PRIVACY_PUBLICATION_ROOTS RAPI_BACKUP_CATALOG_ROOTS
  export RAPI_ENV=test
  unset RAPI_MIGRATIONS_DIRECTORY COMPOSE_FILE COMPOSE_PROJECT_NAME
  unset RESTART_SMOKE_PROJECT RESTART_SMOKE_DATABASE RESTORE_SMOKE_PROJECT RESTORE_SMOKE_DATABASE
  unset RESTART_SMOKE_ARTIFACT RESTORE_SMOKE_ARTIFACT
  npm ci
  npm run check
  npm run web-proxy:test
  npm run test:e2e
  RESTART_SMOKE_PROJECT="rapi-restart-release-$$" RESTART_SMOKE_DATABASE=rapi_test npm run restart:smoke
  RESTORE_SMOKE_PROJECT="rapi-restore-release-$$" RESTORE_SMOKE_DATABASE="rapi_restore_smoke_release_$$" npm run restore:smoke
  npm run audit:prod
)

RAPI_STAGED_SHA="$expected_sha" RAPI_STAGED_TREE="$(git rev-parse HEAD^{tree})" \
  RAPI_STAGED_PATH="$stage" node --input-type=module -e '
  import { writeFileSync, readdirSync } from "node:fs";
  const { releaseFileDigests } = await import(`${process.env.RAPI_STAGED_PATH}/scripts/release-artifact.mjs`);
  const receipt = {
    sha: process.env.RAPI_STAGED_SHA,
    tree: process.env.RAPI_STAGED_TREE,
    stagedPath: process.env.RAPI_STAGED_PATH,
    verifiedAt: new Date().toISOString(),
    gates: ["npm ci", "check", "web-proxy:test", "test:e2e", "restart:smoke", "restore:smoke", "audit:prod"],
    switched: false,
    files: await releaseFileDigests(process.env.RAPI_STAGED_PATH),
    migrations: readdirSync(`${process.env.RAPI_STAGED_PATH}/packages/db/migrations`).filter(name => name.endsWith(".sql")).sort(),
  };
  writeFileSync(`${process.env.RAPI_STAGED_PATH}/release-manifest.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
'
printf '%s\n' "Verified staged revision: $stage"
