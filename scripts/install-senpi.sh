#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
manifest=ops/harness-versions.json
version="$(jq -r '.senpi.version' "$manifest")"
asset="$(jq -r '.senpi.asset' "$manifest")"
sha256="$(jq -r '.senpi.sha256' "$manifest")"
service_user="${SENPI_SERVICE_USER:-justn}"
senpi_home="${SENPI_HOME:-/var/lib/rapi/senpi}"
target="/opt/rapi-senpi/$version"

root=()
if [[ $EUID -ne 0 ]]; then root=(sudo); fi

if [[ ! -x "$target/pi/pi" ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  gh release download "v$version" -R code-yeongyu/senpi -p "$asset" -D "$work"
  actual="$(sha256sum "$work/$asset" | cut -d' ' -f1)"
  if [[ "$actual" != "$sha256" ]]; then
    echo "senpi $asset sha256이 고정값과 다릅니다. 설치를 중단합니다." >&2
    exit 1
  fi
  "${root[@]}" install -d -o root -g root -m 0755 /opt/rapi-senpi "$target.tmp"
  "${root[@]}" tar -xzf "$work/$asset" -C "$target.tmp"
  "${root[@]}" rm -rf "$target"
  "${root[@]}" mv "$target.tmp" "$target"
fi
"${root[@]}" ln -sfn "$target/pi/pi" /usr/local/bin/senpi

"${root[@]}" install -d -o "$service_user" -m 0700 "$senpi_home" "$senpi_home/agent"
settings="$senpi_home/agent/settings.json"
"${root[@]}" tee "$settings" >/dev/null <<'JSON'
{
  "enableInstallTelemetry": false,
  "defaultProjectTrust": "never"
}
JSON
"${root[@]}" chown "$service_user" "$settings"
"${root[@]}" chmod 0600 "$settings"

PI_CODING_AGENT_DIR="$senpi_home/agent" PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 /usr/local/bin/senpi --version
echo "senpi $version 설치 완료. 서비스 계정($service_user)으로 로그인하세요: docs/operations.md"
