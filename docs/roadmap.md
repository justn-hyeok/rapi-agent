# 구현 로드맵

## 원칙

각 단계는 다음 단계가 소비할 수 있는 실행 가능한 산출물과 검증 증거를 남긴다.
일정이 아니라 완료 조건을 기준으로 전진한다. OpenClaw/ZeroClaw 비교 때문에
핵심 도메인 구현을 지연시키지 않으며, 런타임 어댑터 경계를 먼저 고정한다.

각 Phase의 모호한 fixture, 임계치, 대상 환경은 시작 시 versioned test manifest로
고정한다. manifest와 결과 artifact가 없으면 완료로 판정하지 않는다.

## Phase 0 — 기반 결정과 보안 준비

### 산출물

- TypeScript workspace, formatter, lint, typecheck, test 설정
- `rapi-core` 도메인/포트 skeleton
- 로컬·CI·운영 환경 설정 schema와 값 없는 `.env.example`
- 위협 모델, 데이터 보존 정책, Discord 허용 사용자 정책
- [용어와 실행 계약](contracts.md)을 구현한 schema와 상태 전이 테스트
- migration과 로컬 PostgreSQL 개발 환경
- GitHub Actions 기본 검증

### 완료 조건

- 새 checkout에서 문서화된 한 명령으로 개발 환경이 뜬다.
- 비밀값 없이 typecheck와 테스트가 통과한다.
- 잘못된 환경 변수는 기동 전에 명확히 거부된다.
- secret scan과 dependency audit 기준이 CI에 존재한다.
- production 수집 전에 최소 임시 보존·삭제 정책과 test manifest가 승인된다.

## Phase 1 — 수집과 원본 보존

### 산출물

- generic webhook 수신기와 signature 검증
- GitHub 저장소/조직 변화 수집기
- RSS/Atom 수집기
- raw event, source, cursor 저장소
- DB-backed queue, retry, dead-letter

### 완료 조건

- GitHub와 feed fixture를 반복 주입해도 raw event가 논리적으로 중복되지 않는다.
- 프로세스를 수집 중 종료하고 재시작해도 cursor가 복구된다.
- 실패한 출처가 다른 출처의 수집을 막지 않는다.
- 원본 checksum과 수집 메타데이터가 보존된다.

## Phase 2 — 정규화, 중복 제거, 분류·요약

### 산출물

- 공통 `SourceItem` schema와 source별 normalizer
- 외부 ID, URL, fingerprint 기반 deduplication
- taxonomy와 rule/model classifier
- item summary와 briefing composer
- 모델 호출 예산, cache, schema validation

### 완료 조건

- 고정 corpus에서 중복/비중복 기대 결과가 재현된다.
- 요약의 모든 항목이 원문 ID와 연결된다.
- 모델 오류·timeout·잘못된 schema가 원본 손실 없이 격리된다.
- 동일 입력과 처리 버전은 불필요한 모델 재호출을 하지 않는다.

## Phase 3 — Discord 개인 허브

### 산출물

- 공식 Discord bot과 slash command 등록
- 허용 사용자·guild·channel 권한 검사
- 구독 생성·수정·해제와 브리핑/검색 명령
- 운영 상태와 실패 조회
- 승인 카드와 만료·취소 흐름

### 완료 조건

- 허용되지 않은 계정과 채널의 명령이 서버 측에서 거부된다.
- Discord reconnect와 process restart 뒤에도 명령 상태가 유지된다.
- 긴 결과가 Discord 제한에 맞게 안전하게 분할된다.
- 승인 message와 실제 승인 레코드가 일치한다.

## Phase 4 — 뉴스레터와 MDX 블로그

### 산출물

- Discord DM과 이메일 delivery adapter
- 일간·주간 `DeliveryBatch` scheduler
- HTML/text 이메일 renderer와 테스트 발송 모드
- MDX content generator, 공개 범위 검사, 정적 블로그
- 발송 이력과 블로그 revision 연결

### 완료 조건

- 하나의 batch가 DM과 테스트 이메일에 같은 항목 집합으로 전달된다.
- 부분 실패 재시도에서 성공한 대상은 중복 발송되지 않는다.
- 주요 이메일 클라이언트용 최소 렌더링 smoke가 통과한다.
- `private` 문서는 공개 빌드와 sitemap/feed에 포함되지 않는다.

## Phase 5 — 개발 작업과 OMP 연결

### 산출물

- `TaskRequest`와 versioned task specification
- 위험 분류와 승인 정책 engine
- OMP execution adapter와 callback/receipt 수집
- GitHub issue/PR/project 결과 연결
- Discord 진행 상태와 완료 보고

### 완료 조건

- 같은 승인과 task revision으로 실행을 중복 dispatch하지 않는다.
- 승인 후 명세가 바뀌면 기존 승인이 자동 무효화된다.
- OMP 실패, blocked, 완료 상태가 Discord와 DB에 동일하게 반영된다.
- 결과 보고서에 대상 revision, 테스트, commit/PR 근거가 연결된다.
- 라피 프로세스에는 직접 코드 수정 경로가 없다.

## Phase 6 — Aside 리서치와 운영 강화

### 산출물

- 승인된 출처별 Aside research job 계약
- 스냅샷/출처와 세션 공개 범위 기록
- 수집 품질·지연·비용 dashboard
- 백업 자동화와 실제 복구 runbook
- 장애·비용·보안 알림과 rate limit

### 완료 조건

- API가 없는 대표 출처의 변경을 지정 주기로 수집한다.
- 사용자 세션에서 얻은 정보가 공개 출력으로 자동 승격되지 않는다.
- VM 재시작, DB 복구, 외부 API 장애 훈련을 통과한다.
- 운영자는 Discord에서 실패 원인과 마지막 성공 시각을 확인할 수 있다.

## Phase 7 — OpenClaw/ZeroClaw 평가

두 런타임을 같은 어댑터 계약과 운영 시나리오로 비교한다.

### 평가 항목

- Discord Gateway, webhook, cron 지원과 복구 동작
- idle/peak CPU·메모리와 장기 실행 안정성
- 작업 격리, 승인 gate, 취소, timeout
- 로그·metric·trace와 장애 진단 가능성
- 배포·업그레이드·rollback 난이도
- OMP dispatch/callback 통합 비용
- 보안 경계와 secret 취급
- 프로젝트 유지보수성과 lock-in

### 결정 조건

- 같은 end-to-end 시나리오와 장애 주입 결과를 기록한다.
- 추측성 feature 비교가 아니라 실제 prototype 증거를 사용한다.
- 선택하지 않은 런타임으로 교체 가능한 port 계약이 유지된다.
- 최종 선택은 ADR로 기록한다.

## 구현 순서에서 미루는 것

- 트래픽 근거 없는 microservice 분리
- 필요가 증명되지 않은 vector DB
- 다중 사용자와 결제
- 완전 자동 공개 게시
- 여러 실행 런타임의 동시 production 운영
- 광범위한 사이트 크롤러
