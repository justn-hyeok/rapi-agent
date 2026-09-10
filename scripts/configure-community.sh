#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
IFS= read -r -s -p "GitHub fine-grained PAT (건너뛰려면 Enter): " github_pat
printf '\n'
printf '%s' "$github_pat" | node --env-file=.env --import tsx scripts/bootstrap-community.ts
unset github_pat
