# Rapi 인수인계 — 읽고 나면 삭제해도 되는 문서

작성: 2026-10-26 08:45 KST. 이 대화의 작업 결과와 마지막 실측 상태를 정리했다.
비밀값은 포함하지 않았다. 다음 작업에서는 상태가 바뀌었을 수 있으므로 필요한 항목을 다시 확인한다.

## 1. 지금 어디까지 왔나

라피는 AI 도구를 쓰기 시작한 사람에게 필요한 소식을 골라 보내는 큐레이터다.
주요 기능은 구현·배포돼 있지만, 실제 학습자에게 유용한지 검증하는 단계는 아직 초기다.
서비스 기동, 기능 플래그 활성화, 테스트 통과를 실제 사용자 검증 완료로 해석하지 않는다.

- 코드·테스트 기준 main: `d7c7217aeb1584d522d4da2a7d003d6050e184e9` (#43).
  이 문서 추가는 그 이후의 변경이다. 최신 main SHA는 직접 확인한다.
- 운영 릴리스: `/home/justn/rapi-releases/rapi-d7c7217aeb15-wvUccz`.
- bot/chat/worker/monitor/public-gateway/tunnel 6개 서비스 모두 active 확인.
- 외부 `/archive` HTTP 200 확인. 앞선 배포에서 `/blog/`도 HTTP 200 확인.
- 최신 main CI의 `verify`, `secret-scan`, `blog-browser` 모두 성공.
- 마지막 학습자 DB 집계: 활성 구독 0건, 전체 구독 기록 1건, 발송 기록 0건, 클릭·답장 0건.
- 학습자 호는 `pending` 1건, `empty` 1건. `blog_posts` 테이블은 0건이다.
  이는 기존 정적 블로그 글까지 없다는 뜻은 아니다.

## 2. 작업 위치와 환경

- 레포: `justn-hyeok/rapi-agent`, 기준 체크아웃 `/Users/justn/dev/rapi-agent`.
- TypeScript npm workspaces, Node 22, PostgreSQL, `node:test`.
- 전체 검사: `npm ci` → `npm run check`.
- 이 문서는 **main 브랜치 루트의 `READ_AND_DELETE_THIS.md`**로 인수인계한다.
- 작성에 사용한 작업 트리는 `/Users/justn/Library/Application Support/brgr/worktrees/rapi-agent/fbcf100c`다.
  과거 작업 브랜치나 해당 디렉터리의 HEAD를 최신 main으로 가정하지 않는다.
- 가장 최근 테스트 수정 작업 트리:
  `/Users/justn/.herdr/worktrees/rapi-agent/fix-harness-pin-contract`, 브랜치 `fix/harness-pin-contract`.
  작업 종료 때 이 트리의 파일 내용은 `origin/main`과 동일했고 tracked 변경은 없었다.
- 기존 Git 프로젝트 작업은 전용 작업 트리에서 한다. 사용자 dirty 파일과 `.brgr` 결과물을 보존한다.
  `git stash`, 임의 reset, 작업 트리 삭제는 하지 않는다. `HERDR_ENV=1`이면 Herdr worktree 명령을 따른다.
- VM: `ssh rapi-agent`, 사용자 `justn`, 비밀번호 없는 sudo, 로그인 셸 zsh.
- 공개 주소: `https://rapi-07ab7899e00f.justn.me`.
- 소유자는 한국어를 쓴다. 짧게 보고하고, 확인 요청을 구현·배포 권한으로 확대하지 않는다.
  구현 요청은 검증까지 진행하되 로그인·2단계 인증 등 소유자만 할 일은 대신하지 않는다.

## 3. 이전 인수인계에서 이미 완료돼 있던 것

- #33/#34: 제품 방향 문서와 여러 Discord 서버, 학습자 DM 실험, 하네스 어댑터/갱신,
  모델 API·비용 집계, 웹 포털, 블로그·초안, 메일, GitHub App, 아카이브 챗봇 등의 기능 반영.
- #36: 토스페이먼츠 30일 기간권 구현. 이전 인수인계에 따르면 공개 테스트 키로 로컬 결제·환불 확인.
  운영 결제는 비활성이다.
- #37/#38: 별도 Go/Chromium 크롤러와 `@rapi/crawler-client` 제거.
  피드가 없는 페이지는 `html` 수집원으로 처리한다.
  큰 응답 스냅샷 정리를 배포 마이그레이션 밖으로 옮기고, 스키마 롤백 실패 때도 직전 릴리스를 복원하도록 수정.

## 4. 이번에 완료한 작업

### 크롤러 정리

- `scripts/cleanup-response-snapshots.mjs` 시험 실행에서 삭제 대상 0건을 두 번 확인했다.
  이번 작업 시작 때 이미 0건이었으므로, 28,148건을 이번 실행이 직접 삭제했다고 표현하지 않는다.
- 운영 중 `VACUUM (ANALYZE) raw_events` 완료. 마지막 확인에서 `n_dead_tup=0`.
  일반 VACUUM은 공간 재사용을 위한 것이며 파일 크기를 줄이는 작업은 아니다.
- VM `.env`를 백업한 뒤 `CRAWLER_ENDPOINT`, `CRAWLER_CALLER_TOKEN` 제거. 이후 실제 Node 환경에서도 부재 확인.
- `rapi-crawler-controller`, `rapi-crawler-browser`, `rapi-crawler-auto-deploy.timer`는 disabled/inactive 확인.
- `justn-hyeok/rapi-crawler`는 소유자에게 한 줄 알린 뒤 archive했고 결과를 확인했다.
- Anthropic 뉴스는 `html`, active, 실패 0건, 자료 19건.
  마지막 수집 성공 시각이 UTC 16:25:44 → 16:42:38 → 16:57:28로 갱신됨을 확인했다(2026-10-25).

### 모델 가격표 — [#39](https://github.com/justn-hyeok/rapi-agent/pull/39)

- `ops/model-prices.json`에 소유자가 지정한 fallback 가격 추가(100만 토큰당 USD):
  - `claude-haiku-5-5`: 입력 0.10, 출력 0.50.
  - `claude-sonnet-5-5`: 입력 2, 출력 10.
- CI 통과 후 squash 머지·운영 배포 확인.
- VM 환경 파일을 백업하고 `MODEL_PRICES_FILE` 임시 override 제거. 기본 레포 가격표 사용 확인.
- 월 상한은 임시 `$20` 유지. 소유자가 바꾸라고 하지 않으면 변경하지 않는다.

### 브라우저 조사 — [#40](https://github.com/justn-hyeok/rapi-agent/pull/40)

- 전용 `agent-browser` 0.39.2를 이용하는 소유자 요청형 조사 기능 구현·머지·배포.
- 운영자 서버의 비공개 ChatOps에서 SUPERADMIN이 다음처럼 요청하는 경로다:
  `라피야! 브라우저 조사: threads` (`x`, `reddit`도 가능).
- 서비스에서도 소유자 ID, Discord 출처, 홈 서버, 비공개 채널 조건을 확인한다.
  공개 챗봇·GitHub App·웹훅에서 브라우저 조사를 시작하는 경로는 없다.
- 기본 거부 액션 정책. 고정 피드 탐색·snapshot·고정 스크롤·종료만 허용하고,
  클릭·입력·폼 제출·eval·업로드·다운로드·WebMCP 실행을 차단한다.
- 사이트별 정확한 네트워크 허용 목록. 페이지 문자열은 데이터로만 모델에 전달하며,
  모델은 `scroll`/`stop`만 선택한다. 페이지나 모델이 만든 명령·탐색 URL을 실행하지 않는다.
- 요청당 최대 20개 관찰 글 URL, 최대 120초, 최대 3회 관찰/2회 스크롤.
  이동하는 24시간 예약량은 X 180개, Threads/Reddit 각 100개. 실패해도 예약량을 반환하지 않는다.
  플랫폼의 프리페치·자체 읽음 집계까지 정확히 통제한다는 보장은 아니다.
- 결과는 `kind='aside'`, `visibility='private'`, `ownerId`가 있는 수집원에 저장.
  공개 발송·아카이브·챗봇 배제 규칙을 재사용한다. 소유자가 고른 것만 이후 콘텐츠에 활용한다.
- `browser_research_runs`에 요청 중복 방지, 예약량, 관찰 URL/digest, 저장 URL, 종료 상태 기록.
- 마이그레이션 `0030_browser_research.sql`과 반복 가능한 롤백 파일을 함께 추가했다.
- 문서: `docs/browser-research.md`. 정책: `ops/browser-research/`.

### 브라우저 겹침 버그 — [#41](https://github.com/justn-hyeok/rapi-agent/pull/41)

- 1~15번 글을 본 다음 11~20번 화면을 보면, 이미 본 11~15번이 남은 한도를 차지해
  새 글을 모두 놓치던 버그를 수정했다.
- `researchWindow`에 이미 본 URL 집합을 전달하고 새 URL만 남은 한도에서 계산한다.
- 회귀 테스트는 수정 전 0건 저장으로 실패했고 수정 후 통과했다.
  새 글 16~20번을 읽고 21번은 제외하며 전체 한도도 지키는 것을 확인했다.
- 테스트 526개·CI 통과 후 머지·배포. 운영에 배포된 함수로도 같은 회귀 검증을 통과했다.

### 하네스 갱신 CI — [#43](https://github.com/justn-hyeok/rapi-agent/pull/43)

- 자동 생성된 senpi 갱신 PR #42가 실패한 원인은 `tests/harness.test.ts`가
  `2026.10.21-3`이라는 과거 버전을 정확히 강제했기 때문이다.
- 특정 버전 비교와 사용하지 않는 변수만 제거했다.
  버전 형식·저장소 형식·Linux 배포 파일명·64자리 SHA-256 검증은 유지했다.
- 기존 pin과 #42의 실제 새 pin 모두 통과했고, 잘못된 버전·체크섬·파일명은 계속 거부했다.
  로컬 전체 검사 526개 통과. #43 CI 통과 후 머지·배포했다.
- #42에 최신 main을 합쳤고, 새 head `642778301e751be2125f4eaf0162134feed062c5`의 CI도 모두 통과했다.
- #42 자체는 OPEN 상태로 남겼고 새 senpi 설치는 하지 않았다.

## 5. 현재 켜진 기능과 의도적으로 꺼 둔 기능

마지막 실제 `loadEnvironment()` 조회 기준:

- 켬: `LEARNER_EXPERIMENT_ENABLED`, `BLOG_PUBLISH_ENABLED`, `BLOG_DRAFTS_ENABLED`,
  `HARNESS_UPDATES_ENABLED`, `WEB_ENABLED`, `EMAIL_ENABLED`, `GITHUB_APP_ENABLED`,
  `CHATBOT_ENABLED`, `CHATBOT_L2_ENABLED`.
- 끔: `BROWSER_RESEARCH_ENABLED`, `BILLING_ENABLED`.
- 월 모델 상한: `$20`.

기능 플래그가 켜져 있다는 사실만으로 실제 구독·발송·게시·외부 연동의 사용자 검증이 끝났다고 말하지 않는다.

## 6. 실제 계정 검증 — 로그인 필요로 보류

- 소유자가 Threads·X·Reddit용 새 계정을 준비하고 전용 브라우저에서 직접 로그인/2단계 인증해야 한다.
- 개인 Aside·Chrome 프로필은 건드리지 않는다. 실제 계정으로 로그인하거나 상태를 이전한 시험은 아직 하지 않았다.
- 소유자의 **“로그인함” 신호를 받은 뒤** 에이전트가 상태 저장·안전한 복사·VM 로그인 유지 검증을 진행한다.
  소유자에게 상태 파일 복사 같은 실행 가능한 작업을 떠넘기지 않는다.
- 인증 JSON·쿠키·토큰·키는 출력, 커밋, 문서 포함 금지. 인증 파일 권한은 600.
- 중요한 구현 차이: 0.39.2는 `--allowed-domains`와 `--state`/`--profile` 동시 사용을 거부한다.
  현재 래퍼는 새 격리 빈 컨텍스트에 검증한 쿠키를 넣고, 페이지를 열기 전에 읽기 전용 정책으로 바꾼다.
  `localStorage`는 재생하지 않으므로 실제 사이트별 로그인 유지는 별도로 검증해야 한다.
- VM 인증 자료 경로 설정: `BROWSER_RESEARCH_AUTH_DIR`, 기본 `/home/justn/secrets/browser-research`.
  사이트별 `<threads|x|reddit>.json`을 읽는 코드다. 실제 인증 자료 준비 여부를 추정하지 않는다.
- VM에서 가짜 쿠키로만 검증한 사항: sandbox 시작, 쿠키 초기화, snapshot,
  이후 쿠키 접근 거부, 외부 도메인 차단, eval/click/fill/press/download/upload 각각 거부.
  가짜 `__Host-` 쿠키의 호스트 범위·Secure·HttpOnly도 확인했다. 이는 실제 계정 검증의 대체가 아니다.
- VM의 `/etc/apparmor.d/rapi-browser`에 전용 Chromium 실행 파일의 user namespace 허용 프로필을 설치했다.
  소스는 `ops/browser-research/apparmor.profile`. Chromium 갱신 때 실행 파일 경로를 확인한다.
  `--no-sandbox`, 시스템 전체 제한 해제, 스텔스·지문/헤더 위장으로 우회하지 않는다.
- 로그인/차단/인증 요구가 나오면 중단한다. 읽기 전용·도메인·시간/글 수·비공개 저장 검증을 마친 뒤 활성화를 판단한다.

## 7. 가장 최근 소유자 의견 — 미확정 사항을 확정으로 취급하지 말 것

### 학습자 실험 기간

- 기존 제품 문서에는 학습자 5명 이상, 3주 실험이 있다.
- 소유자는 **3주는 너무 길다**고 말했다.
- 에이전트는 먼저 3회 발송해 유용성·다음 호 수신 의향·적절한 빈도를 확인하자고 제안했다.
- 이 3회 안은 아직 확정·구현되지 않았다. 실험 정책이나 문서를 바꾸지 않았다.
  다음 대화에서 기존 3주 안을 소유자가 다시 동의한 것처럼 설명하지 않는다.
- 학습자 발송을 자동으로 전환할 기준도 미정이다. 임의로 정하거나 자동 발송으로 바꾸지 않는다.

### n8n / LangChain / LangGraph

- 소유자는 **포트폴리오용으로 세 도구를 쓰는 기능이 추가되기를 원한다**고 밝혔다.
- 에이전트는 n8n의 외부 연결/자동화, LangChain의 자료 검색, LangGraph의 단계·승인·재개를
  묶은 “출처가 붙은 입문 가이드 제작 흐름”을 제안했다.
- 소유자는 그 구현을 승인하지 않고, **지금까지 정리한 이 루트 문서 작성**을 요청했다.
- 기능 범위는 미확정이다. 세 도구를 이용한 기능 구현·설치·새 서비스 배포는 이번 대화에서 하지 않았다.
  현재 workspace package manifests에서도 관련 의존성은 발견되지 않았다.
- 제안한 가이드 파이프라인을 확정 요구사항으로 삼거나 임의로 착수하지 않는다.

## 8. CI·운영 증거와 남은 PR

- [#43 main CI](https://github.com/justn-hyeok/rapi-agent/actions/runs/40244849419): 모두 성공.
- [#42 갱신 후 CI](https://github.com/justn-hyeok/rapi-agent/actions/runs/40244885368): 모두 성공.
- 최신 전환 receipt: `/home/justn/rapi-releases/switch-d7c7217-*.json`.
  `status=switched`, `finishedAt=2026-10-25T23:30:31.578Z` 확인.
- 직전 릴리스: `/home/justn/rapi-releases/rapi-06e90b72c1e2-fa096v`.
- 열려 있는 PR:
  - [#42](https://github.com/justn-hyeok/rapi-agent/pull/42): senpi `2026.10.25-3` pin 갱신. CI 통과, 미머지.
  - [#35](https://github.com/justn-hyeok/rapi-agent/pull/35): 이전 senpi `2026.10.25-2` 갱신. 오래된 CI 실패 기록 있음.
  - [#10](https://github.com/justn-hyeok/rapi-agent/pull/10): 예전 로그인 수집원 관련 변경.
  - 오래된 PR은 현재 구현과 중복·충돌 여부를 확인해야 한다. 임의 merge/close하지 않는다.
- 이전 실패 알림과 최신 실패를 구분한다. 실행 SHA·브랜치·최신 attempt를 먼저 확인한다.
  #40 초기 E2E SQL 조인 오류는 수정됐고, #42의 과거 버전 고정 실패도 해결됐다.
- #41 main CI에서는 Ubuntu 패키지 다운로드가 느려 Chromium 설치가 6분 넘게 지연됐다.
  그 작업을 취소하고 실패 작업만 새 러너에서 한 번 재실행한 뒤 전체 성공을 확인했다.
  당시 성공 기록은 run `40214932526`, attempt 2다.

## 9. 다음 에이전트가 지킬 운영 경계

- **결제를 켜지 않는다.** 소유자가 “사업자 등록 끝났다”고 하기 전까지 `BILLING_ENABLED` 활성화,
  공개 가격 노출, Toss live 키 설정을 하지 않는다.
- 서비스 환경 파일은 `/home/justn/rapi-agent/.env`, public-agent 환경 파일은 `/etc/rapi-public-agent.env`다.
  변경 시 먼저 `.env.bak-<시각>` 등으로 백업한다. 값은 출력하지 않는다.
- 비밀값 폴더는 `/home/justn/secrets/`. Resend 웹훅 GET 응답의 `signing_secret`도 출력 금지다.
- main의 CI가 통과하면 `rapi-auto-deploy.timer`가 약 5분마다 배포한다. 머지는 곧 운영 변경이다.
  반드시 `verify`, `secret-scan`, `blog-browser`를 확인하고, 배포는 journal·receipt의 `finishedAt`·
  실제 서비스 상태·외부 응답으로 확인한다. `current` 링크나 명령 성공만으로 완료라 하지 않는다.
- 자동 전환 대상은 bot/chat/monitor/worker다. gateway/tunnel/public-agent 변경은 별도 재시작 여부를 챙긴다.
  public-agent 코드 변경 시 `npm run public-agent:install`도 확인한다.
- 새 마이그레이션은 운영의 최대 번호를 먼저 확인하고 다음 번호를 쓴다. 현재 마지막은 0030이다.
  반드시 반복 가능한 rollback 파일을 함께 둔다.
- 큰 테이블 삭제를 마이그레이션 안에서 하지 않는다. 온라인 스크립트로 작은 배치로 처리한다.
- 전환 실패 시 receipt의 `previousPath`를 기준으로 정상 릴리스와 서비스를 복구한다.
  `pgrep -f switch-release.mjs`는 자기 셸을 잡을 수 있으므로 완료 판정에 쓰지 않는다.
- 크롤러와 OMP를 다시 도입하지 않는다.
- `tests/public-agent-runtime.test.ts` 시간 기반 테스트가 부하로 간헐 실패한 전례는 있다.
  실패를 무조건 flaky로 치부하지 말고 로그와 단독 재현을 확인한다.
- 테스트/빌드 실패의 exit status를 숨기지 않는다. `git stash`는 사용하지 않는다.

이 문서를 읽었다는 이유로 추가 구현·배포·로그인·PR 정리 권한이 생기는 것은 아니다.
새 소유자 요청의 범위 안에서 진행한다.
