# MVP 검증 기록

검증 기준은 `tests/manifests/mvp.yaml`이며 `npm run bootstrap`이 새 checkout 기준
설치, migration, 정적 검사, PostgreSQL E2E, DB 재시작, 백업 복구를 순서대로 실행한다.

| 완료 조건 | 구현 | 증거 |
| --- | --- | --- |
| GitHub/RSS 원본·정규화 저장 | source adapter, `raw_events`, `source_items` | E2E fixture 재주입 후 각 2건 |
| 중복 발송 방지 | raw unique index, batch snapshot, delivery idempotency key | 성공한 DM은 이메일 재시도 때 다시 발송되지 않음 |
| Discord 구독과 DM | 서명 검증 HTTP endpoint, allowlist, slash command service, Discord REST adapter | `/subscribe`와 `/brief` E2E |
| 동일한 테스트 이메일 | frozen batch renderer, SMTP multipart adapter | DM/email의 item ID snapshot 동일성 및 text/HTML link 검사 |
| 공개 MDX 빌드 | visibility hard deny, clean public build | public 1건만 생성되고 private 문서 제외 |
| 승인된 OMP 실행 | versioned task, revision-bound approval, HTTP adapter, signed callback | 중복 dispatch 1회, 완료 증거와 Discord 상태 알림 검사 |
| 재시작 복구 | PostgreSQL cursor, attempts, callback state | store 재생성 및 실제 PostgreSQL restart 전후 count 동일 |
| 잘못된 Discord identity 거부 | user/guild/channel allowlist | 세 가지 서버 측 거부 검사 |

추가 운영 검증으로 production dependency audit, 빈 DB의 migration 2개 자동 적용,
PostgreSQL dump/restore smoke를 수행한다. 실제 Discord, SMTP, GitHub, OMP 호출에는
소유자가 발급한 자격 증명이 필요하며 값은 저장소에 포함하지 않는다.
