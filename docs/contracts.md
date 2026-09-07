# 용어와 실행 계약

이 문서는 채널과 런타임 구현이 달라도 지켜야 하는 최소 계약을 정의한다. 실제
JSON schema와 DB migration은 Phase 0에서 이 계약을 바탕으로 만든다.

## 1. 용어

| 용어 | 이 프로젝트에서의 의미 | 신뢰·배포 경계 |
| --- | --- | --- |
| `rapi-core` | 정규화, 중복 제거, 구독, 발송, 승인, 작업 상태를 소유하는 TypeScript 도메인 계층 | VM의 신뢰된 애플리케이션 경계 |
| Aside | API가 없거나 사용자 승인 브라우저 상태가 필요한 지정 출처를 확인하는 브라우저 리서치 실행기 | 별도 사용자 세션이며 결과는 기본적으로 비공개 입력 |
| OMP | 승인된 개발 작업 명세를 받아 코드 수정·검증을 수행하는 외부 실행 harness | 별도 작업공간과 실행 receipt를 가진 비신뢰 callback 발신자 |
| OpenClaw | Discord, webhook, cron, Gateway를 연결하는 초기 실행 계층 후보 | `rapi-core` runtime port 밖의 교체 가능 어댑터 |
| ZeroClaw | 저자원 장기 실행과 승인 gate 관점에서 평가할 대안 runtime | OpenClaw와 같은 port 계약을 구현하는 별도 후보 |
| `DeliveryBatch` | 특정 기간과 구독에 포함할 항목을 동결한 발송 snapshot | 생성 후 항목 집합 불변 |
| 작업 명세 | 목표, 범위, 완료 조건, 권한을 version으로 고정한 OMP 입력 | 승인과 실행은 정확한 revision에 귀속 |

## 2. 식별자와 멱등성

모든 외부 입력과 실행은 안정적인 식별자와 DB unique constraint로 보호한다.

| 대상 | idempotency key 기준 | 중복 시 처리 |
| --- | --- | --- |
| 원본 이벤트 | `source_id + external_event_id`; 외부 ID가 없으면 `source_id + canonical_payload_hash` | 기존 raw event를 반환하고 새 처리 작업을 만들지 않음 |
| 정규화 항목 | `raw_event_id + normalizer_version` | 기존 결과 재사용 |
| 모델 결과 | `source_item_ids + purpose + model_policy_version + prompt_version` | 유효한 기존 결과 재사용 |
| 발송 | `delivery_batch_id + channel + recipient_id + renderer_version` | 성공 기록이 있으면 skip, 재시도 가능 실패만 이어서 실행 |
| 작업 dispatch | `task_id + task_revision + executor` | 기존 execution attempt/receipt 반환 |
| callback | `execution_attempt_id + callback_event_id` | 같은 event 무시; 상태 version이 오래된 event는 기록만 하고 적용하지 않음 |

canonical URL과 내용 fingerprint가 같은 항목은 자동 삭제하지 않는다. 강한 외부
식별자가 같을 때만 동일 이벤트로 취급하고, URL/fingerprint/유사도 일치는
`duplicate_candidate` 관계로 기록한다. 자동 병합 기준은 고정 corpus로 검증된 뒤
별도 정책 version으로 활성화한다.

## 3. 상태 전이 규칙

### 발송

- `ready -> sending`은 worker가 lease를 얻을 때만 가능하다.
- 모든 대상이 성공하면 `delivered`, 일부만 실패하면 `partially_failed`다.
- `retrying`은 아직 성공하지 않은 대상만 처리한다.
- 재시도 횟수 또는 만료 시각을 넘긴 일시 실패는 `dead_letter`로 이동한다.
- 영구 실패는 즉시 `dead_letter`로 이동할 수 있다.
- 운영자가 dead-letter를 재개하면 원래 batch를 유지한 새 attempt를 만든다.

### 개발 작업

- `awaiting_approval`의 승인은 정확한 `task_revision`과 권한 범위에 묶인다.
- 승인 뒤 명세가 변경되면 기존 승인을 무효화하고 `awaiting_approval`로 돌아간다.
- `expired`와 `rejected`는 새 revision 없이는 실행할 수 없다.
- `blocked`는 동일 execution attempt를 resume하거나, 정책에 따라 새 attempt로
  retry할 수 있다. 권한 확대가 필요하면 반드시 새 revision과 승인을 만든다.
- `cancelled`는 terminal 상태다. 이미 외부 실행이 시작됐다면 cancel 요청의
  접수와 실제 중단 결과를 각각 기록하며 중단을 성공으로 추정하지 않는다.
- `failed` 재시도는 같은 revision의 새 execution attempt로 만들고 횟수를 제한한다.

## 4. OMP 어댑터 계약

### dispatch 입력

- `task_id`, `task_revision`, `execution_attempt_id`
- 대상 저장소, 기준 revision, 전용 작업공간 참조
- 목표, 비목표, 요구사항, 완료 조건
- 허용 행위와 금지 행위
- 승인 ID, 승인 범위, 만료 시각
- timeout, 결과 보고서 위치, 필요한 검증

### dispatch 응답

- 외부 `receipt_id`
- 접수 시각과 실행기 identity/version
- accepted 또는 rejected 상태와 거절 이유

### callback

- `callback_event_id`, `receipt_id`, `execution_attempt_id`
- 단조 증가하는 `state_version`
- 상태(`running`, `blocked`, `completed`, `failed`, `cancelled`)
- 발생 시각, 원인, 결과 보고서와 증거 참조
- callback signature와 key ID

`rapi-core`는 callback signature, receipt와 attempt 연결, 허용 상태 전이,
`state_version`을 검증한 뒤 적용한다. callback은 적어도 한 번 전달될 수 있다고
가정한다. 순서가 뒤바뀐 오래된 callback은 감사 로그에 남기되 현재 상태를
되돌리지 않는다.

### timeout과 취소

- dispatch timeout은 접수 실패와 실행 실패를 구분한다. receipt 확인 전에는 같은
  idempotency key로 상태를 조회한 뒤에만 재전송한다.
- 실행 timeout은 cancel 요청을 보내고 `cancel_requested_at`을 기록한다.
- cancel 응답이 없으면 `blocked` 또는 `failed`로 운영자에게 알리며 프로세스가
  중단됐다고 간주하지 않는다.

### 결과 증거

완료 callback 자체는 성공 증거가 아니다. 작업 명세가 요구한 테스트 결과,
revision/commit, diff 또는 PR, 결과 보고서가 서로 같은 execution attempt를
가리켜야 `completed`를 최종 확정한다. 필요한 증거가 빠지면 `blocked`다.

## 5. 공개 범위 승격

Aside 세션, 비공개 저장소, Discord DM, 이메일 수신자 정보에서 들어온 항목은
기본 `private`다. `private -> unlisted -> public` 승격에는 출처 공개 범위 검사와
승인 정책 검사가 필요하다. 모델 판단만으로 공개 범위를 높이지 않는다.

## 6. Phase gate 증거

각 Phase를 시작할 때 다음을 test manifest로 고정한다.

- fixture/corpus의 ID와 version
- 임계치, timeout, 재시도 횟수, 대상 이메일 클라이언트와 대표 출처
- 실행 명령과 환경
- 결과 artifact 위치와 revision
- 통과·실패 판정 규칙

로드맵의 “고정 corpus”, “주요 클라이언트”, “대표 출처” 같은 표현은 해당
Phase의 manifest가 구체화한다. manifest가 없으면 그 Phase의 완료를 주장할 수
없다.
