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
- Aside 실행 환경과 사용자가 승인한 로그인 상태
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
| Discord bot | 명령 수신, DM/허용 채널 읽기·쓰기 | 사용자 계정 로그인, 전체 서버 관리자 |
| GitHub 수집 | metadata/content read, issues/PR read | 저장소 write |
| GitHub 실행 | 작업별 승인된 repo write/PR 범위 | 조직 관리자, 무관 저장소 접근 |
| 이메일 | 지정 발신자 주소의 send | mailbox 전체 읽기 |
| 블로그 배포 | 지정 repo/배포 대상 write | 다른 사이트·도메인 변경 |
| OMP | 작업 명세에 적힌 저장소와 행위 | 승인 범위 밖 commit/push/deploy |

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
- OMP 실행 연결 정보
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
- [ ] OMP 작업마다 승인 범위와 결과 증거가 연결된다.

## 11. 구현된 운영 명령

```bash
npm run bootstrap       # 설치, DB, migration, 전체 검증
npm run db:migrate      # 미적용 migration 적용
npm run backup          # backups/ 아래 권한 0600 SQL dump 생성
npm run restore:smoke   # 격리된 임시 DB로 실제 복구 검증
npm run restart:smoke   # PostgreSQL 재시작 전후 핵심 count 검증
npm run start:bot       # Discord interaction/webhook 서버
npm run start:worker    # GitHub/RSS 수집과 배치 발송 worker
```

서비스 프로세스는 reverse proxy 뒤에서 실행하며 `/health`를 readiness 확인에 쓴다.
Docker volume `rapi-postgres`는 애플리케이션 컨테이너 교체와 분리해 보존한다.

## 자연어 ChatOps 운영 정책 (D-008)

허용된 소유자의 명확한 자연어 변경·배포 요청은 그 자체로 실행 권한이며 반복
승인을 요구하지 않는다. 이는 위 승인 초안의 자연어 ChatOps 경로를 대체한다.
`/작업`·`/승인`은 기존 동작을 유지한다. 배포 시 기존 `npm run db:migrate`가
0004를 적용한 뒤 기존 `rapi-chat.service`를 사용한다. 이번 구현 작업에서는
운영 migration, 서비스 변경, 배포를 수행하지 않는다.

`npm run test:e2e`는 `compose.test.yaml`의 임시 PostgreSQL을 임의 로컬 포트에
기동하고 **rapi_test만** 사용한다. migration 재적용도 검사하며 EXIT trap으로
컨테이너·네트워크를 정리한다. 운영 Compose 또는 DB에는 연결하지 않는다.
테스트를 직접 실행할 때도 정확히 `rapi_test` 이름이 아니면 거부한다.
상태 조회, 실제 취소, interrupted 복구와 알려진 한계는
[운영 상세](chatops-capabilities.md)를 참고한다.

기본 실행 모델은 `gpt-5.3-codex-spark`다. ChatOps 요청의 `아스트라로 …`,
`…, 모델: gpt-6-astra` 또는 `/작업`의 선택 항목 `모델`로 실행별 모델을 지정한다.
선택 결과는 ChatOps 실행 행 또는 OMP 작업 명세에 저장한다.

## OMP provider setup

OMP uses installed CLI coding harnesses, not a direct model endpoint:

| Provider | Binary | Authentication | `repo:write` flag |
| --- | --- | --- | --- |
| `codex` (default) | `/usr/local/bin/codex` | `codex login` as service user | `--approve-for-me` |
| `cursor` | `/home/justn/.local/bin/cursor-agent` | `cursor-agent login` as service user; OAuth under `~/.cursor` | `--force` |
| `commandcode` | `/usr/local/bin/command-code` | `CMD_API_KEY` | `--yolo` |

Put `CMD_API_KEY` in the production `.env` yourself, then restart the OMP service
(`sudo systemctl restart rapi-omp`). Never paste keys into Discord or task specs.
The key is passed only to the Command Code child environment, not Codex, Cursor,
or Git children. OAuth credentials are not copied into clones or printed.
Command Code v1.51.3 runs with `--no-session --skip-onboarding --no-auto-update`;
its GOAT endpoint is not used directly because OMP needs the CLI coding tools.

Run Cursor login externally with the same HOME/user as the OMP service. A service
restart is needed after changing environment configuration. Re-register Discord
commands after updating the bot to expose the optional `공급자` and `모델` fields.

Examples: `/작업 내용:커서로 오류 고쳐줘`, `/작업 내용:고트로 오류 고쳐줘`,
`/작업 내용:오류 고쳐줘 공급자:cursor 모델:MODEL_ID`. Codex defaults to Spark;
other providers omit `--model` unless selected. Read-only tasks receive no write
permission flag (Codex additionally uses its read-only sandbox). Provider CLI
permissions are not an OS isolation boundary; existing approved broad authority
and commit/push/deploy policy remain in effect.

`GET http://127.0.0.1:3200/health` reports `providers.codex`, `providers.cursor`,
and `providers.commandcode`: `binary` checks executable presence, `configured`
checks Codex auth-file/Cursor directory presence or a nonempty Command Code key.
`authentication: not_verified` means this does not contact the provider or prove
credentials are valid. Failed receipts give installation/login/restart guidance;
inspect the redacted `omp-execution.log` for execution failures. Cursor and Command
Code stdout becomes `omp-result.md`; Codex retains its final-message output file.
