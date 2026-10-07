#!/usr/bin/env bash
# Deploys origin/main to this VM once GitHub CI has passed for that exact SHA.
# Runs from the current release, so each deploy also updates this script.
set -euo pipefail

REPO=${RAPI_SOURCE_CHECKOUT:-/home/justn/rapi-agent}
ROOT=${RAPI_RELEASE_ROOT:-/home/justn/rapi-releases}
ENV_FILE=${RAPI_SERVICE_ENV_FILE:-/home/justn/rapi-agent/.env}
GITHUB_REPO=${RAPI_GITHUB_REPOSITORY:-justn-hyeok/rapi-agent}
KEEP_RELEASES=${RAPI_KEEP_RELEASES:-6}
FAILED="$ROOT/.auto-deploy-failed"

exec 9>"$ROOT/.auto-deploy.lock"
flock -n 9 || exit 0

env_value() {
  local line
  line=$(grep -m1 "^$1=" "$ENV_FILE" || true)
  line=${line#*=}
  line=${line%\"}
  line=${line#\"}
  printf '%s' "$line"
}

notify() {
  echo "$1"
  local token channel
  token=$(env_value DISCORD_BOT_TOKEN)
  channel=$(env_value OPERATIONS_CHANNEL_ID)
  [[ -n "$token" && -n "$channel" ]] || return 0
  jq -n --arg content "$1" '{content: $content, allowed_mentions: {parse: []}}' |
    curl -fsS -m 15 -o /dev/null -X POST \
      -H "Authorization: Bot $token" -H "Content-Type: application/json" \
      --data @- "https://discord.com/api/v10/channels/$channel/messages" || true
}

git -C "$REPO" fetch -q origin main
SHA=$(git -C "$REPO" rev-parse origin/main)
SHORT=${SHA:0:7}
CURRENT=$(jq -r .sha "$ROOT/current/release-manifest.json")
[[ "$SHA" == "$CURRENT" ]] && exit 0
grep -qx "$SHA" "$FAILED" 2>/dev/null && exit 0

checks=$(curl -fsS -m 20 -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GITHUB_REPO/commits/$SHA/check-runs?per_page=100")
total=$(jq '.total_count' <<<"$checks")
pending=$(jq '[.check_runs[] | select(.status != "completed")] | length' <<<"$checks")
failed=$(jq -r '[.check_runs[] | select(.status == "completed" and
  (.conclusion | IN("success", "skipped", "neutral") | not)) | .name] | join(", ")' <<<"$checks")
# Wait for CI to start and finish; GitHub may not have registered runs yet.
(( total > 0 && pending == 0 )) || [[ -n "$failed" ]] || exit 0
title=$(git -C "$REPO" log -1 --format=%s "$SHA")
if [[ -n "$failed" ]]; then
  echo "$SHA" >>"$FAILED"
  notify "⚠️ 자동 배포 건너뜀 \`$SHORT\` $title — CI 실패: $failed"
  exit 0
fi

fail() {
  echo "$SHA" >>"$FAILED"
  notify "❌ 자동 배포 실패 \`$SHORT\` $title — $1. 운영은 \`${CURRENT:0:7}\` 그대로입니다."
  exit 1
}

STAGE="$ROOT/.stage-$SHORT"
git -C "$REPO" worktree remove --force "$STAGE" 2>/dev/null || true
git -C "$REPO" worktree add -q --detach "$STAGE" "$SHA"
trap 'git -C "$REPO" worktree remove --force "$STAGE" 2>/dev/null || true' EXIT
cd "$STAGE"

# Children must not read this script's stdin.
RAPI_RELEASE_SHA="$SHA" RAPI_RELEASE_ROOT="$ROOT" ./scripts/deploy-revision.sh </dev/null >"$ROOT/.auto-deploy-$SHORT.log" 2>&1 ||
  fail "검증 단계 실패 (로그: .auto-deploy-$SHORT.log)"
# shellcheck disable=SC2012 # release directory names are generated, not user input
candidate=$(ls -td "$ROOT"/rapi-"${SHA:0:12}"-* | head -1)
receipt="$ROOT/switch-$SHORT-$(date -u +%Y%m%d%H%M).json"
# shellcheck disable=SC2024 # the log is intentionally written as this user
sudo -n env RAPI_SWITCH_APPROVED=true RAPI_CURRENT_RELEASE="$ROOT/current" \
  RAPI_CANDIDATE_RELEASE="$candidate" RAPI_RELEASE_SHA="$SHA" \
  RAPI_SWITCH_RECEIPT="$receipt" RAPI_SERVICE_ENV_FILE="$ENV_FILE" \
  RAPI_SWITCH_SERVICES=bot,chat,omp,monitor,worker \
  "$(command -v node)" scripts/switch-release.mjs </dev/null >>"$ROOT/.auto-deploy-$SHORT.log" 2>&1 || true
status=$(jq -r '.status // "missing"' "$receipt" 2>/dev/null || echo missing)
[[ "$status" == "switched" ]] || fail "서비스 전환 실패 ($status)"

# Keep the source checkout on main for ChatOps, preserving local edits.
if [[ -n "$(git -C "$REPO" rev-list origin/main..HEAD)" ]]; then
  notify "⚠️ 소스 체크아웃에 push되지 않은 커밋이 있어 main으로 맞추지 않았습니다."
else
  git -C "$REPO" reset -q --keep origin/main ||
    notify "⚠️ 소스 체크아웃을 main으로 맞추지 못했습니다."
fi

# Prune old staged releases, never the current or previous one.
previous=$(jq -r '.previousPath // empty' "$receipt")
current_path=$(readlink -f "$ROOT/current")
# shellcheck disable=SC2012
ls -td "$ROOT"/rapi-*/ 2>/dev/null | sed 's:/$::' | tail -n +$((KEEP_RELEASES + 1)) |
  while read -r dir; do
    [[ "$dir" == "$current_path" || "$dir" == "$previous" ]] || rm -rf "$dir"
  done

notify "✅ 자동 배포 완료 \`${CURRENT:0:7}\` → \`$SHORT\` $title"
