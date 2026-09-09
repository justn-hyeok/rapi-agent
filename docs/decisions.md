# 결정 기록

이 문서는 구현 전에 합의된 결정과 아직 열려 있는 결정을 구분한다. 구체적인 기술
선택이 확정되면 개별 ADR 파일로 분리한다.

## 확정된 결정

### D-001: Discord가 기본 사용자 인터페이스다

Discord DM과 허용된 개인 서버 채널에서 알림, 명령, 대화, 승인을 처리한다.
Discord 개인 계정 self-bot은 사용하지 않고 공식 bot/API만 사용한다.
Discord는 자동화용 bot user를 별도로 제공하며 일반 사용자 계정 자동화를
금지한다. 구현 기준은 [Discord bot 문서](https://docs.discord.com/developers/bots/overview)와
[self-bot 정책](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)을 따른다.

### D-002: `rapi-core`가 도메인 상태의 단일 소유자다

정규화, 중복 제거, 분류·요약, 구독, 발송, 승인, 작업 상태는 TypeScript 기반
`rapi-core`가 관리한다. 실행 런타임이나 채널은 이 상태를 대신 소유하지 않는다.

### D-003: 원본과 가공 결과를 분리해 보존한다

원본 이벤트는 재처리와 감사가 가능하도록 변경하지 않고 보존한다. 정규화 결과와
요약은 원본 ID 및 처리 버전과 연결한다.

### D-004: Notion 대신 MDX 블로그를 사용한다

브리핑, 수집함, GitHub 변화, 발송 기록의 읽기·공개 계층은 MDX 블로그로
구현한다. 비공개 데이터 저장과 상태 관리는 블로그가 아니라 `rapi-core` DB가
담당한다.

### D-005: 개발 구현은 OMP에 위임한다

라피는 요청을 versioned task specification으로 만들고 승인된 범위만 OMP에
전달한다. 라피 런타임 자체에는 직접 코드를 수정하는 기능을 두지 않는다.

### D-006: 이메일 뉴스레터를 1급 전달 채널로 지원한다

전용 이메일 계정을 통해 Discord DM과 동일한 `DeliveryBatch`를 발송할 수 있게
한다. 채널별 성공과 실패는 별도로 추적한다.

### D-007: 초기 배포 단위는 단일 VM의 모듈러 모놀리스다

초기에는 운영 복잡도를 줄이기 위해 한 VM에서 논리적으로 분리된 프로세스를
운영한다. 확장 근거가 생기기 전에는 microservice로 분리하지 않는다.

## 열려 있는 결정

### O-001: OpenClaw와 ZeroClaw 중 최종 실행 계층

초기 통합은 OpenClaw를 우선 후보로 삼되 확정하지 않는다. `rapi-core`가 정의한
runtime/execution port에 맞춘 prototype과 장애·자원 측정 후 결정한다.

### O-002: 관계형 DB 배치 방식

PostgreSQL 사용을 기본안으로 두고 VM 내부 운영과 관리형 서비스를 비용, 백업,
복구, 유지보수 기준으로 비교한다.

### O-003: MDX 블로그 프레임워크와 호스팅

정적 생성, private content 제외, feed, 검색, 배포 단순성을 기준으로 선택한다.
기존 개인 인프라와 도메인 정책을 확인한 뒤 확정한다.

### O-004: 이메일 전송 방식

전용 계정의 SMTP와 발송 API 중 계정 지원 범위, rate limit, 반송 처리, 운영
관찰 가능성을 비교해 결정한다.

### O-005: 모델 공급자와 라우팅

분류, 개별 요약, 장문 브리핑, 작업 명세에 필요한 품질과 비용이 다르므로 작업별
model policy를 실제 corpus 평가 후 정한다. 공급자를 도메인 코드에 고정하지
않는다.

### O-006: 원본 보존 기간

데이터 민감도, 재처리 가치, 저장 비용을 측정해 출처 유형별 보존·삭제 정책을
확정한다. production 수집 전에는 Phase 0에서 임시 보존 기간, 사용자 삭제 요청,
백업에서의 만료 처리까지 포함한 보수적 정책을 승인해야 한다. 최종 기간이 열려
있다는 이유로 무기한 보존을 기본값으로 삼지 않는다.

## ADR 작성 규칙

각 결정은 최소한 다음을 포함한다.

- 상태: proposed, accepted, superseded, rejected
- 결정 날짜와 결정자
- 문제와 제약
- 검토한 대안
- 선택과 근거
- 운영·보안·비용 영향
- 재검토 조건

## D-008: native ChatOps capability release (accepted, 2026-09-09)

결정자: 소유자의 명시 요청과 구현 담당자. 자연어 채팅에서는 명확한 변경·배포
요청을 즉시 실행할 넓은 권한을 사용한다. 따라서 D-005의 OMP 전용 실행 설명과
운영 문서의 매번 승인 초안은 이 자연어 경로에 한해 대체한다. `/작업`과 `/승인`의
기존 revision 승인 계약은 유지한다. ChatOps 모델은 `gpt-6-astra`로 고정한다.

문제: 단일 채팅 함수가 질문과 변경 권한을 구분하지 않고 실행 상태·취소·복구·
검토된 기억을 제공하지 않았다. 별도 Hermes 서버나 파일 ledger 대신 기존
TypeScript/Zod/PostgreSQL에 독립 구현한다. 준비·보고·검증을 분리하고 DB가 상태
전이를 강제하며, 명시 요청 기억만 자동 승인하고 실패 시 제한된 반복을 수행한다.
운영 영향과 현재 한계는 [ChatOps 계약](chatops-capabilities.md)에 기술한다.
재검토 조건은 다중 Gateway, 프로젝트별 목표 검증기, 영속 outbox, 외부 실행기
취소 receipt가 필요한 시점이다.

### Provenance

아이디어 참고: [oh-my-hermes](https://github.com/rlaope/oh-my-hermes),
로컬 분석 `/tmp/rapi-oh-my-hermes-astra-analysis.md` 및 영감 checkout의 고정 commit
`cfd13771c8621b952bcd3fdb6794a343baca0f99`.
참고 영역은 `src/routing/chat.py`, `src/runtime/records.py`,
`src/runtime/claims.py`, `src/workflows/memory.py`, `src/workflows/goal_loop.py`,
`src/coding/fanout_dispatch.py`와 LICENSE다. 원본 라이선스는 MIT,
`Copyright (c) 2026 oh-my-hermes contributors`다.

차용 종류는 준비와 관찰의 분리, 인용문 권한 배제, 검토된 기억과 bounded loop라는
설계 원칙이다. 원본 코드·schema·fixture·문장을 복사하거나 번역하지 않았으며,
Hermes/oh-my-hermes 런타임 의존성을 추가하지 않았다. 독립적인 한국어 corpus,
실제 Node child 취소, PostgreSQL 전이·증거 binding·기억 lifecycle·중복 메시지
검사로 수용한다. 이후 코드 또는 상당한 본문을 차용하면 MIT 원문 고지를 함께
추가해야 한다.

## D-009: Spark 기본값과 작업별 모델 선택 (accepted, 2026-09-09)

D-008의 Astra 고정 정책을 대체한다. ChatOps와 OMP의 기본 모델은
`gpt-5.3-codex-spark`다. 소유자가 현재 자연어 요청 또는 `/작업`의 `모델` 항목에
모델을 명시하면 그 실행에만 적용하고 실행 기록에 보존한다. 모델 지시가 기억이나
이전 대화에 있어도 현재 실행 모델을 바꾸지 않는다. 지원되지 않는 모델은 자동
fallback하지 않는다.

## D-010: OMP multi-provider CLI execution (accepted, 2026-09-09)

Extend the revision-approved OMP path with Codex, Cursor and Command Code CLI
adapters. Codex/Spark remains the backward-compatible default. Cursor and Command
Code use provider defaults unless the current task explicitly selects a model.
A shared deterministic prefix parser and explicit Discord options fix selection
in the revision; remembered preferences do not change execution routing.

Use Cursor OAuth from the service user's existing login and Command Code's
`CMD_API_KEY`, supplied in `.env` followed by a service restart. Use the CLI coding
harness rather than GOAT's HTTP endpoint. Keep secrets out of other child
processes, logs and reports. Health exposes only binary/config presence, not an
assertion of valid authentication. Preserve owner-authorized broad permissions,
existing approval/idempotency/evidence behavior, and the separate Codex ChatOps
executor. This extends D-009's OMP model policy without changing ChatOps routing.
