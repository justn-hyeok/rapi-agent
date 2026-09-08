# Discord 접근 정책

상태: accepted

초기 운영자는 한 명이며 `DISCORD_ALLOWED_USER_IDS`에 등록된 Discord 사용자만
명령을 실행하거나 작업을 승인할 수 있다. 서버와 채널에서 사용할 때는 사용자
allowlist에 더해 `DISCORD_ALLOWED_GUILD_IDS`와 `DISCORD_ALLOWED_CHANNEL_IDS`도
일치해야 한다. DM은 허용 사용자에게만 응답한다.

권한 검사는 자연어 처리나 명령 라우팅보다 먼저 수행한다. ID가 없거나 형식이
잘못된 설정은 기동 전에 거부한다. 거부된 요청은 민감한 payload 없이 사용자,
guild, channel ID와 시각만 감사 로그에 기록한다.

`/approve`, `/cancel`, 구독 변경, 발송 대상 변경은 관리자 명령이다. 조회 명령을
추가로 위임할 경우 별도의 read-only role을 만들며 관리자 allowlist를 재사용해
권한을 넓히지 않는다. allowlist 변경은 운영 환경 설정 변경으로 취급하고 재시작과
감사 기록을 요구한다.
