#!/bin/zsh
set -euo pipefail

network_service="${RAPI_NETWORK_SERVICE:-Wi-Fi}"
settings_directory="${HOME}/Library/Application Support/RapiWebProxy"
state_file="${settings_directory}/previous-auto-proxy"

if [[ -f "$state_file" ]]; then
  previous_url="$(sed -n 's/^URL: //p' "$state_file")"
  previous_state="$(sed -n 's/^Enabled: //p' "$state_file")"
  if [[ -n "$previous_url" && "$previous_url" != "(null)" ]]; then
    sudo /usr/sbin/networksetup -setautoproxyurl "$network_service" "$previous_url"
  fi
  if [[ "$previous_state" == "Yes" ]]; then
    sudo /usr/sbin/networksetup -setautoproxystate "$network_service" on
  else
    sudo /usr/sbin/networksetup -setautoproxystate "$network_service" off
  fi
  rm -f "$state_file"
  rmdir "$settings_directory" 2>/dev/null || true
else
  sudo /usr/sbin/networksetup -setautoproxystate "$network_service" off
fi

echo "자동 프록시를 제거하고 이전 설정을 복원했습니다: ${network_service}"
