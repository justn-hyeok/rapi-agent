# 커뮤니티 운영 전환

## 구현된 경계

- 일반 USER는 `/검색`, `/브리핑`, `/사용량`과 `라피야!` 공개 질문만 사용할 수 있다.
  `/검색`은 `visibility=public` 자료만 읽고 무료다. 브리핑과 질문은
  `gpt-5.3-codex-spark` 호출로 1회 계산한다.
- 기본 정책은 USER 30초 쿨다운, 하루 20회, 서버 전체 하루 500회, 동시 실행 2개다.
  `Asia/Seoul` 05:30에 사용 창이 바뀐다. Discord Administrator는 일일·쿨다운 한도가
  없지만 애플리케이션 SUPERADMIN이 되지는 않는다.
- 소유자 ID만 SUPERADMIN이다. 코드·서버 실행, 기억, 작업 명령은 비공개
  `라피-관리`에서만 실행된다.
- 공개 질문은 별도 `rapi-public` OS 계정, 빈 작업 디렉터리와 별도 `CODEX_HOME`에서
  수행한다. 애플리케이션 `.env`, DB, Discord token, 저장소와 관리자 기억은 전달하지
  않는다. 세션은 ephemeral이며 shell, 앱, 플러그인, 브라우저 제어, 컴퓨터 제어,
  이미지와 멀티 에이전트 기능을 끈다. live web search만 사용할 수 있다.

질문 원문·응답 원문·Codex 세션은 DB에 저장하지 않는다. `ai_usage_events`에는 guild,
사용자, Discord request ID, 질문 digest, 모델, 시작·완료 시각과 결과만 남는다. 프로세스
시작 뒤 실패나 timeout은 차감하고, spawn 전 내부 오류는 예약을 반환한다.

## Discord 구성

원본은 [`config/discord-channels.yaml`](../config/discord-channels.yaml)이다. 각 역할,
카테고리와 채널은 이름 변경과 무관한 `key`를 갖는다. JSON 파일은 아래처럼 원자적으로
YAML 원본으로 가져올 수 있다.

```bash
npm run discord-layout:import -- /path/to/layout.json
```

SUPERADMIN은 `/서버구성 미리보기`로 생성·수정·이동·권한·삭제 계획과 digest를 본다.
미리보기 응답의 적용 버튼은 10분만 유효하다. 구성 파일 또는 Discord snapshot이
바뀌면 적용하지 않는다. 삭제도 이 버튼을 통과한 계획에서만 수행한다. 적용 뒤
`역할-받기`의 영구 버튼이 `라피 USER` 역할을 부여한다. `/서버구성 내보내기`는
YAML/JSON을 지원한다.

라피 봇 역할에는 Discord Administrator가 필요하며 `라피 운영진`보다 위에 둔다.
`라피 운영진` 역할 자체도 Administrator이지만 코드의 SUPERADMIN 판단은 소유자 ID만
사용한다.

## 공개 실행기 설치

다음 명령은 전용 계정, root 소유 Codex 바이너리 사본, 격리 디렉터리와 systemd unit을
만든다. 최초 한 번 전용 브라우저 로그인을 요청한 뒤 readiness를 확인한다.

```bash
npm run public-agent:install
```

서비스는 `/run/rapi-public-agent/agent.sock`의 그룹 제한 Unix socket으로만 질문을
받는다. loopback `127.0.0.1:3500/health`와 `/ready`는 생존과 Codex auth 준비 여부를
나눠 보여준다.

## Supabase 전환

운영은 Supabase Session pooler의 5432 URL을 사용한다. Transaction pooler는 ChatOps의
세션 advisory lock과 맞지 않으므로 사용하지 않는다. PostgreSQL 서버와 같거나 더
새로운 `pg_dump`/`pg_restore`를 먼저 설치한다.

```bash
npm run supabase:configure
```

명령은 관리자 URL을 숨김 입력으로 받는다. TLS `verify-full`과 Session pooler를 검사하고,
무작위 비밀번호의 `rapi_runtime` 역할을 생성한 뒤 migration과 제한 권한을 적용한다.
`anon`·`authenticated`의 public schema 접근은 차단한다. 관리자 URL은 저장하지 않는다.

사전 검사가 끝나면 현재 작업을 drain하고 기존 DB를 custom dump로 백업한다. 기존
서비스를 정지한 뒤 `.env`의 runtime URL과 새 OMP workspace/receipt 경로를 원자적으로
바꾸고 서비스를 시작한다. bot, ChatOps, worker readiness 중 하나라도 실패하면 이전
`.env`로 되돌리고 기존 서비스를 다시 시작한다. 기존 PostgreSQL, dump와 OMP receipt는
보존하며 새 DB로 이전하지 않는다.

## Cloudflare Named Tunnel

```bash
npm run tunnel:configure
```

Cloudflare 로그인이 없으면 CLI가 브라우저 승인 URL을 연다. 명령은 무작위 12자 suffix의
`rapi-<suffix>.justn.me`, Named Tunnel과 DNS route를 만들고 credentials를 mode `0600`으로
`/var/lib/rapi/cloudflared`에 둔다. 공개 origin은 allowlist gateway의 다음 POST만 전달한다.

- `/interactions`
- `/webhooks/v1/:connectionId`
- 기존 `/webhooks/:sourceId`

공개 `/health`, `/ready`, monitor, OMP callback은 404다. 스크립트가 실제 공개 차단과
interaction 전달을 확인한 뒤 `/var/lib/rapi/tunnel-verified.json`을 만든다. 이 marker와
현재 origin이 일치하기 전에는 신규 수신 웹훅 등록을 거부한다.

## 피드와 웹훅 부트스트랩

Discord 서버 구성을 적용한 뒤 실행한다.

```bash
npm run community:configure
```

명령은 GitHub fine-grained PAT를 숨김 입력으로 한 번만 받으며 인자, `.env`, DB나 로그에
저장하지 않는다. 다음 항목을 멱등하게 준비한다.

- OpenAI News, GitHub Changelog, Cloudflare Blog, Supabase RSS를 public 수집원으로 등록
- `github-피드`, `기술-rss`, `운영-알림` Discord 발송 웹훅 생성 및 암호화 저장
- `justn-hyeok/rapi-agent` GitHub 수신 연결과 GitHub repository webhook 생성
- URL과 비밀값을 한 번 표시하는 범용 수신 연결 생성 후 즉시 중지
- USER/운영진 역할 ID, 관리·운영 채널 ID와 RSS 15분 주기를 `.env`에 기록

RSS 신규 항목은 기존 내구성 queue에 idempotency key로 넣어 `기술-rss`에 즉시 보낸다.
GitHub는 `ping`, `push`, `issues`, `pull_request`, `release`를 검증하고 `github-피드`로
보낸다. Discord `429`의 `retry_after`, 5xx 지수 지연, 404 영구 실패와 메시지 조각별
진행 상태를 적용한다.

## 상태, 용량과 백업

`/health`와 `/ready`는 loopback에만 있다. monitor는 30초마다 DB, bot, Gateway ChatOps,
worker, OMP, 공개 executor, allowlist gateway, Cloudflare tunnel과 백업을 검사한다. 3회
연속 실패를 장애, 이후 2회 연속 성공을 복구로 알린다. 같은 서버 전체가 꺼지거나
인터넷이 단절되면 즉시 알릴 수 없다.

용량은 15분마다 다음을 따로 기록한다.

- 라피 DB: `pg_database_size(current_database())`
- Supabase Database Reports 대응 값: 모든 DB 크기의 합계
- 두 값의 차이와 500MB 기본 한도 대비 전체 DB 합계의 80%·90%

WAL·로그가 포함된 disk size는 PostgreSQL DB 합계와 별도 지표다.

`rapi-backup.timer`는 매일 03:00 UTC에 mode `0600` custom dump를 원자적으로 확정하고
7개를 보관한다. `rapi-restore-smoke.timer`는 매주 최신 dump를 폐기 가능한 로컬 DB에
복원해 테이블, migration과 제약조건을 확인한다.

## 최종 smoke

- [ ] Discord 봇 Administrator 및 역할 순서 확인
- [ ] `npm run public-agent:install` 전용 로그인과 `/ready` 확인
- [ ] `npm run supabase:configure` 전환 및 기존 dump/receipt 보존 확인
- [ ] `npm run tunnel:configure` hostname, 공개 차단과 marker 확인
- [ ] `/서버구성 미리보기` 보고서 확인 후 적용 버튼 실행
- [ ] `npm run community:configure` RSS 4종과 웹훅 연결 ID 기록
- [ ] 미인증 접근 차단, USER 역할 버튼, 공개 검색·질문·브리핑 확인
- [ ] 운영진 무제한과 소유자의 공개 채널 실행 거부·관리 채널 실행 확인
- [ ] GitHub ping, RSS, Discord 시험 발송과 장애·복구 알림 확인
- [ ] `npm run check`, `npm run test:e2e`, `npm run audit:prod` 확인
- [ ] `RESTORE_LATEST_BACKUP=true npm run restore:smoke` 확인
