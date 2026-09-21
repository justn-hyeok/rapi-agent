# Rapi completion progress — 2026-09-21

**현재 상태:** 출시 차단 P0의 로컬 안전장치와 합성 검증이 구현됐고, 같은 날 후속으로 Docker 기반 실제 DB E2E·restart/restore smoke도 격리 환경에서 통과했다. 남은 것은 실제 전달 흐름·production 데이터·운영 승인 경계다.

## 이번에 구현·수정한 핵심 작업

- Delivery loop가 빈 결과(`idle`), 성공 전달, 실패, 비활성 상태를 구분하고 실패가 이전 성공보다 우선하도록 readiness를 보강했다.
- Discord message POST의 네트워크 단절을 `UncertainDeliveryError`로 분리하고, DB acknowledgement가 불확실한 전달은 terminal `uncertain` 상태로 기록·재전송 차단하도록 0012 migration과 agent/store 흐름을 추가했다.
- daily/weekly timezone cadence window, concurrent frozen batch 생성, empty batch 외부 전송 방지, attempt lease 및 retry 경로를 보강했다.
- migration set verifier와 bot readiness의 schema drift 확인을 추가했다. restart/restore smoke는 격리 Compose project·DB만 허용하고 결과 artifact를 남기도록 준비했다.
- fixture inventory/manifest, test DB admission, quarantine manifest·SQL contract·explicit test-only apply guard를 추가했다. production apply는 수행하지 않았다.
- CI가 check, web-proxy, E2E/restart/restore/audit outcome과 smoke artifact를 수집하도록 보강했다.

## 직접 통과한 검증

- owner worktree에서 마지막으로 `npm run check`를 실행해 **164/164 tests**, format, typecheck, lint를 통과했다. (0012·compose.test.yaml·restart-smoke.sh 수정 후 재실행도 동일하게 통과)
- `npm run web-proxy:test`는 **4/4** 통과했고, `npm run audit:prod`는 high 이상 취약점 **0**을 보고했다.
- **후속 실제 DB 검증(2026-09-21, Docker 복구 후):**
  - `npm run test:e2e` — 격리 Compose project(`rapi-e2e-$$`)에서 migration 0001~0012 전부 적용, 동시 migrator 2개 경쟁·실패-롤백-복구 드릴 포함 **17/17** 통과. artifact: `tests/artifacts/mvp-e2e.json`.
  - `npm run restart:smoke` — `RESTART_SMOKE_PROJECT=rapi-restart-local-20260921d`, 재시작 전후 count `0:0:1` 동일 확인. artifact: `tests/artifacts/restart-smoke.json`.
  - `npm run restore:smoke` — full-migrated dump(`BACKUP_FILE`) 복원, **31 tables / 12 migration records / 105 constraints**, `verify-migration-set` exact set 일치. artifact: `tests/artifacts/restore-smoke.json`.
- focused synthetic evidence: Discord uncertain/HTTP failure 경계, delivery readiness, migration-set verifier, fixture classifier/manifest, quarantine guards·parameterized SQL contract, restart/restore artifact 및 target safety tests.
- 모든 새/재시도 Devin worker는 `--model swe-2 --permission-mode dangerous` argv를 확인했고, 완료·통합 후 owned pane만 닫았다. 빈 diff worker 결과는 거절했으며 worktree는 보존했다.

## 검증 중 발견·수정한 실제 결함 (2026-09-21 후속)

- `compose.test.yaml`의 postgres 데이터가 `tmpfs`라 컨테이너 재시작 시 초기화되어 restart smoke가 구조적으로 불통이었다. anonymous volume으로 교체해 격리(`down --volumes`)를 유지하면서 재시작 내구성을 검증 가능하게 했다.
- `restart-smoke.sh`가 `compose restart` 직후 `pg_isready`를 한 번만 호출해 아직 기동 중인 DB에서 exit 2로 flake했다. 30회 bounded retry + 최종 단일 assert로 수정했다.
- `0012_delivery_uncertain.sql`이 `schema_migrations` insert와 트랜잭션 래핑을 빠뜨려 migrate가 매번 재적용하고 exact-set 검증이 실패했다. 0011과 같은 `BEGIN/COMMIT + INSERT ... ON CONFLICT` 형식으로 수정했다 — restore smoke의 verifier가 실제 drift를 잡아낸 사례다.

## 미검증·외부 경계

- test Compose E2E, migration 0011/0012 적용, restart/restore drill은 격리 Docker에서 검증됐다. fixture quarantine의 production apply transaction은 미검증이다.
- 실제 Discord/이메일 수집→브리핑→발송, GitHub CI run, production backup/restore·migration, deployment/rollback, 사람 QA는 실행하지 않았다. 외부 자격증명·운영 권한·승인 없이는 수행하지 않는다.

## Worktree 정리 상태

- consolidation target은 이 worktree: `/Users/justn/dev/.worktrees/rapi-completion-owner` (dirty 변경·검증 evidence 보존).
- clean·통합 완료 또는 빈-diff task worktree 10개는 Herdr authoritative remove 후 `git worktree prune`으로 metadata를 정리했다: R08, R08b, R08c, R10, R17c, R23, R66, R67, R68, R68b.
- dirty/evidence worktree와 main checkout은 보존한다. 상세 task manifest는 `docs/evidence/worktree-consolidation-20260921/manifest.tsv`에 생성 중이며, 이 요약 작성 시점에는 original diff consolidation이 아직 완료되지 않았다.

## 재개 첫 작업

~~Docker 인증 후 isolated E2E/restart/restore~~ — 완료(상단 후속 검증 참조). 다음은 R29 잔여인 CI run evidence 확보와, 운영 승인이 필요한 R01(worker 중지)→R09(fixture quarantine apply)→R20~R22(production restore rehearsal·migration) 경계다. owner diff review로 이번 후속 수정 3건(compose.test.yaml volume, restart-smoke retry, 0012 schema_migrations)을 승인할지 결정한다.

## 증거 구분

- **로컬:** source diff, format/typecheck/lint, `npm run check`, web-proxy test, dependency audit.
- **합성:** mocked Discord failure, pure cadence/health/quarantine/artifact/migration-set tests, script safety tests.
- **실제 runtime(격리):** `test:e2e` 17/17, restart smoke `0:0:1` 동일, restore smoke 31 tables/12 migrations/105 constraints + exact migration set.
- **운영/사람 QA:** 현재 미검증. 외부 자격증명·운영 승인·사람 관찰이 필요한 경계다.
