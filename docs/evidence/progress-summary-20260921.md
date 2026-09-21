# Rapi completion progress — 2026-09-21

**현재 상태:** P0 격리 검증 전부 통과, CI green, 그리고 production containment·migration까지 완료했다. worker는 새 코드 배포 전까지 의도적으로 중지 상태로 둔다. 남은 것은 신규 코드 배포(R30~R32)와 실제 전달 흐름·사람 QA다.

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
- **CI run evidence:** `codex/rapi-completion-owner` @ `8ae1ceb` — CI run 35582173248 전 gate 통과(check, web-proxy, e2e, restart/restore smoke, audit, secret-scan, gate summary). 중간 실패 run들은 CI 자체 결함 3건을 드러내 수정했다(아래 참조).
- **Production 운영 evidence(2026-09-21, 사용자 승인 하):**
  - R00 baseline 재확인: migrations 0001~0007, batches ready=1/delivered=1/failed=598, attempts temporary_failure=897/success=2 — 실패가 지속 증가 중이던 상태.
  - R01: `rapi-worker.service` 중지(09:16:58Z, inactive/dead). 중지 후 attempts 899에서 동결, 마지막 attempt 09:09:32 — drain 확인.
  - R20: `rapi-20260921T030130Z.dump`를 격리 DB(`rapi-rehearsal-20260921`)에 복원 — 7 migrations/27 tables/데이터 보존 확인.
  - R21 rehearsal: snapshot에 0008~0012 적용 성공 → 12 records/31 tables, 기존 row 보존.
  - R07 inventory: sources 4 + subscriptions 2 = **전부 fixture, live 0, ambiguous 0**.
  - R08 manifest: `deactivateSubscriptionIds` 2건, snapshot 리허설에서 UPDATE 2 정확히 적용.
  - R09 production quarantine apply: 트랜잭션으로 UPDATE 2 — 두 fixture subscription `active=false`로 커밋. live row 없음.
  - R22: drain·quarantine 직후 신규 backup(`rapi-20260921T092202Z.dump`) 생성 후 migrate로 0008~0012 적용. 사후 검증: 12 migrations, 31 tables, `uncertain` CHECK + `lease_expires_at` 존재. bot/chat/omp ready:true, monitor는 중지된 worker를 `failed`로 정확히 보고(의도된 상태).

## 검증 중 발견·수정한 실제 결함 (2026-09-21 후속)

- `compose.test.yaml`의 postgres 데이터가 `tmpfs`라 컨테이너 재시작 시 초기화되어 restart smoke가 구조적으로 불통이었다. anonymous volume으로 교체해 격리(`down --volumes`)를 유지하면서 재시작 내구성을 검증 가능하게 했다.
- `restart-smoke.sh`가 `compose restart` 직후 `pg_isready`를 한 번만 호출해 아직 기동 중인 DB에서 exit 2로 flake했다. 30회 bounded retry + 최종 단일 assert로 수정했다.
- `0012_delivery_uncertain.sql`이 `schema_migrations` insert와 트랜잭션 래핑을 빠뜨려 migrate가 매번 재적용하고 exact-set 검증이 실패했다. 0011과 같은 `BEGIN/COMMIT + INSERT ... ON CONFLICT` 형식으로 수정했다 — restore smoke의 verifier가 실제 drift를 잡아낸 사례다.
- `restore-smoke.sh`의 fallback이 존재하지 않는 `rapi` DB를 dump해 CI에서 항상 실패했다. 격리 컨테이너의 `rapi_test`에 migrate 후 dump하는 self-contained 경로로 수정하고, cleanup에 `down --volumes`를 추가해 잔여 컨테이너를 없앴다.
- compose healthcheck·verify-db·restart-smoke의 `pg_isready`가 unix socket을 쳐서 docker-entrypoint의 init 임시 서버(`listen_addresses=''`)에서도 성공했다 — `db:verify`는 "system is shutting down", restart-smoke는 `57P03 starting up`으로 CI에서 flake했다. 모두 TCP(`-h 127.0.0.1 -p 5432`) probe로 바꿔 최종 리스너만 readiness로 인정하게 했다.
- `test:e2e`가 workspace `dist` export에 의존하면서도 build하지 않아 check skip 시 `ERR_MODULE_NOT_FOUND`로 실패했다. 스크립트에 `npm run build`를 추가해 self-contained로 만들었다.
- `buildQuarantineUpdate`가 존재하지 않는 `subscriptions.state`를 갱신하는 SQL을 생성했다(실제 컬럼은 `active boolean`). 문자열 contract 테스트가 스키마와 어긋난 채 통과 중이던 결함 — `SET active=false`로 수정하고 migrated 격리 DB에서 UPDATE 2·live row 보존을 실증했다.

## 미검증·외부 경계

- 격리 E2E·restart/restore·production quarantine apply·production migration(0008~0012)·backup은 완료됐다.
- 신규 코드의 production 배포(R30~R32: deploy-revision.sh 미구현), 실제 Discord/이메일 수집→브리핑→발송, deployment/rollback, 사람 QA는 미검증이다.
- `rapi-worker.service`는 containment 유지를 위해 중지 상태로 남겨뒀다. 새 코드 배포 시점에 재시작이 필요하다.

## Worktree 정리 상태

- consolidation target은 이 worktree: `/Users/justn/dev/.worktrees/rapi-completion-owner` (dirty 변경·검증 evidence 보존).
- clean·통합 완료 또는 빈-diff task worktree 10개는 Herdr authoritative remove 후 `git worktree prune`으로 metadata를 정리했다: R08, R08b, R08c, R10, R17c, R23, R66, R67, R68, R68b.
- dirty/evidence worktree와 main checkout은 보존한다. 상세 task manifest는 `docs/evidence/worktree-consolidation-20260921/manifest.tsv`에 생성 중이며, 이 요약 작성 시점에는 original diff consolidation이 아직 완료되지 않았다.

## 재개 첫 작업

~~Docker 인증 후 isolated E2E/restart/restore~~, ~~CI green~~, ~~production containment(R01/R09)·migration(R20~R22)~~ — 전부 완료. 다음은 P1 배포 체인이다: R30 `scripts/deploy-revision.sh` 작성 → R31 switch 리허설 → R32 승인 배포 + loaded revision 검증 후 worker 재시작. 배포 없이는 worker를 재시작하지 않는다(구 코드 재시작은 fixture 발송을 재개할 수 있다).

## 증거 구분

- **로컬:** source diff, format/typecheck/lint, `npm run check`, web-proxy test, dependency audit.
- **합성:** mocked Discord failure, pure cadence/health/quarantine/artifact/migration-set tests, script safety tests.
- **실제 runtime(격리):** `test:e2e` 17/17, restart smoke `0:0:1` 동일, restore smoke 31 tables/12 migrations/105 constraints + exact migration set.
- **운영/사람 QA:** 현재 미검증. 외부 자격증명·운영 승인·사람 관찰이 필요한 경계다.
