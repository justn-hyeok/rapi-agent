# Discord 접근 정책

상태: accepted

운영자 ID와 공개 커뮤니티 역할을 분리한다. 서버 명령은 등록된 사용자·역할
등급에 더해 `DISCORD_ALLOWED_GUILD_IDS`와, 설정한 경우
`DISCORD_ALLOWED_CHANNEL_IDS`도 일치해야 한다. 역할을 받지 않은 일반 멤버는
`DISCORD_GUILD_MEMBERS_ARE_USERS=false` 구성에서 거부된다. DM은 명시적으로
허용된 사용자에게만 응답한다.

권한은 `USER < ADMIN < SUPERADMIN` 순서다. 기존
`DISCORD_ALLOWED_USER_IDS`와 `DISCORD_SUPERADMIN_USER_IDS`는 SUPERADMIN,
`DISCORD_ADMIN_USER_IDS`와 `DISCORD_ADMIN_ROLE_IDS`는 ADMIN,
`DISCORD_USER_IDS`와 `DISCORD_USER_ROLE_IDS`는 USER를 부여한다. SUPERADMIN은
Discord 역할만으로 부여하지 않고 명시적인 사용자 ID로만 부여한다.
`DISCORD_GUILD_MEMBERS_ARE_USERS=true`이면 허용된 guild에서 Discord가 확인한
멤버는 별도 등록 없이 USER다. Discord Administrator 권한이 확인된 멤버는
ADMIN으로 판정한다. 이 승격은 SUPERADMIN에는 적용되지 않는다.

| 등급       | 허용 범위                                                                                |
| ---------- | ---------------------------------------------------------------------------------------- |
| USER       | 공개 브리핑·검색, 개인 사용량, 공개 자연어 질문                                          |
| ADMIN      | USER 기능, 상태·수집원·발송 내역·사용 정책·구독 관리, 대화 채널 활성화·비활성화          |
| SUPERADMIN | ADMIN 기능, 비공개 관리 채널의 실행·반복·취소·기억, OMP 작업·승인·취소, 서버 구성과 웹훅 |

권한 검사는 자연어 처리나 명령 라우팅보다 먼저 수행한다. ID가 없거나 형식이
잘못된 설정은 기동 전에 거부한다. 거부된 요청은 민감한 payload 없이 사용자,
guild, channel ID와 시각만 감사 로그에 기록한다.

`/approve`, `/cancel`, 구독 변경, 발송 대상 변경은 관리자 명령이다. 조회 명령을
추가로 위임할 경우 별도의 read-only role을 만들며 관리자 allowlist를 재사용해
권한을 넓히지 않는다. allowlist 변경은 운영 환경 설정 변경으로 취급하고 재시작과
감사 기록을 요구한다.
