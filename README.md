# rapi-agent

`rapi-agent`는 개인 Discord를 중심으로 정보를 수집하고, 정리하고, 필요한
실행으로 연결하는 개인용 에이전트 시스템이다.

Discord는 사용자가 라피와 대화하고 알림을 받고 중요한 작업을 승인하는 기본
인터페이스다. `rapi-core`는 채널과 실행 도구에 종속되지 않는 도메인 로직과
상태를 담당한다. 개발 작업은 기존 slash 명령의 OMP 흐름과 자연어 ChatOps의 직접 Codex 실행을
지원한다. 명확한 소유자 요청은 반복 승인 없이 수행한다.

## 목표

- 여러 출처의 변화를 한곳에서 놓치지 않고 확인한다.
- 같은 사건을 여러 번 보내지 않고, 사용자가 원하는 분류와 주기로 요약한다.
- Discord 대화에서 구독, 검색, 발송, 개발 작업 요청을 제어한다.
- 뉴스레터를 Discord DM과 이메일로 전달한다.
- 브리핑과 공개 가능한 분석을 MDX 블로그에 축적한다.
- 소유자의 명확한 실행 요청을 권한으로 사용하고, 질문·인용·부정을 구분한다.

## 시스템 경계

```text
웹훅 / GitHub / RSS·사이트 / Aside 리서치
                    │
                    ▼
             수집 어댑터 계층
                    │
                    ▼
                rapi-core
   정규화 · 중복 제거 · 분류 · 요약 · 상태 관리
          │              │               │
          ▼              ▼               ▼
      Discord        이메일 뉴스레터      MDX 블로그
          │
          ▼
   승인된 개발 작업 명세 ──▶ OMP
```

## 핵심 원칙

1. Discord 개인 계정 self-bot은 사용하지 않는다. 공식 Discord 봇과 API만
   사용한다.
2. 원본 수집 데이터와 가공 결과를 분리해 보존한다.
3. `rapi-core`는 OpenClaw나 ZeroClaw에 종속되지 않는다.
4. 모든 발송과 외부 실행은 추적 가능한 상태와 실행 기록을 남긴다.
5. 비밀값은 저장소에 커밋하지 않고 VM의 비밀 저장소나 환경 주입으로 관리한다.
6. 자동화가 실패해도 같은 메시지나 작업을 중복 실행하지 않도록 멱등성을
   보장한다.

## 문서

- [제품 요구사항](docs/product-requirements.md)
- [아키텍처와 데이터 설계](docs/architecture.md)
- [용어와 실행 계약](docs/contracts.md)
- [운영, 권한, 보안](docs/operations.md)
- [구현 로드맵](docs/roadmap.md)
- [결정 기록](docs/decisions.md)

## 개발 시작

Node.js 22.13 이상과 Docker가 필요하다.

```bash
npm run bootstrap
```

이 명령은 의존성을 설치하고 PostgreSQL 16을 로컬 loopback에 기동한 뒤 migration과
전체 검증을 실행한다. 애플리케이션
비밀값은 `.env.example`을 참고해 저장소 밖의 `.env` 또는 비밀 관리 도구에 넣는다.

## 실행

`.env.example`을 저장소 밖의 운영 환경 값으로 채운 뒤 다음 프로세스를 실행한다.

```bash
npm run start:bot
npm run start:chat
npm run start:omp
npm run start:worker
```

두 명령은 저장소 루트의 `.env`를 자동으로 읽는다. 운영 서버에서는 파일 권한을
`0600`으로 제한하고 `ops/systemd`의 unit을 설치한다. Discord interaction endpoint는
공개 HTTPS reverse proxy의 `/interactions`로 연결한다.

고정 도메인이나 인바운드 HTTPS를 사용할 수 없는 서버에서는
`rapi-tunnel.service`가 Cloudflare Quick Tunnel을 실행하고 재시작할 때마다 Discord
interaction endpoint를 자동 갱신한다.

`start:bot`은 Discord interaction, 서명된 generic webhook, 구독·검색·브리핑·승인
명령을 제공한다. `start:worker`는 GitHub/RSS 수집과 일간·주간 배치를 실행한다.
Discord와 이메일은 하나의 동결된 batch를 사용하며 OMP callback 상태는 PostgreSQL과
Discord DM에 반영된다.

`start:omp`는 승인된 개발 작업을 전용 Git clone에 준비하고 선택한 공급자의 CLI로 실행한다 (기본 Codex).
봇에는 receipt를 즉시 반환하고 실행 상태와 결과 증거를 HMAC 서명 callback으로
전달한다. 실행기 자식 프로세스에는 Discord, 데이터베이스, callback 비밀값을
전달하지 않는다. 기본 저장소, 허용 저장소 루트, 작업공간은
`OMP_DEFAULT_REPOSITORY`, `OMP_ALLOWED_REPOSITORY_ROOTS`, `OMP_WORKSPACE_ROOT`로
제한한다.

Discord 명령은 모두 한글이며 작업 실행에는 JSON이 필요 없다.

```text
/작업 내용:로그인 오류 고치고 관련 테스트 돌려줘
/승인
```

그 밖의 명령은 `/브리핑`, `/검색`, `/구독`, `/구독해제`, `/수집원`,
`/발송내역`, `/취소`다. `/승인`과 `/취소`는 해당 사용자의 가장 최근 작업을
대상으로 한다.

원하는 채널에서 `/대화채널`을 한 번 실행하면 ChatOps 대화를 켤 수 있다.
이후 허용된 사용자가 `라피야!`로 시작해 질문하면 최근 대화 문맥을 반영해
한국어로 답한다. 서버 운영, 코드 수정, 테스트, 배포 요청도 직접 수행한다.
기본 모델은 `gpt-5.3-codex-spark`이며 요청에 모델을 적으면 그 작업에만 반영한다.
`/대화해제`를 실행하면 해당 채널의
대화를 끈다.

```text
/대화채널
라피야! 오늘 서버 상태 알려줘
/대화해제
```

## 현재 상태

MVP 수직 슬라이스가 구현됐다. PostgreSQL 영속화, GitHub/RSS/webhook 수집,
정규화·중복 후보·분류·요약, Discord 권한과 명령, Discord/SMTP 발송, 공개 범위가
보호된 MDX, revision 승인 기반 OMP 실행, 재시작·백업 복구 검증을 포함한다.
완료 조건별 증거는 [MVP 검증 기록](docs/mvp-verification.md)과
`tests/manifests/mvp.yaml`에 있다.

## 자연어 실행·상태·기억

```text
라피야! 로그인 오류 고쳐줘
라피야! 지금 뭐 하는 중이야?
라피야! 최근 작업 보여줘
라피야! 멈춰
라피야! 기억해줘: 기본 답변 언어는 한국어
라피야! 기억 목록 보여줘
라피야! 최근 기억 잊어줘
라피야! 테스트가 될 때까지 고쳐줘
라피야! 아스트라로 로그인 오류 고쳐줘
라피야! 모델: gpt-5.6-sol 문서 정리해줘
```

실행·시도·증거와 기억 lifecycle은 PostgreSQL에 보존한다. 취소는 활성 Codex
프로세스를 실제 종료하며, 재시작 때 남은 작업은 interrupted로 표시한다.
질문은 읽기 전용이고, 명확한 수정·배포는 기본 모델
`gpt-5.3-codex-spark`로 직접 수행한다. `스파크`, `아스트라`, `솔`, `테라`,
`루나` 별칭이나 정확한 모델 ID를 현재 요청에 지정할 수 있다. `/작업` 명령에도
선택 항목 `모델`이 있으며 OMP가 해당 모델을 그대로 사용한다.
완료 보고를 검증 성공으로 간주하지 않는다. 전체 UX, 자원 한도와 운영 한계는
[ChatOps capability 문서](docs/chatops-capabilities.md)를 참고한다.

검증: `npm run check`, `npm run test:e2e`, `npm run audit:prod`.
E2E는 자동으로 폐기되는 별도 PostgreSQL의 `rapi_test`만 사용한다.

OMP supports `/작업 내용:커서로 오류 고쳐줘`, `/작업 내용:고트로 오류 고쳐줘`,
and `/작업 내용:오류 고쳐줘 공급자:commandcode 모델:vendor/model`.
The optional `공급자` option overrides a leading provider directive. Omitted provider
means Codex with `gpt-5.3-codex-spark`; Cursor and Command Code use their own default
model when `모델` is omitted. Selection applies only to the current task revision.
Set optional `COMMAND_CODE_API_KEY` in `.env` and restart the OMP service for Command Code.
For Cursor, run `cursor-agent login` as the OMP service user; OAuth stays in
`~/.cursor`. See [provider operations](docs/operations.md#omp-provider-setup).
