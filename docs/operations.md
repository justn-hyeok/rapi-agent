# 운영, 권한, 보안

## 1. 필요한 외부 자원

### 필수

- Linux VM 한 대와 SSH 관리 권한
- 공식 Discord application/bot과 대상 서버 또는 DM 사용 권한
- 전용 GitHub 계정과 필요한 저장소·조직 권한
- 전용 이메일 계정의 SMTP 또는 발송 API 권한
- 요약·분류에 사용할 모델 공급자 인증

### 공개 블로그 운영 시

- 도메인과 DNS 변경 권한
- 정적 호스팅 또는 VM reverse proxy/TLS 구성 권한
- 블로그 Git 저장소와 배포 인증

### 출처에 따라 선택

- GitHub App 또는 fine-grained token
- 웹훅 발신자별 shared secret
- S3 호환 object storage

## 2. 최초 사용자 작업

다음은 계정 소유자만 수행할 수 있어 사용자가 최초 한 번 제공하거나 승인해야
한다.

1. Discord Developer Portal에서 application과 bot을 만들고 필요한 서버에
   초대한다.
2. VM SSH 공개키를 등록하고 배포 대상 호스트·사용자를 알려준다.
3. GitHub 전용 계정에 필요한 저장소·조직 권한을 부여한다.
4. 이메일 계정에서 앱 비밀번호 또는 제한된 발송 자격 증명을 발급한다.
5. 모델 공급자의 프로젝트와 비용 한도를 설정한다.
6. 블로그 공개 시 도메인 DNS 레코드 변경을 승인한다.

토큰 원문은 Discord나 Git 이력에 보내지 않는다. 가능하면 VM에서 직접 입력하거나
비밀 관리 도구로 주입한다.

## 3. 최소 권한 표

| 주체 | 허용 권한 | 기본 금지 |
| --- | --- | --- |
| Discord bot | 서버 구성 적용을 위한 Administrator, 명령·역할·채널·웹훅 관리 | 사용자 계정 로그인, 애플리케이션 SUPERADMIN 승격 |
| GitHub 수집 | metadata/content read, issues/PR read | 저장소 write |
| GitHub 실행 | 작업별 승인된 repo write/PR 범위 | 조직 관리자, 무관 저장소 접근 |
| 이메일 | 지정 발신자 주소의 send | mailbox 전체 읽기 |
| 블로그 배포 | 지정 repo/배포 대상 write | 다른 사이트·도메인 변경 |

GitHub 읽기와 쓰기 자격 증명은 분리한다. 평상시 수집 프로세스는 쓰기 토큰에
접근하지 않는다. GitHub App을 사용할 때는 [공식 권한 문서](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)를
기준으로 필요한 webhook과 API별 최소 권한을 선택한다.

## 4. 비밀값 목록

구현 시 실제 변수명은 확정하되 범주는 다음과 같다.

- Discord bot token, application/public key, allowed user/guild/channel IDs
- database URL과 backup 자격 증명
- GitHub App key 또는 token
- SMTP/API endpoint, username, app password, sender address
- 모델 공급자 API key와 프로젝트 ID
- 웹훅 source secret
- 블로그 배포 key와 object storage 자격 증명

저장소에는 값이 없는 `.env.example`만 둔다. 운영 비밀은 읽기 권한이 제한된
환경 파일, systemd credential, 또는 별도 secret manager에 둔다. 로그와 오류
보고서에는 토큰, Authorization header, 쿠키, 원문 credential을 남기지 않는다.

## 5. VM 기준 구성

초기 단일 VM 배치는 다음 프로세스로 충분하다.

- `rapi-bot`: Discord Gateway와 명령 처리
- `rapi-worker`: 수집, 분류·요약, 발송 worker
- `rapi-scheduler`: cron/예약 작업 enqueue
- `rapi-blog`: 정적 빌드 또는 웹 서버
- PostgreSQL: 같은 VM 또는 관리형 서비스
- reverse proxy: HTTPS와 공개 webhook/blog endpoint

프로세스는 전용 OS 사용자로 실행하고 자동 재시작, resource limit, health check를
설정한다. DB와 공개 웹 포트를 제외한 내부 서비스는 외부에 노출하지 않는다.

## 6. 배포 절차

릴리스 후보를 서비스 전환 없이 준비할 때는 깨끗한 후보 checkout에서 전체 SHA와
기존 스테이징 루트 디렉터리를 명시한다. `deploy-revision.sh`는 Git archive로
비밀값 없는 revision을 별도 디렉터리에 풀고, 새 `npm ci`와 check, proxy,
격리 E2E·restart·restore, audit를 모두 통과한 경우에만
`release-manifest.json`을 쓴다. 실패한 스테이징 디렉터리는 조사할 수 있도록 남긴다.
이 단계는 서비스를 교체하거나 worker를 재시작하지 않는다.

```bash
RAPI_RELEASE_SHA="$(git rev-parse HEAD)" \
RAPI_RELEASE_ROOT=/absolute/existing/staging-directory \
  ./scripts/deploy-revision.sh
```

manifest에는 원본·빌드 파일의 digest와 migration 목록도 들어간다.
`scripts/switch-release.mjs`는 후보와 이전 artifact를 검증하고, 현재 실행 중인
서비스만 중지·전환·재시작한다. `/ready`의 기동 시점 revision과 readiness가
일치해야 전환을 인정하며 실패하면 이전 artifact로 돌아가 같은 검사를 수행한다.
이미 중지된 worker는 이 절차나 터널 구성으로 자동 재시작하지 않는다.

승인된 baseline/current pointer를 만든 뒤 `release-units.mjs --preview`로
unit 연결안을 확인한다. `--apply`는 기존 drop-in을 receipt에 보존하고 원자적으로
교체한 뒤 daemon-reload만 수행한다. 실패하면 이전 drop-in을 복구하며, 이 명령은
서비스를 재시작하지 않는다.

```bash
RAPI_CURRENT_RELEASE=/home/justn/rapi-releases/current \
RAPI_SERVICE_ENV_FILE=/home/justn/rapi-agent/.env \
  node scripts/release-units.mjs --preview

# 운영 승인 후 root 권한으로 실행한다.
RAPI_RELEASE_UNITS_APPROVED=true \
RAPI_RELEASE_UNITS_RECEIPT=/absolute/evidence/unit-wiring.json \
RAPI_CURRENT_RELEASE=/home/justn/rapi-releases/current \
RAPI_SERVICE_ENV_FILE=/home/justn/rapi-agent/.env \
  node scripts/release-units.mjs --apply
```

monitor는 중지된 worker의 경고를 계속 보고하므로, 배포 전환에서는 monitor의
`/health`와 기동 revision을 검사한다. 나머지 활성 애플리케이션은 `/ready`를
검사한다. monitor 경고를 지우거나 중지된 worker를 켜서 검사를 통과시키지 않는다.

```bash
RAPI_SWITCH_APPROVED=true \
RAPI_CURRENT_RELEASE=/absolute/releases/current \
RAPI_CANDIDATE_RELEASE=/absolute/releases/candidate-directory \
RAPI_RELEASE_SHA=full-40-character-candidate-sha \
RAPI_SWITCH_RECEIPT=/absolute/evidence/switch-receipt.json \
RAPI_SERVICE_ENV_FILE=/home/justn/rapi-agent/.env \
RAPI_SWITCH_SERVICES=bot,chat,monitor,worker \
  node scripts/switch-release.mjs
```

운영 승인을 받은 뒤에만 실행한다. current는 기존 symlink여야 하고, 이전
artifact에도 검증 manifest가 있어야 한다. 두 revision의 migration 목록이 다르면
자동 전환을 거부한다. 각 systemd unit의 WorkingDirectory가 current를 가리키고
ExecStart가 별도 보관한 운영 환경 파일을 읽도록 사전 설정해야 한다. 처음
도입하는 서버는 이전 코드의 실행 revision·호환성을 기록한 승인된 baseline
전환이 먼저 필요하다. 구 서비스에 manifest가 없다는 이유로 검사를 생략하지 않는다.

### 자동 배포

`rapi-auto-deploy.timer`가 5분마다 `scripts/auto-deploy.sh`를 실행한다. origin/main의
새 SHA에 대한 GitHub check run이 모두 성공하면, 그 SHA의 임시 worktree에서 위의
`deploy-revision.sh` 검증과 `switch-release.mjs` 전환을 그대로 수행하고 결과를
`OPERATIONS_CHANNEL_ID`로 알린다. CI나 검증·전환이 실패한 SHA는
`.auto-deploy-failed`에 기록하고 다음 SHA까지 다시 시도하지 않는다. 전환 실패 시
롤백은 `switch-release.mjs`가 수행한다. 성공하면 push되지 않은 커밋이 없는 경우에만
소스 체크아웃을 main으로 맞추고(로컬 수정 유지), 현재·직전 릴리스를 제외한 오래된
스테이징 디렉터리를 정리한다. 서비스에는 운영 환경 파일을 주입하지 않는다.
ChatOps의 코드 변경은 체크아웃에 직접 커밋하지 않고 브랜치와 PR로 main에 들어온다.

공개 커뮤니티 `1545832299671847013`의 준비된 구성은
`config/discord-community-1545832299671847013.yaml`과
`docs/evidence/community-plan-20260928.json`이다. 기존 ADMIN 역할을 채택하고
기존 채널을 삭제하지 않는다. 봇 관리자 권한·역할 순서와 공개 실행기 전용
로그인을 확보한 뒤, 배포된 `DiscordLayoutManager.preview/apply`로 fresh plan을
확인·적용한다. 저장된 snapshot은 사전 검토용이며 그대로 재사용하는 승인 토큰이 아니다.

역할·채널 적용 후 공개 대화 접근 설정을 독립적으로 준비할 수 있다. 이 명령은
RSS·이메일·GitHub 등록을 요구하지 않으며, 별도 실행기 활성화까지 자동 수행하지 않는다.

```bash
COMMUNITY_GUILD_ID=1545832299671847013 \
  node --env-file=.env --import tsx scripts/configure-public-community.ts --preview

# 운영 승인 후 역할/채널 ID를 환경 파일에 반영한다.
RAPI_COMMUNITY_APPROVED=true COMMUNITY_GUILD_ID=1545832299671847013 \
  node --env-file=.env --import tsx scripts/configure-public-community.ts --apply
```

공개 실행기 전용 로그인은 설치된 전용 계정에서 진행한다. 장치 승인 단계는
소유자가 직접 수행한다. 승인된 실제 질문이 성공한 뒤 공개 기능을 활성화하고
USER/ADMIN/SUPERADMIN의 허용·거부 흐름을 각각 확인한다.

```bash
sudo -u rapi-public env HOME=/var/lib/rapi-public \
  CODEX_HOME=/var/lib/rapi-public/codex \
  /opt/rapi-public-agent/codex login --device-auth
```

1. CI가 typecheck, lint, unit/integration test, migration 검사를 수행한다.
2. 불변 revision 또는 image tag를 만든다.
3. DB 백업과 migration dry-run 결과를 확인한다.
4. worker 소비를 일시 중지하고 migration을 적용한다.
5. 앱을 교체하고 health/readiness를 확인한다.
6. Discord 명령, 수집, 테스트 발송, 블로그 smoke를 실행한다.
7. 실패하면 직전 revision으로 앱을 되돌리고 호환 가능한 복구 절차를 실행한다.

배포 성공은 프로세스가 떠 있는 것만으로 판단하지 않는다. 실제 Discord 명령과
수집→저장→발송 경로의 smoke가 필요하다.

## 7. 백업과 복구

- PostgreSQL 자동 일일 백업과 보존 기간 설정
- 대형 원본 저장소의 versioning 또는 snapshot
- 비밀값을 제외한 운영 설정과 migration은 Git으로 관리
- 월 1회 별도 위치에 복구해 무결성 검사
- 복구 목표 시점(RPO)과 목표 시간(RTO)은 실제 데이터 증가량을 본 뒤 확정

백업 생성 로그만으로 복구 가능성을 증명하지 않는다. 빈 환경에서 복원하고 주요
레코드와 앱 기동을 확인해야 한다.

## 8. 모니터링과 알림

Discord 운영 채널 또는 DM으로 아래 상황을 알린다.

- 수집원이 연속 실패하거나 예상 주기보다 지연됨
- 큐 적체와 worker 중단
- DB 용량, VM 디스크, 메모리 임계치 초과
- 이메일·Discord 발송 실패율 증가
- 모델 비용 한도 접근 또는 초과
- 승인 대기 작업 만료
- 백업 또는 복구 점검 실패

알림 자체의 폭주를 막기 위해 동일 원인의 집계, cooldown, 복구 알림을 적용한다.

## 9. 승인 정책 초안

### 자동 실행 가능

- 허용된 출처의 읽기 전용 수집
- 이미 승인된 구독에 따른 DM/이메일 발송
- 비공개 MDX 초안 생성
- 조회, 검색, 상태 확인

### 최초 정책 승인 후 자동화 가능

- 사용자가 출처, 카테고리, 템플릿, 공개 범위, 기간을 한정해 승인한 정책과 정확히
  일치하는 예약 블로그 게시
- 지정 저장소의 이슈·프로젝트 정리
- 실패한 멱등 작업의 제한적 재시도

### 매번 명시적 승인

- 코드 commit/push, PR 생성·병합, 배포
- 승인된 자동 게시 정책 밖의 최초 공개 또는 모든 공개 범위 확대
- 새로운 수신자에게 이메일 발송
- 유료 자원 생성, 비용 한도 상향
- 자격 증명·권한·DNS 변경
- 데이터의 영구 삭제

승인은 대상, 동작, 유효 기간, 최대 비용 또는 변경 범위를 포함한다. 일부 동작에
대한 승인을 다른 동작으로 확대 해석하지 않는다.

자동 게시 정책은 만료 시각을 가져야 하며, 새 출처·새 템플릿·새 카테고리는 기존
정책에 자동 포함하지 않는다. 개별 글을 승인한 것은 이후 글의 포괄 승인으로
간주하지 않는다.

## 10. 운영 인수 체크리스트

- [ ] Discord bot이 허용된 사용자와 채널에서만 응답한다.
- [ ] self-bot 또는 개인 계정 토큰이 없다.
- [ ] 저장소와 빌드 산출물에 비밀값이 없다.
- [ ] GitHub 읽기/쓰기 권한이 분리됐다.
- [ ] 테스트 이메일과 실제 발송 대상이 분리됐다.
- [ ] HTTPS와 webhook signature 검증이 적용됐다.
- [ ] 재시작 후 queue와 수집 cursor가 복구된다.
- [ ] 같은 이벤트와 발송을 재시도해도 중복되지 않는다.
- [ ] DB 백업을 별도 환경에서 실제 복원했다.
- [ ] 공개 MDX 빌드에서 비공개 콘텐츠가 제외된다.
- [ ] ChatOps 실행마다 시도와 결과 증거가 기록된다.

## 11. 구현된 운영 명령

```bash
npm run bootstrap       # 설치, DB, migration, 전체 검증
npm run db:migrate      # 미적용 migration 적용
npm run backup          # backups/ 아래 권한 0600 SQL dump 생성
npm run restore:smoke   # 격리된 임시 DB로 실제 복구 검증
npm run restart:smoke   # PostgreSQL 재시작 전후 핵심 count 검증
npm run start:bot       # Discord interaction/webhook 서버
npm run start:worker    # GitHub/RSS 수집과 배치 발송 worker
npm run start:monitor   # 독립 health 감시와 장애·복구 알림
npm run db:migrate      # 로컬 또는 Supabase 지정 DB migration
npm run backup          # 원자적 custom-format dump와 최근 7개 보존
```

서비스 프로세스는 reverse proxy 뒤에서 실행하며 `/health`를 readiness 확인에 쓴다.
Docker volume `rapi-postgres`는 애플리케이션 컨테이너 교체와 분리해 보존한다.

## 자연어 ChatOps 운영 정책 (D-008)

허용된 소유자의 명확한 자연어 변경·배포 요청은 그 자체로 실행 권한이며 반복
승인을 요구하지 않는다. 이는 위 승인 초안의 자연어 ChatOps 경로를 대체한다.
`/작업`·`/승인`은 기존 동작을 유지한다. 배포 시 기존 `npm run db:migrate`가
0004를 적용한 뒤 기존 `rapi-chat.service`를 사용한다. 이번 구현 작업에서는
운영 전환은 [커뮤니티 운영 전환](operations-webhooks.md)의 drain, 백업, readiness
rollback 절차를 따른다.

`npm run test:e2e`는 `compose.test.yaml`의 임시 PostgreSQL을 임의 로컬 포트에
기동하고 **rapi_test만** 사용한다. migration 재적용도 검사하며 EXIT trap으로
컨테이너·네트워크를 정리한다. 운영 Compose 또는 DB에는 연결하지 않는다.
테스트를 직접 실행할 때도 정확히 `rapi_test` 이름이 아니면 거부한다.
상태 조회, 실제 취소, interrupted 복구와 알려진 한계는
[운영 상세](chatops-capabilities.md)를 참고한다.

기본 실행 모델은 `gpt-5.6-sol`이다. 명시적인 `스파크로 …`는 Spark를 그대로 선택하므로 계정 지원 여부를 확인해야 한다. ChatOps 요청의 `아스트라로 …`,
`…, 모델: gpt-6-astra`로 실행별 모델을 지정한다.
선택 결과는 ChatOps 실행 행에 저장한다.

## senpi 하니스 (선택)

senpi는 소유자 실행 전용 두 번째 하니스다(동작은 [ChatOps 기능](chatops-capabilities.md)
참고). 고정 버전은 `ops/harness-versions.json`이다.

```bash
# 1. VM에서 설치: 릴리스 tarball을 받아 sha256 확인 뒤 /opt/rapi-senpi/<버전>에
#    풀고 /usr/local/bin/senpi를 연결한다. 전용 설정(텔레메트리 끔, 프로젝트 신뢰
#    never)을 SENPI_HOME(기본 /var/lib/rapi/senpi)/agent/settings.json에 쓴다.
#    다시 실행해도 안전하다. gh 로그인이 필요하다.
scripts/install-senpi.sh

# 2. 소유자가 서비스 계정(justn)으로 공급자 로그인(브라우저/기기 인증이 필요하다).
PI_CODING_AGENT_DIR=/var/lib/rapi/senpi/agent senpi   # 대화창에서 /login

# 3. 같은 요청을 Codex와 `센파이로 …`로 몇 번 나란히 돌려 본 뒤에만 기본값을 바꾼다.
#    .env에 CHATOPS_HARNESS=senpi 를 쓰고 rapi-chat을 재시작한다.
```

`curl -s localhost:3100/ready`의 `senpi` 항목이 `ok`면 바이너리와 설정 파일이 있다는
뜻일 뿐 로그인 상태는 아니다. 로그인 전에는 `센파이로`가 실패하므로 2번을 먼저 한다. 인증 오류처럼 보이는 실패에는 ChatOps가
"senpi 로그인이 필요할 수 있어요"를 덧붙인다.
`SENPI_BIN`, `SENPI_HOME`은 기본 경로를 바꿀 때만 설정한다.

## 하네스 버전 갱신 (선택)

`HARNESS_UPDATES_ENABLED=true`로 켜면 워커가 6시간마다 `ops/harness-versions.json`의
`repo` 항목(예: senpi → `code-yeongyu/senpi`)의 최신 GitHub 릴리스를 확인한다. 새
버전이면 임시 디렉터리에서 자산을 받아 SHA256SUMS를 대조하고 `--version`, 격리 설정
유지, 고정 스모크 프롬프트를 검사한 뒤 SUPERADMIN 전원에게 `반영 추천`/`보류 추천`
DM을 보낸다. 버튼은 `[반영]` `[건너뛰기]` `[나중에]`(24시간 뒤 재알림)이고 소유자만
누를 수 있다. 자동으로 바뀌는 것은 없다.

- `[반영]`: VM에 로그인된 `gh`로 `HARNESS_UPDATES_REPO`를 임시 clone해 브랜치
  `chore/harness-<이름>-<버전>`에 고정값을 바꾸고 PR을 연다. 새 자격 증명은 없다.
- PR이 머지되면 DM에 `[되돌리기]`가 오고, 누르면 이전 고정값 복원 PR을 연다.
- 머지·배포 뒤 설치는 수동이다: `scripts/install-senpi.sh` (sudo가 필요해 배포
  스크립트에는 연결하지 않았다).
- 모든 단계는 `harness_updates`, `harness_update_events`에 남는다.
- 스모크 프롬프트는 `SENPI_HOME/agent`의 로그인 파일(설정 제외)을 임시 디렉터리에
  복사해 실행하고 끝나면 지운다.
- 워커와 봇 둘 다 같은 환경변수를 읽으므로 워커와 `rapi-bot`을 재시작한다.

## LiteLLM 켜기 (선택)

라피 내부 모델 호출(요약 등)은 `packages/adapters`의 `OpenAiCompatibleModelClient` 하나를
거친다. 이 클라이언트는 LiteLLM, OpenAI, Anthropic의 OpenAI 호환 엔드포인트 어디든
가리킬 수 있고, `MeteredModelClient`가 모든 호출을 `model_usage`에 기록하며 월 상한을
적용한다. `MODEL_API_BASE_URL`과 `MODEL_API_KEY`가 모두 없으면 꺼져 있고(코드는
`null`을 받아 기존 동작을 유지), 배포만으로는 아무것도 바뀌지 않는다.

소유자만 할 수 있는 일:

1. VM에 LiteLLM 설치: `python3 -m venv /opt/rapi-litellm && /opt/rapi-litellm/bin/pip
   install 'litellm[proxy]'`.
2. `ops/litellm/config.example.yaml`을 `/etc/rapi/litellm.yaml`로 복사해 모델 목록을 고른다.
3. `/etc/rapi/litellm.env`(chmod 600)에 `LITELLM_MASTER_KEY`(임의의 긴 값)와 공급자
   키(`OPENAI_API_KEY` 등)를 넣는다. 저장소에는 넣지 않는다.
4. `ops/systemd/rapi-litellm.service.example`을 `/etc/systemd/system/rapi-litellm.service`로
   복사하고 `systemctl enable --now rapi-litellm`. 바인드는 `127.0.0.1:4000`이다.
5. `.env`에 설정하고 워커와 `rapi-bot`을 재시작한다:
   `MODEL_API_BASE_URL=http://127.0.0.1:4000/v1`, `MODEL_API_KEY=<LITELLM_MASTER_KEY>`,
   `MODEL_DEFAULT=rapi-default`, 선택으로 `MODEL_FOR_PUBLIC_QA` 등 기능별 모델과
   `MODEL_MONTHLY_BUDGET_USD`.
6. 요약을 API로 돌리려면 `SUMMARIZER_BACKEND=api`(기본은 `codex`). 이 값은
   위 변수가 모두 있어야 설정 검증을 통과한다.

동작:

- 비용은 LiteLLM의 `x-litellm-response-cost` 헤더를 우선 쓰고, 없으면
  `ops/model-prices.json`의 가격표로 계산한다. 가격표에 없는 모델은 비용 0으로 기록되고
  행의 `note`에 `unknown_price`가 남는다. 가격표 값은 공급자 가격 페이지로 확인한다.
- 상한은 달력 월(Asia/Seoul) 기준이다. 80%에서 SUPERADMIN 전원에게 DM(월 1회), 100%에서
  `archive_qa`·`public_qa`·`chatbot`·`rewrite`를 멈추고 DM(월 1회)한다. `summary`,
  `blog_draft`, `repo_report`는 계속 돈다. DM이 한 명에게도 가지 않으면 다음 호출에서
  다시 시도한다.
- `/사용량`(운영진)과 `/상태`에 이번 달·지난달 기능별 모델 비용이 붙는다.
- 사용량 조회: `SELECT feature, count(*), sum(cost_micro_usd)/1e6 AS usd FROM model_usage
  WHERE at >= date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') GROUP BY 1;`
- 마이그레이션 `0026_model_usage.sql`을 먼저 적용한다(`npm run db:migrate`).
- 80%/100% 알림은 월·단계·`MODEL_MONTHLY_BUDGET_USD` 금액별로 한 번씩 간다. 한도를 올리면 같은 달에도 새 한도에서 다시 알린다.

연결 범위: 봇·chat·워커가 각자 같은 방식으로 이 클라이언트를 만들어 블로그 초안(`blog_draft`)과
주간 GitHub 리포트(`repo_report`)에 넘긴다. `MODEL_API_*`가 없으면 초안은 "꺼져 있어요"라고
답하고 리포트는 모델 요약 없이 나간다.

public-agent는 DB·키 접근이 없는 격리 프로세스라 이 클라이언트를 직접 쓰지 않는다.
`PUBLIC_AGENT_BACKEND=api`일 때의 비용은 호출하는 쪽(봇·chat)이 이어 받는다: 질문을 넘기기 전에
같은 `evaluateBudget`으로 이번 달 합계를 확인해 100%이면 "이번 달 한도에 도달했어요"로 답하고,
실행기가 소켓 응답에 실어 보낸 사용량(토큰, 모델, LiteLLM이 준 비용)을 같은 `model_usage`에 기록한다.
비용이 비어 오면 호출하는 쪽의 `ops/model-prices.json`으로 계산한다. `codex` 백엔드는 지금처럼
계량하지 않는다. Codex CLI를 LiteLLM 뒤로 보내는 일(Responses API, `wire_api = "responses"`)은
아직 하지 않았다. chat(ChatOps)은 계속 Codex 구독 로그인으로 실행된다.
## 메일 켜기 (선택)

학습자 호를 메일로도 보내는 채널이다. 0단계 실험의 "메일 의향" 결과가 메일 발송을
가리킬 때만 켠다. 기본은 꺼져 있고, 켜지 않으면 배포해도 아무것도 바뀌지 않는다.
`LEARNER_EXPERIMENT_ENABLED=true`가 먼저 필요하다.

### 소유자가 할 일

1. 발송 업체를 고르고 계정을 만든다: `resend` 또는 `postmark`.
2. 보내는 도메인을 업체에 등록하고 안내하는 DNS 레코드를 넣는다.
   - **SPF**: 업체가 안내하는 `include:`를 도메인의 SPF TXT에 합친다(SPF TXT는 도메인당 하나).
   - **DKIM**: 업체가 주는 CNAME/TXT 레코드를 그대로 추가한다.
   - **DMARC**: `_dmarc.<도메인>` TXT. 처음에는 `v=DMARC1; p=none; rua=mailto:<받을 주소>`로
     시작하고, 리포트에서 SPF/DKIM 정렬이 확인되면 `p=quarantine`으로 올린다.
   - 업체 화면에서 도메인이 "Verified"가 된 것을 확인한 뒤 진행한다.
3. 업체에서 발급한 서버 API 키를 `EMAIL_API_KEY`에 넣는다(채팅·Git에 남기지 않는다).
4. 웹훅을 등록한다. URL은 `https://<RAPI_PUBLIC_BASE_URL의 도메인>/e/webhook/<resend|postmark>`.
   - Resend: 이벤트 `email.bounced`, `email.complained`를 선택하고, 발급된 서명 비밀값
     (`whsec_...`)을 `EMAIL_WEBHOOK_SECRET`에 넣는다. 서명(svix)과 5분 시각 허용 오차를 검증한다.
   - Postmark: 서명을 제공하지 않으므로 웹훅 URL에 Basic 인증을 건다. 임의의 `user:password`를
     만들어 업체 웹훅 설정과 `EMAIL_WEBHOOK_SECRET` 양쪽에 같은 값으로 넣는다. Bounce와
     Spam complaint 웹훅을 켠다. 정기 소식은 Postmark 정책상 Broadcast 스트림이 맞을 수
     있다(코드에서 확인하지 못했다). 그렇다면 스트림을 만들고 ID를 `EMAIL_POSTMARK_STREAM`에
     넣는다(기본 `outbound`).
5. `.env`에 설정한다: `EMAIL_ENABLED=true`, `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`
   (인증한 도메인의 주소만, 표시 이름 없이), 선택 `EMAIL_REPLY_TO`, `EMAIL_WEBHOOK_SECRET`. 하나라도 빠지면
   봇이 시작하지 않는다. 마이그레이션 `0023_email_delivery.sql`이 먼저 적용돼야 한다.
6. 공개 게이트웨이(`ops/gateway/run.mjs`)가 새 코드로 재시작돼야 `/e/verify/…`,
   `/e/unsub/…`, `/e/webhook/…`가 열린다. 봇을 재시작한다.
7. 확인: 본인 계정으로 학습자 구독 → 구독 확인 메시지의 `[메일로도 받기]`로 주소 등록 →
   확인 메일의 링크 → `[확인]` → 다음 호 발송 후 메일 수신, 맨 아래 `메일 그만 받기` 동작을 본다.

### 동작 요약

- 주소 등록은 디스코드 모달이다. 주소를 저장하고 확인 메일(24시간, 1회용 링크)을 보낸다.
  링크를 열면 확인 버튼이 있는 페이지가 뜨고, 버튼을 눌러야 확인된다(메일 보안 스캐너가
  링크를 미리 열어도 소모되지 않는다).
- 호 발송은 기존 흐름 그대로 소유자가 `[발송]`을 눌렀을 때만 나간다. 그때 확인된 주소를
  가진 구독자에게 메일이 추가로 나간다. 수신자별 결과는 `learner_email_deliveries`에
  남고, 실패는 다시 시도하지 않는다.
- 모든 메일에 `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  헤더와 본문 하단 수신 거부 링크(`/e/unsub/<토큰>`)가 있다.
- 하드 바운스·스팸 신고는 해당 주소로의 발송을 멈춘다. 소프트 바운스는 5회 누적 시 멈춘다.
- 웹 `/me`(`WEB_ENABLED`와 `EMAIL_ENABLED`가 둘 다 켜졌을 때): 로그인한 사용자가 메일 주소를
  등록·변경·삭제하고 상태(확인 대기, 확인됨, 수신 거부, 발송 불가)를 본다. 주소는 가린 채
  보여 주고, 등록은 디스코드 모달과 같은 서비스(확인 메일, 10분 간격 제한)를 거치며 CSRF 토큰이
  필요하다. 하드 바운스·스팸 신고된 주소는 삭제해도 행이 남아 차단이 유지된다. 게이트웨이는
  `POST /me/email`을 새로 연다.
- 웹 매직 링크 로그인: `verifyEmailToken()`(`@rapi/core`)이 토큰 검증을 제공한다. 웹 로그인은
  Discord OAuth만 쓰므로 메일 링크 로그인은 연결하지 않았다. 필요하면 `login` 목적(purpose)을 추가하고
  `/e/login/<토큰>` 라우트와 게이트웨이 정규식을 더한다.
- 끄려면 `EMAIL_ENABLED=false`로 되돌리고 봇을 재시작한다. 저장된 주소는 남는다
  (`/데이터삭제`와 보존기간 규칙으로 지워진다. `docs/data-lifecycle.md` 참고).

## OMP 제거

2026-10-24부터 코드 실행 경로는 ChatOps(Codex 직접 실행) 하나다. `rapi-omp` 서비스,
`/작업`·`/승인` 슬래시 명령, `/omp/callback`, `OMP_*` 설정은 제거됐다. 기존 task 행은
DB에 남고 보존 정책을 따른다. 배포 뒤 VM에서 한 번 정리한다.

```bash
sudo systemctl stop rapi-omp && sudo systemctl disable rapi-omp
sudo rm -f /etc/systemd/system/rapi-omp.service*
sudo systemctl daemon-reload
npm run discord:register-commands   # 슬래시 명령 재등록: /작업, /승인 제거
```

VM `.env`의 `OMP_*`와 `COMMAND_CODE_API_KEY`는 더 이상 읽지 않으므로 지워도 된다
(남아 있어도 설정 검증은 알 수 없는 키를 무시한다).

## GitHub App 만들기 (선택)

소유자 본인 레포에서 `@rapi`로 일을 시키고(반응형), 매주 월요일 09:00(Asia/Seoul)에 레포
요약을 받는(능동형) 기능이다. 기본은 꺼져 있다. `GITHUB_APP_ENABLED=true`를 쓰기 전에는
봇이 `/github/webhook`을 열지 않고 404로 답한다(게이트웨이는 경로만 전달한다).

### 1. GitHub에서 App 등록 (소유자만 가능)

Settings → Developer settings → GitHub Apps → New GitHub App.

- **Homepage URL**: 아무 주소(레포 주소 등).
- **Webhook URL**: `<RAPI_PUBLIC_BASE_URL>/github/webhook` (Cloudflare Tunnel 뒤의 공개 게이트웨이가
  이 경로만 `POST`로 봇에 전달한다).
- **Webhook secret**: 16자 이상 임의 문자열. `.env`의 `GITHUB_APP_WEBHOOK_SECRET`과 같아야 한다.
- **Repository permissions**: Contents **Read & write**, Pull requests **Read & write**,
  Issues **Read & write**, Metadata **Read-only**, Checks **Read-only**.
- **Subscribe to events**: `Issues`, `Issue comment`, `Pull request review comment`.
- **Where can this GitHub App be installed?**: **Only on this account**.
- 만든 뒤 App ID를 적어 두고 **Generate a private key**로 `.pem`을 받는다.
- **Install App**에서 본인 계정의 **필요한 레포만**(Only select repositories) 선택해 설치한다.

### 2. VM에 비밀값 두기

```bash
# 개인 키: 서비스 계정만 읽도록 (레포 밖, Git에 넣지 않는다)
sudo install -d -m 700 -o justn -g justn /home/justn/secrets
install -m 600 rapi-github-app.pem /home/justn/secrets/rapi-github-app.pem
```

`.env`에 추가하고 `rapi-bot`, `rapi-chat`, `rapi-worker`를 재시작한다.

```bash
GITHUB_APP_ENABLED=true
GITHUB_APP_ID=<App ID>
GITHUB_APP_PRIVATE_KEY_PATH=/home/justn/secrets/rapi-github-app.pem
GITHUB_APP_WEBHOOK_SECRET=<위 웹훅 시크릿>
GITHUB_APP_ALLOWED_OWNERS=<설치 계정 로그인, 쉼표 구분>
GITHUB_APP_OWNER_LOGINS=<@rapi를 부를 수 있는 로그인, 쉼표 구분>
# 선택: 리포트를 레포 이슈에도 남기려면 issue
GITHUB_REPORT_TARGET=dm
```

`DISCORD_SUPERADMIN_USER_IDS`가 필요하다(리포트 DM 수신자). 마이그레이션
`0024_github_app.sql`을 먼저 적용한다(`npm run db:migrate`).

### 3. 동작과 안전장치

- 웹훅은 `X-Hub-Signature-256`을 상수 시간으로 검증하고 `X-GitHub-Delivery`로 중복을 거른다.
  설치 계정이 `GITHUB_APP_ALLOWED_OWNERS`에 없으면 403이다.
- `@rapi`를 부른 사람이 `GITHUB_APP_OWNER_LOGINS`에 없으면 조용히 무시한다(공개 레포에서 낯선
  사람이 App의 댓글을 유발하지 못하게 답글도 달지 않는다).
- 요청은 Discord와 같은 ChatOps 엔진·같은 실행 기록(`chatops_runs`)으로 처리된다. 수신 즉시 👀
  반응이 붙고 진행·결과가 같은 스레드 댓글로 올라오며 작업 ID가 함께 표시된다. `@rapi 멈춰`로 중단한다.
- 변경 요청은 새 클론에서 실행하고, 하네스에는 토큰이 전달되지 않는다. 라피가 `rapi/<작업ID>`
  브랜치만 푸시하고 PR을 연다. 기본 브랜치에는 푸시하지 않는다(코드에서 거부). 질문은 PR 없이
  댓글로 답한다.
- 설치 토큰은 해당 레포 하나로 한정되고 만료 직전까지만 캐시한다.
- 주간 리포트는 지난 7일의 머지된 PR, 열린 이슈, 검사 실패 PR, 14일 이상 멈춘 PR을 GitHub API로
  모아 SUPERADMIN에게 DM으로 보낸다. 직접 호출하는 모델 요약(`repo_report`)은 `ModelClient`가
  연결돼 있을 때만 붙고, 없거나 예산이 소진돼도 리포트는 그대로 나간다.

### 4. 확인

```bash
# 웹훅 전달: App 설정 → Advanced → Recent Deliveries에서 202(접수) 또는 200(무시/중복)
# 레포 이슈에 "@rapi 이 레포 구조를 설명해줘" 댓글 → 👀 → 답 댓글
```

끄려면 `GITHUB_APP_ENABLED=false`로 되돌리고 서비스를 재시작한다. App 설치 자체를 지우면 GitHub 쪽에서도
토큰이 즉시 무효화된다.

## 기능 켜기 순서

모든 기능은 꺼진 채로 배포되고, 배포만으로는 아무것도 바뀌지 않는다. 아래 순서는 앞 단계가
뒤 단계의 전제인 경우를 따랐다. 단계마다 `.env`를 바꾸고 해당 서비스를 재시작한다. 마이그레이션은
먼저 `npm run db:migrate`로 적용한다.

| 순서 | 플래그 | 필요한 것 | 소유자 작업 | 자세히 |
| --- | --- | --- | --- | --- |
| 1 | `MODEL_API_BASE_URL` + `MODEL_API_KEY` (플래그 없음) | `MODEL_DEFAULT`, 선택 `MODEL_MONTHLY_BUDGET_USD`, 마이그레이션 `0026` | LiteLLM 설치와 공급자 키, 가격표 확인 | [LiteLLM 켜기](#litellm-켜기-선택) |
| 2 | `LEARNER_EXPERIMENT_ENABLED` | `WEBHOOK_ENCRYPTION_KEY`, `RAPI_PUBLIC_BASE_URL`, `DISCORD_SUPERADMIN_USER_IDS`, `0019`, `0027`(재알림) | 없음(Discord 안에서 소유자 승인으로 발송) | `.env.example` |
| 3 | `WEB_ENABLED` | `DISCORD_OAUTH_CLIENT_ID/SECRET`, `RAPI_PUBLIC_BASE_URL`, `WEBHOOK_ENCRYPTION_KEY`, `0021`(구독 폼은 2번이 켜져야 작동) | Discord 개발자 포털에 `${RAPI_PUBLIC_BASE_URL}/auth/discord/callback` redirect 등록, 게이트웨이 재시작 | README, `docs/ux-notes/w1-web.md` |
| 4 | `BLOG_PUBLISH_ENABLED`, `BLOG_DRAFTS_ENABLED` | `DISCORD_SUPERADMIN_USER_IDS`, `0022`, `0027`(상태 전이·재알림), 초안은 1번 | VM의 `gh` 로그인, 블로그 PR 병합, `RAPI_BLOG_WITHDRAWALS_FILE` 쓰기 권한 | `docs/ux-notes/m2-blog.md` |
| 5 | `EMAIL_ENABLED` | 2번, `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_WEBHOOK_SECRET`, `0023` | 발송 도메인 SPF/DKIM/DMARC, 업체 웹훅 등록, 게이트웨이 재시작 | [메일 켜기](#메일-켜기-선택) |
| 6 | `PUBLIC_AGENT_ENABLED` + `PUBLIC_AGENT_BACKEND=api` | 실행기 쪽 `PUBLIC_AGENT_API_KEY/MODEL`(1번과 별개). 월 상한·가격표는 봇 `.env`의 `MODEL_MONTHLY_BUDGET_USD`와 `ops/model-prices.json` | `/etc/rapi-public-agent.env`에 같은 백엔드·키 설정, 배포 뒤 실행기 재시작(안 하면 사용량 기록이 오지 않는다) | 위 LiteLLM 절 |
| 7 | `CHATBOT_ENABLED`, `CHATBOT_L2_ENABLED` | 6번, `0025`, 블로그 색인은 `RAPI_PUBLIC_BASE_URL`(https) | 봇 `.env`와 실행기 env 둘 다 `api`인지 확인 | `docs/ux-notes/q5-chatbot.md` |
| 8 | `GITHUB_APP_ENABLED` | `GITHUB_APP_ID/PRIVATE_KEY_PATH/WEBHOOK_SECRET/ALLOWED_OWNERS/OWNER_LOGINS`, `0024` | GitHub App 등록·설치·웹훅 URL | [GitHub App 만들기](#github-app-만들기-선택) |
| 9 | `HARNESS_UPDATES_ENABLED` | `DISCORD_SUPERADMIN_USER_IDS`, `0020` | VM의 `gh` 로그인, 제안 PR 검토 | [하네스 버전 갱신](#하네스-버전-갱신-선택) |

켜고 나서 한 번씩 확인할 것:

- 1번: `/사용량`(운영진)에 기능별 비용 줄이 보이는지. 새 모델은 가격표에 먼저 넣는다.
- 3번: 로그인 → `/me`, `/archive`. 4번 이후 `/archive`에는 발행된 가이드 글이 학습자 소식과 함께 보이고
  내린 글은 보이지 않는다.
- 5번: `/me`의 "메일 주소" 카드에서 등록 → 확인 메일 → `[확인]`.
- 7번: 챗봇에게 블로그 글을 물어 출처 링크가 나오는지(색인은 5분 단위로 갱신되고, 내린 글은 다음 갱신에서 빠진다).
- 6번은 1번 없이 켤 수 있다. 공개 질문 비용은 `model_usage`에 남지만 `MODEL_MONTHLY_BUDGET_USD`가 없으면
  상한이 없다(기록만).

끄는 순서는 반대다. 플래그를 `false`로 되돌리고 서비스를 재시작하면 된다.

## 소유자 재알림 (U8)

마이그레이션 `0027_owner_reminders.sql`(`npm run db:migrate`, 자동 배포는 스스로 적용)을 봇·워커보다 먼저 적용한다. 블로그 상태 전이도 새 컬럼을 쓰므로 필수다. 학습자 미리보기를 3시간 동안
결정하지 않으면, 블로그 글이 PR이 열린 채 24시간 `approved`에 머물면 SUPERADMIN에게 DM을 한 번 보낸다(반복 없음).
새 환경 변수는 없다.
