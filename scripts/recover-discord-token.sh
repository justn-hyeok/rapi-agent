#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

./scripts/rotate-discord-token.sh

root=()
if [[ $EUID -ne 0 ]]; then root=(sudo); fi

started_at="$(date --iso-8601=seconds)"
cleanup() {
  "${root[@]}" systemctl disable --now \
    rapi-chat.service rapi-bot.service >/dev/null 2>&1 || true
}
trap cleanup ERR

"${root[@]}" systemctl enable --now \
  rapi-bot.service \
  rapi-chat.service \
  rapi-omp.service \
  rapi-public-gateway.service

if [[ -f /var/lib/rapi/cloudflared/config.yml ]]; then
  "${root[@]}" systemctl enable --now rapi-tunnel.service
fi

for attempt in {1..30}; do
  chat_log="$(journalctl -u rapi-chat.service --since "$started_at" --no-pager -o cat 2>/dev/null || true)"
  if [[ "$chat_log" == *"rapi-chat connected to Discord Gateway"* ]]; then
    trap - ERR
    echo "새 Discord 토큰을 등록했고 Gateway 연결을 확인했습니다."
    exit 0
  fi
  if [[ "$chat_log" == *"Discord Gateway rejected the bot"* ]]; then
    echo "Discord가 새 토큰을 거부했습니다. 서비스를 다시 중지합니다." >&2
    false
  fi
  sleep 1
done

echo "30초 안에 Discord Gateway 연결을 확인하지 못했습니다. 서비스를 다시 중지합니다." >&2
false
