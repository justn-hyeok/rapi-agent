#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) throw new Error("Public executor installation requires Node >=22.13")'
prepare_only=false
if [[ "${1:-}" == "--prepare-only" ]]; then prepare_only=true; fi
codex_source="$(node scripts/resolve-codex-binary.mjs "$(command -v codex)")"
if [[ ! -x "$codex_source" ]]; then
  echo "Codex CLI를 찾지 못했습니다." >&2
  exit 1
fi
code_mode_host="$(dirname "$codex_source")/codex-code-mode-host"
if [[ ! -x "$code_mode_host" ]]; then
  echo "Codex web tool execution requires the bundled codex-code-mode-host." >&2
  exit 1
fi
npx tsc -b apps/public-agent

root=()
if [[ $EUID -ne 0 ]]; then root=(sudo); fi
"${root[@]}" groupadd --system --force rapi
if ! id rapi-public >/dev/null 2>&1; then
  "${root[@]}" useradd --system --gid rapi --home-dir /var/lib/rapi-public --shell /usr/sbin/nologin rapi-public
fi
"${root[@]}" usermod -a -G rapi justn
"${root[@]}" install -d -o root -g root -m 0755 /opt/rapi-public-agent
"${root[@]}" install -d -o rapi-public -g rapi -m 0700 /var/lib/rapi-public /var/lib/rapi-public/codex /var/lib/rapi-public/empty /var/lib/rapi-public/runtime
"${root[@]}" install -o root -g root -m 0755 "$codex_source" /opt/rapi-public-agent/codex
"${root[@]}" install -o root -g root -m 0755 "$code_mode_host" /opt/rapi-public-agent/codex-code-mode-host
/opt/rapi-public-agent/codex --version
"${root[@]}" install -o root -g root -m 0644 apps/public-agent/dist/run.js apps/public-agent/dist/executor.js /opt/rapi-public-agent/
"${root[@]}" install -o root -g root -m 0644 ops/systemd/rapi-public-agent.service /etc/systemd/system/rapi-public-agent.service
"${root[@]}" systemctl daemon-reload

if [[ "$prepare_only" == "true" ]]; then
  echo "rapi-public-agent 계정, 격리 디렉터리, 바이너리와 systemd unit을 준비했습니다."
  exit 0
fi

if [[ ! -f /var/lib/rapi-public/codex/auth.json ]]; then
  echo "공개 실행기 전용 Codex 브라우저 로그인을 시작합니다."
  if [[ $EUID -eq 0 ]]; then
    runuser -u rapi-public -- env HOME=/var/lib/rapi-public CODEX_HOME=/var/lib/rapi-public/codex /opt/rapi-public-agent/codex login
  else
    sudo -u rapi-public env HOME=/var/lib/rapi-public CODEX_HOME=/var/lib/rapi-public/codex /opt/rapi-public-agent/codex login
  fi
fi
"${root[@]}" systemctl enable --now rapi-public-agent.service
"${root[@]}" systemctl restart rapi-public-agent.service
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3500/ready >/dev/null
echo "rapi-public-agent가 준비됐습니다. 새 그룹 권한은 다음 로그인부터 적용됩니다."
