#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared CLI가 필요합니다." >&2
  exit 1
fi
if [[ ! -f "${HOME}/.cloudflared/cert.pem" ]]; then
  echo "Cloudflare 브라우저 승인을 시작합니다. justn.me zone을 선택하세요."
  cloudflared tunnel login
fi

suffix="$(openssl rand -hex 6)"
tunnel_name="rapi-agent-${suffix}"
hostname="rapi-${suffix}.justn.me"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
credentials="${temporary}/credentials.json"
created="$(cloudflared tunnel create --output json --credentials-file "$credentials" "$tunnel_name")"
tunnel_id="$(printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.id??v.ID??"")})')"
if [[ ! "$tunnel_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "생성된 tunnel ID를 확인하지 못했습니다." >&2
  exit 1
fi
cloudflared tunnel route dns "$tunnel_id" "$hostname"

root=()
if [[ $EUID -ne 0 ]]; then root=(sudo); fi
"${root[@]}" install -d -o justn -g justn -m 0700 /var/lib/rapi/cloudflared
"${root[@]}" install -o justn -g justn -m 0600 "$credentials" "/var/lib/rapi/cloudflared/${tunnel_id}.json"
config_file="${temporary}/config.yml"
cat >"$config_file" <<EOF
tunnel: ${tunnel_id}
credentials-file: /var/lib/rapi/cloudflared/${tunnel_id}.json
metrics: 127.0.0.1:3700
ingress:
  - hostname: ${hostname}
    service: http://127.0.0.1:3600
  - service: http_status:404
EOF
"${root[@]}" install -o justn -g justn -m 0600 "$config_file" /var/lib/rapi/cloudflared/config.yml
"${root[@]}" install -o root -g root -m 0644 ops/systemd/rapi-public-gateway.service /etc/systemd/system/
"${root[@]}" install -o root -g root -m 0644 ops/systemd/rapi-tunnel.service /etc/systemd/system/
node scripts/update-public-origin.mjs "https://${hostname}"
"${root[@]}" systemctl daemon-reload
"${root[@]}" systemctl enable --now rapi-public-gateway.service rapi-tunnel.service
"${root[@]}" systemctl restart rapi-public-gateway.service rapi-tunnel.service
node --env-file=.env scripts/configure-discord-endpoint.mjs

for attempt in {1..12}; do
  health_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "https://${hostname}/health" || true)"
  interaction_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 -X POST "https://${hostname}/interactions" || true)"
  if [[ "$health_status" == "404" && "$interaction_status" == "401" ]]; then
    node --env-file=.env scripts/mark-tunnel-verified.mjs "https://${hostname}"
    "${root[@]}" systemctl restart rapi-bot.service rapi-worker.service rapi-monitor.service
    echo "고정 공개 주소가 준비됐습니다: https://${hostname}"
    echo "공개 health 차단과 Discord interaction 전달을 확인했습니다."
    exit 0
  fi
  sleep 5
done
echo "터널은 생성됐지만 공개 경로 확인에 실패했습니다." >&2
exit 1
