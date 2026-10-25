# 소유자 브라우저 조사

전용 새 계정으로 Threads·X·Reddit 피드를 사람이 요청할 때만 읽는다.
스케줄러, GitHub App, 공개 챗봇, 웹훅에는 시작 경로가 없다.
운영자 서버의 비공개 `라피-관리` 채널에서 SUPERADMIN만
`라피야! 브라우저 조사: threads` (`x`, `reddit`)로 요청한다.
서비스에서도 Discord 출처, SUPERADMIN ID 목록, 홈 서버, 비공개 채널을 다시 확인한다.

`BROWSER_RESEARCH_ENABLED` 기본값은 false다. 전용 계정 로그인 및 실제 피드 검증 전에는
계속 꺼 둔다. 현재 실제 로그인과 로그인 상태 이전 시험은 **로그인 필요로 보류**다.
개인 Aside·Chrome 프로필은 사용하지 않는다.

## 실행 경계

- `ops/browser-research/sites.json`: 고정 피드 URL, 정확한 네트워크 도메인 목록,
  요청당 최대 20개 글 URL, 최대 120초. X는 이동하는 24시간 동안 최대 180개,
  Threads·Reddit은 100개를 예약한다. 실패·중단도 예약량을 돌려주지 않는다.
- 전체 피드의 렌더링 자체가 읽음으로 집계될 수 있으므로 플랫폼 자체의 노출 수를
  정확히 보장하지는 않는다. 모델에 전달하는 글 URL 수는 코드로 제한하며,
  최대 세 번의 화면 관찰과 두 번의 느린 스크롤만 허용한다.
- `ops/browser-research/policy.json`: 기본 거부. 브라우저 시작, 고정 URL 탐색,
  snapshot, 고정 거리 스크롤, 종료만 허용한다. 클릭·키 입력·폼 제출·업로드·다운로드·
  eval·WebMCP 실행은 불가능하다. 모델은 `scroll`/`stop`만 고를 수 있다.
  페이지나 모델이 만든 URL은 탐색에 사용하지 않는다.
- 실행마다 새 세션·네임스페이스·임시 설정을 사용한다. 부모의 브라우저 환경변수,
  확장, 프록시, 헤더, 연결된 CDP 세션과 프로필을 상속하지 않는다. WebMCP도 끈다.
- 페이지 문자열은 JSON 데이터로 모델에 전달한다. 모델 출력은 엄격한 스키마로
  검사하며, 현재 관찰에 있던 해당 사이트의 글 URL만 저장한다.
  임의 동작, 명령, 셀렉터, 도메인을 실행할 인터페이스가 없다.
- `browser_research_runs`는 요청 중복, 24시간 예약량, 본 글 URL, 관찰 digest,
  저장 URL, 종료 상태를 기록한다. 공개 API 역할에는 테이블 권한을 주지 않는다.
- 결과는 `kind='aside'`, `visibility='private'`, `ownerId`가 있는 수집원에 저장한다.
  기존 공개 발송·아카이브·챗봇 배제 규칙을 그대로 쓴다. 원래 관찰 텍스트도
  선택된 자료의 비공개 metadata에 보존한다. 자동 발행이나 학습자 전송은 하지 않는다.

## 전용 인증 자료와 VM 준비

agent-browser 0.39.2는 `--allowed-domains`와 `--state`/`--profile`을 함께 쓰면 거부한다.
따라서 상태 JSON을 그대로 재생하지 않는다. 인증을 준비할 때만 소유자가 만든
`BROWSER_RESEARCH_AUTH_DIR/<threads|x|reddit>.json`의 쿠키를 검증한다(파일 권한 600,
1 MB 이하, 허용 도메인만). 새 격리 브라우저를 빈 화면으로 시작한 뒤
짧은 초기화 정책에서 쿠키 속성을 보존해 넣고, 페이지를 열기 전에 읽기 전용
정책으로 바꾼다. localStorage는 재생하지 않으므로 사이트에 따라 재로그인이 필요하다.
인증 자료와 CLI 오류 원문은 로그·모델·답변에 전달하지 않는다.

Ubuntu VM에서 다운로드한 Chromium은 AppArmor 때문에 sandbox 시작이 거부될 수 있다.
`ops/browser-research/apparmor.profile`을 `/etc/apparmor.d/rapi-browser`로 설치하고
`sudo apparmor_parser -r /etc/apparmor.d/rapi-browser`로 적용한다. 이 프로필은
현재 전용 Chromium 실행 파일에만 user namespace를 허용한다. `--no-sandbox`나
시스템 전체 user namespace 제한 해제는 사용하지 않는다. Chromium을 갱신하면
실행 파일 경로를 확인하고 프로필을 함께 갱신한다.

차단·인증 요구가 나타나면 종료한다. 지문·헤더 위장이나 스텔스 플러그인은 쓰지 않는다.
허용 도메인 목록을 넓혀 우회하지 않는다. 로그인 없는 정책 검증에는 가짜 쿠키와
빈 화면만 쓰며 실제 계정 인증 시험으로 간주하지 않는다.

## 검증

`npm run check`는 권한 경계, 페이지 인젝션, 잘못된 모델 동작, 관찰되지 않은 URL,
비공개 저장, 로그인 보류, ChatOps 분기를 검사한다. `npm run test:e2e`는 실제 PostgreSQL에서
동시 예약·요청 중복·실패 후 한도를 확인한다. 마이그레이션은 `0030_browser_research.sql`,
반복 가능한 롤백은 `packages/db/rollbacks/0030_browser_research.sql`이다.
