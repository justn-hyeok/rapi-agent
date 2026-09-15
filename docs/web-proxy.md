# 맥용 제한 웹 프록시

이 프록시는 학교에서 허용된 아래 서비스만 서버를 거쳐 연결한다. 다른 사이트는
맥의 기존 네트워크로 직접 연결된다.

- DeepSeek 웹과 API (`deepseek.com`)
- 디시인사이드 (`dcinside.com`, `dcinside.co.kr`)
- 네이버 웹툰 (`comic.naver.com`)
- 네이버 게임 (`game.naver.com`)
- 위 서비스에 필요한 로그인, 정적 파일, 보안 확인 호스트

프록시 프로세스는 서버의 `127.0.0.1:3800`에만 바인딩되고 Tailscale Serve가
tailnet 안의 `rapi-agent:3800`으로 전달한다. 인터넷에는 프록시 포트를 공개하지
않는다. HTTPS 내용을 복호화하거나 인증서에 개입하지 않는다.

## 맥 최초 준비

1. 맥에 [Tailscale](https://tailscale.com/download/mac)을 설치하고 이 서버와 같은
   tailnet 계정으로 로그인한다.
2. 터미널에서 연결을 확인한다.

   ```zsh
   curl http://rapi-agent:3800/proxy.pac
   ```

3. 자동 설정 스크립트를 내려받아 한 번만 실행한다.

   ```zsh
   mkdir -p "$HOME/rapi-web-proxy"
   scp 'justn@rapi-agent:/home/justn/rapi-agent/clients/macos/*.zsh' \
     "$HOME/rapi-web-proxy/"
   chmod 700 "$HOME/rapi-web-proxy/"*.zsh
   "$HOME/rapi-web-proxy/install-auto-web-proxy.zsh"
   ```

## 사용

설치 후에는 Tailscale만 연결돼 있으면 별도 명령이 필요 없다. macOS가 접속
도메인을 보고 지정된 사이트만 자동으로 프록시에 보낸다. 다른 사이트는 기존
네트워크로 직접 연결된다. 브라우저가 열려 있었다면 최초 설치 후 한 번 새로고침한다.

프록시 설정을 제거하면 설치 전에 사용하던 자동 프록시 설정이 복원된다.

```zsh
"$HOME/rapi-web-proxy/uninstall-auto-web-proxy.zsh"
```

네트워크 서비스 이름이 `Wi-Fi`가 아니라면 두 명령 앞에 이름을 지정한다.

```zsh
RAPI_NETWORK_SERVICE="USB 10/100/1000 LAN" \
  "$HOME/rapi-web-proxy/install-auto-web-proxy.zsh"
```

DeepSeek API를 터미널 프로그램에서 호출할 때는 프록시를 켠 터미널에서 다음
환경 변수도 지정한다.

```zsh
export HTTPS_PROXY=http://rapi-agent:3800
```

## 서버 운영

설치와 재설치는 저장소 루트에서 실행한다.

```bash
npm run web-proxy:install
```

상태와 로그는 다음 명령으로 확인한다.

```bash
systemctl status rapi-web-proxy.service
journalctl -u rapi-web-proxy.service
```
