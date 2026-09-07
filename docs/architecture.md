# 아키텍처와 데이터 설계

## 1. 설계 방향

`rapi-core`는 TypeScript 패키지로 구현하며 도메인 규칙, 저장소 인터페이스,
작업 상태 전이를 소유한다. Discord, 이메일, GitHub, 블로그, OpenClaw,
ZeroClaw, OMP는 모두 포트 뒤의 어댑터다.

이 경계는 초기 실행 계층을 OpenClaw로 시작하더라도 장기적으로 ZeroClaw를
평가하거나 교체할 수 있게 한다.

## 2. 논리 구성요소

| 구성요소 | 책임 |
| --- | --- |
| `core/domain` | 엔티티, 상태 전이, 정책, 오류 정의 |
| `core/application` | 수집·처리·발송·승인 유스케이스 |
| `core/ports` | DB, 큐, 모델, 채널, 실행기의 인터페이스 |
| `adapters/ingest` | 웹훅, GitHub, 피드, 사이트, Aside 입력 |
| `adapters/delivery` | Discord, 이메일, MDX 출력 |
| `adapters/execution` | OpenClaw/ZeroClaw 런타임과 OMP 연결 |
| `workers` | 예약 수집, 정규화, 요약, 발송, 재시도 |
| `apps/bot` | Discord Gateway와 명령 라우팅 |
| `apps/blog` | MDX 렌더링 및 공개 빌드 |
| `ops` | 컨테이너, 마이그레이션, 백업, 관찰 가능성 |

초기에는 모듈러 모놀리스와 하나의 관계형 DB로 시작한다. 서비스 분리는 실제
부하, 장애 격리 또는 배포 독립성이 필요해질 때만 한다.

## 3. 주요 흐름

### 3.1 수집에서 발송까지

1. 수집 어댑터가 외부 이벤트를 받아 변경하지 않은 원본과 메타데이터를 저장한다.
2. ingestion key로 같은 입력의 재처리를 막는다.
3. 정규화 worker가 공통 `SourceItem`을 생성한다.
4. deduplication worker가 외부 ID, URL, fingerprint, 유사도 순으로 중복을 판단한다.
5. 분류·요약 worker가 처리 버전과 근거 원문을 연결한다.
6. subscription matcher가 항목을 구독과 연결한다.
7. scheduler가 주기별 `DeliveryBatch`를 동결한다.
8. 채널 어댑터가 발송하고 대상별 결과를 기록한다.

### 3.2 개발 작업 실행

1. Discord 요청을 `TaskDraft`로 저장한다.
2. 라피가 목표, 범위, 완료 조건, 권한을 구조화한다.
3. 위험 정책에 따라 자동 진행 또는 사용자 승인을 요청한다.
4. 승인된 명세만 OMP 어댑터에 전달한다.
5. OMP receipt, 상태 변화, 결과 보고서를 동일 작업 ID에 연결한다.
6. 결과를 Discord에 알리고 커밋·PR·테스트 증거를 보존한다.

## 4. 데이터 모델

초기 관계는 다음과 같다.

```text
Source 1 ── N RawEvent 1 ── 0..1 SourceItem
                              │
                              ├── N Classification
                              ├── N Summary
                              └── N ItemRelation (duplicate/related)

Subscription N ── N SourceItem
      │
      └── N DeliveryBatch 1 ── N DeliveryAttempt

TaskRequest 1 ── N TaskRevision 1 ── N Approval
                                  └── N ExecutionAttempt
```

### 핵심 엔티티

| 엔티티 | 필수 정보 |
| --- | --- |
| `Source` | 종류, 위치, 인증 참조, 수집 정책, 상태 |
| `RawEvent` | 원본 payload/blob 참조, 외부 ID, 수집 시각, checksum |
| `SourceItem` | canonical URL, 제목, 본문, 작성·수집 시각, 공개 범위 |
| `Classification` | taxonomy 버전, label, score, 근거 |
| `Summary` | 목적, 모델/프롬프트 버전, 내용, 근거 항목 |
| `Subscription` | 조건, 주기, 시간대, 채널, 활성 상태 |
| `DeliveryBatch` | 기간, 항목 snapshot, 렌더링 버전, 상태 |
| `DeliveryAttempt` | 대상, idempotency key, 공급자 ID, 결과 |
| `TaskRequest` | 사용자 요청, 현재 revision, 상태, 위험 수준 |
| `TaskRevision` | 구조화 명세, 권한, 완료 조건, 변경 이유 |
| `Approval` | 승인자, 범위, 만료, 결정, Discord message 참조 |
| `ExecutionAttempt` | OMP receipt, 입력 revision, 상태, 결과·증거 참조 |

모든 주요 테이블은 `created_at`, `updated_at`을 가지며, 외부 실행 기록은
가능하면 append-only로 남긴다.

## 5. 상태 전이

### 발송

```text
draft -> ready -> sending -> delivered
                   ├──> partially_failed -> retrying -> delivered
                   │                         ├──> partially_failed
                   │                         └──> failed -> dead_letter
                   └──> failed -> retrying / dead_letter
```

### 개발 작업

```text
draft -> awaiting_approval -> approved -> dispatched -> running -> completed
  │          │       │              │             ├──> blocked -> running
  │          │       │              │             │             ├──> failed
  │          │       │              │             │             └──> cancelled
  │          │       │              │             └──> failed
  │          │       │              └──> cancelled
  │          │       └──> expired / awaiting_approval (명세 변경)
  │          └──> rejected / expired
  └──> cancelled
```

상태 전이는 compare-and-set 또는 DB transaction으로 보호한다. 외부 요청에는
작업·발송 ID에서 파생된 idempotency key를 사용한다. 허용 전이, 재시도, 취소,
callback 계약의 기준은 [용어와 실행 계약](contracts.md)에 정의한다.

## 6. 저장소와 큐

- 메타데이터와 상태: PostgreSQL 권장
- 원본의 작은 JSON/text: PostgreSQL JSONB로 시작
- 큰 원문, 첨부, 스냅샷: S3 호환 object storage로 이동 가능
- 작업 큐: 초기에는 DB-backed queue로 단순화
- 전문 검색: PostgreSQL full-text search로 시작
- 의미 검색: 실제 필요가 확인된 뒤 vector extension 추가

특정 제품은 구현 단계에서 VM 자원, 백업 방식, 운영 복잡도를 확인한 뒤 결정한다.
도메인 코드는 저장 기술에 직접 의존하지 않는다.

## 7. 모델 사용 경계

모델은 분류, 요약, 브리핑 구성, 작업 명세 초안에 사용한다. 다음 규칙은
결정론적 코드가 담당한다.

- 인증·권한 검사
- 구독 필터의 강제 제외 규칙
- 상태 전이와 중복 발송 방지
- 비용·속도 제한
- 승인 범위와 만료 검사
- 공개 가능 여부의 hard deny 규칙

모델 출력은 schema validation을 거치고, 사용한 모델·프롬프트·입력 항목 버전을
기록한다.

## 8. 제안 저장소 구조

```text
rapi-agent/
├── apps/
│   ├── bot/
│   └── blog/
├── packages/
│   ├── core/
│   ├── db/
│   ├── adapters/
│   └── contracts/
├── workers/
├── migrations/
├── ops/
├── docs/
└── tests/
```

패키지 매니저와 프레임워크는 구현 시작 시 최소 의존성과 운영 적합성을 비교해
고정하고 lockfile을 단일 기준으로 삼는다.
