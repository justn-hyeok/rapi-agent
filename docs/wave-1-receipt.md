# Wave 1: launch contract and owner decisions

Base: 6627035. Owner pane w5D:p1. Native goal active with no token budget.
Model discovery: Devin supports family swe-2. Meter: uncovered provider.
Commands use interactive Herdr agent start with literal --model swe-2.

| Task | Worker | Worktree | Pane | Placement | Allowed diff | Oracle | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R02 | rapi-r02-swe2 | /Users/justn/dev/.worktrees/rapi-r02-check-order | w5D:p2 | placement.py right of w5D:p1, ratio .35, no-focus | package.json check ordering only | npm ci && npm run clean && npm run check | pending |
| R03 | rapi-r03-swe2 | /Users/justn/dev/.worktrees/rapi-r03-delivery-result | w5D:p3 | placement.py down from w5D:p2, ratio .5, no-focus | workers/runtime/src/delivery-result.ts; tests/delivery-result.test.ts | node --import tsx --test tests/delivery-result.test.ts | pending |

R02 owner decision: ACCEPT (local only). Reviewed the one-line package.json
diff; all four original gates retained, no dependency changes. Independently
ran npm ci && npm run clean && npm run check serially in its task worktree:
exit 0, 101/101 tests, no failures/skips. Integrated exact line into owner
worktree. CI/production unchanged and not claimed fixed until approved push.

R03 launch helper timed out while the real Devin TUI was working. Continued
using exact pane w5D:p3; no restart, fallback or duplicate process. Both live
TUIs displayed SWE-2 High. Read-only and local npm approvals were approved once
by owner under the user's existing implementation/verification authorization.

R00 refreshed baseline at 2026-09-20T17:36:45.694Z: read-only DB transaction;
migrations 0001–0007, batches ready=1/delivered=1/failed=566, attempts
success=2/temporary_failure=849. Worker active since 2026-09-15 07:09 UTC;
readiness still ready=true and delivery=ok. Production mutation not performed.

R03 first session ended with "Canceled due to user interrupt" before any file
change (cause unconfirmed). Owner's attempted follow-up found agent absent and
pane at shell. One narrowed retry launched in same dedicated worktree/pane as
rapi-r03-retry, exact --model swe-2. No further retry/model fallback allowed.

R03 partial candidate review: the 15-line pure function exactly matches the
specified empty/delivered/other contract and changes no unrelated file. It is
preserved in the owner worktree, but R03 remains unaccepted because its required
focused test file and oracle are absent. R03a is a separate test-only task.

R03/R03a owner decision: ACCEPT (local only). Reviewed the pure function and
test-only diff; the state matrix covers idle, all delivered, each designated
failure state, unknown state and mixed states. Independently ran
npm ci && node --import tsx --test tests/delivery-result.test.ts in the task
worktree: 5/5 pass. Integrated both exact files; runtime wiring remains R04.

R05 owner decision: ACCEPT (local only). Reviewed the one schema field and
four-value parsing test. Independently ran npm ci && node --import tsx --test
tests/config.test.ts in the task worktree: 7/7 pass. DELIVERY_ENABLED defaults
to true and only R06 will consume it in the worker.

R04 worker decision: REJECT. The worker began an untested, entrypoint-wide
startup refactor, outside the smallest viable integration boundary. Its partial
diff remains preserved in its dedicated worktree and was not integrated. Owner
implemented a separate pure delivery-loop guard, wired the existing deliver
call to it, and added focused behavior tests. Failed batch outcomes now reach
runLoop's error path; empty outcomes remain non-error idle outcomes.

R04 owner decision: ACCEPT (local only). The focused delivery-result and
delivery-loop tests passed 7/7, then the combined npm run check passed 109/109.
The final runtime change is a one-line call to the isolated helper. No worker
is active after pane closure.

R18 owner decision: ACCEPT (local only). Verified the CLI's limited filesystem
inputs, JSON output and exit rules, plus missing/unexpected/argument cases.
Independently ran npm ci && node --import tsx --test
tests/verify-migration-set.test.ts: 4/4 pass. This verifier is not yet wired
to a live DB or restore script; R19 owns that integration.

R06 owner implementation: delivery scheduling is gated at both initial startup
and interval creation. Disabled delivery does not invoke the transport loop,
while collection and webhook loops remain unchanged. The health presentation of
disabled delivery is deliberately deferred to R24.

R10 worker decision: REJECT. The worker made no scoped diff before repeated
test-convention exploration. Owner added the pure loopback/rapi_test admission
helper and focused URL matrix; later R10 follow-up wiring may consume it.

R10 owner decision: ACCEPT (local helper only). The admission matrix rejects
production-name, remote-host, query override and malformed URLs while accepting
only loopback /rapi_test inputs. Whole check then passed 119/119.

R24 owner implementation: delivery disabled state is explicit in readiness and
is no longer a required component. Failed enabled delivery remains required and
uses the R04 error path.

R25 owner implementation: source readiness now counts only github/RSS sources
the worker can actually collect. Active Aside or other unsupported sources
produce an explicit failed source component instead of a false healthy count.

R27 Terra decision: ACCEPT (local workflow candidate only). Verified the exact
single step is ordered after check and before E2E, then independently ran
npm ci && npm run web-proxy:test: 4/4 pass. GitHub CI remains unverified until
an authorized push triggers it.

R11a Terra decision: ACCEPT (local only). Verified timezone day boundary,
Monday-start weekly keys and invalid-zone behavior. Independently reran
npm ci && node --import tsx --test tests/delivery-period.test.ts: 4/4 pass.
Scheduler and database use of this key remain R12/R13 work.

R07 Terra decision: ACCEPT (local only). Reviewed the exact fixture sentinels,
ambiguous-identity fail-safe, and CLI's file-only input path. Independently
reran npm ci && node --import tsx --test tests/fixture-inventory.test.ts:
8/8 pass. Production snapshot extraction and quarantine remain R07/R08
operational steps and were not run.

R08 Terra decision: ACCEPT (local only). Reviewed manifest selection,
retention-only fixture rows and ambiguous-input fail-closed behavior.
Independently reran npm ci && node --import tsx --test
tests/fixture-quarantine-manifest.test.ts: 10/10 pass. Applying a manifest to
production remains the separately authorized R09 operation.

R67 worker decision: REJECT. The worker produced no diff before exhausting the
bounded exploration window. Terra implemented the explicit disposable project
and database gate directly; Docker-free invalid-target tests cover the
fail-before-Docker invariant.

Workers: maximum two Todo items, no subagents, no commits or external changes.
One narrowed retry allowed; no model replacement. Runtime registration and live
Devin UI must be checked before launch is claimed successful.

R19 Terra implementation: restore smoke now extracts the restored target's
schema_migrations into an isolated JSON file and invokes the exact migration-set
verifier before accepting the restore.

R12 worker decision: REJECT. The worker produced no scheduler diff before
bounded exploration ended. Terra added IANA-local half-open windows and
connected stable windows to scheduled delivery batches. Period tests cover UTC
and Seoul; database-backed scheduling evidence remains pending Docker recovery.

R15 Terra decision: ACCEPT (source/typecheck only). Lease claim migration and
atomic retry claim preserve a maximum of three failed sends; E2E concurrency is
pending Docker recovery.

R16 Terra decision: ACCEPT (source/typecheck only). The same-attempt bounded
retry scenario now proves two temporary retries, terminal permanent failure,
lease release, and no new batch. E2E execution remains pending Docker recovery.

R13 Terra decision: ACCEPT (source/typecheck only). The transaction now uses
insert-or-read under the existing unique constraint, and a PostgreSQL E2E
concurrency scenario asserts one batch ID and row. Docker was unavailable, so
the new E2E remains unverified.
