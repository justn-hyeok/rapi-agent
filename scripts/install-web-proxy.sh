#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
node --test ops/web-proxy/proxy.test.mjs

root=()
if [[ $EUID -ne 0 ]]; then root=(sudo); fi
if ! id rapi-web-proxy >/dev/null 2>&1; then
  "${root[@]}" useradd \
    --system \
    --home-dir /nonexistent \
    --shell /usr/sbin/nologin \
    rapi-web-proxy
fi
"${root[@]}" install -d -o root -g root -m 0755 /opt/rapi-web-proxy
"${root[@]}" install -o root -g root -m 0644 \
  ops/web-proxy/proxy.mjs \
  ops/web-proxy/run.mjs \
  /opt/rapi-web-proxy/
"${root[@]}" install -o root -g root -m 0644 \
  ops/systemd/rapi-web-proxy.service \
  /etc/systemd/system/rapi-web-proxy.service
"${root[@]}" systemctl daemon-reload
"${root[@]}" systemctl enable --now rapi-web-proxy.service
"${root[@]}" systemctl restart rapi-web-proxy.service
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 \
    http://127.0.0.1:3800/health >/dev/null; then
    break
  fi
  sleep 0.25
done
curl --fail --silent --show-error --max-time 2 \
  http://127.0.0.1:3800/health >/dev/null
"${root[@]}" tailscale serve --bg --yes --tcp=3800 \
  tcp://127.0.0.1:3800
tailscale_ip="$(tailscale ip -4)"
curl --fail --silent --show-error --max-time 3 \
  "http://${tailscale_ip}:3800/proxy.pac" >/dev/null
echo "rapi web proxy가 tailnet의 rapi-agent:3800에서 준비됐습니다."
