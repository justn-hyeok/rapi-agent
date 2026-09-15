#!/bin/zsh
set -euo pipefail

network_service="${RAPI_NETWORK_SERVICE:-Wi-Fi}"
proxy_host="${RAPI_PROXY_HOST:-rapi-agent}"
proxy_port="${RAPI_PROXY_PORT:-3800}"
settings_directory="${HOME}/Library/Application Support/RapiWebProxy"
state_file="${settings_directory}/previous-auto-proxy"
pac_url="http://${proxy_host}:${proxy_port}/proxy.pac"

if ! curl --fail --silent --show-error --max-time 5 "$pac_url" >/dev/null; then
  echo "프록시 서버에 연결할 수 없습니다. Tailscale 연결을 확인하세요." >&2
  exit 1
fi

mkdir -p "$settings_directory"
if [[ ! -f "$state_file" ]]; then
  /usr/sbin/networksetup -getautoproxyurl "$network_service" >"$state_file"
fi

sudo /usr/sbin/networksetup -setautoproxyurl "$network_service" "$pac_url"
sudo /usr/sbin/networksetup -setautoproxystate "$network_service" on

echo "자동 프록시 설치 완료: ${network_service}"
echo "이제 지정된 사이트만 ${proxy_host} 서버를 통해 자동 연결됩니다."
echo "DeepSeek API용 터미널 설정: export HTTPS_PROXY=http://${proxy_host}:${proxy_port}"

