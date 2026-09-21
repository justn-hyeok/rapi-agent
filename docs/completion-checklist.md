# Rapi completion: atomic execution ledger

Base: `6627035fc8ff474f5445ff1a5e8dbc5102171c7e`. Owner: current Codex/Astra
session. Implementation: interactive Devin CLI, exact `--model swe-2`, never a
default or substituted model. At most two sibling workers; one task per worker,
at most two Todo items, no subagents, no commit/push/merge/deploy/release or
worktree deletion. A candidate requires owner diff review and independent
verification before acceptance. One narrowed retry maximum per blocked task.

## Evidence and authority

L = local source/static checks; S = synthetic disposable data; R = real process;
D = production deployment/data/external provider; H = human observation.
Every row has ONE primary artifact and ONE decisive oracle. Test files listed
with a module belong to that single behavioral change. Commands mentioned for
future artifacts become runnable only after the named task creates them.

Permissions: C = local code authorized; O = production stop/data mutation needs
specific approval; X = actual external send/account/model charge needs approval;
G = commit/push/merge/release needs approval; H = participant consent/availability.
No worker receives O/X/G credentials. Owner prepares reviewable changes first.

Current evidence: build followed by check passed 101 tests in prior analysis;
clean check failed with 951 lint errors, and CI failed likewise. Both typecheck
and build were previously launched concurrently, so their first-run ordering is
not independent proof; reproduce serially. Production failure counts are fixture
target attempts, NOT a measured real-user delivery failure rate. MDX and OMP DB
success records are fixture evidence. Database backup/restore already exists,
but it checks minimum table/migration counts rather than exact current schema.
Source absence is not proof of a previously deployed process using latest dist.
Do not claim that an on-disk HEAD proves the running loaded code revision.

## P0: containment and release blockers

| ID | Priority | Depends | Exact scope and observable change | Single artifact | Primary oracle / done | Failure and rollback | Evidence / permission |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R00 | P0 | — | Read service states and aggregate DB baseline, no content/secrets | baseline receipt | before-state has SHA, service, schema and count timestamps | unavailable fields remain unverified | R,D / read |
| R01 | P0 | R00 | Stop only rapi-worker.service after explicit operational approval | stop receipt | two delivery intervals produce zero new attempts | unintended service impact: restore prior worker state only with approval | R,D / O |
| R02 | P0 | — | package.json check script runs typecheck before type-aware lint | package.json diff | serial clean build-state npm run check exits 0 | check fails: reject diff, preserve evidence | L,S / C |
| R03 | P0 | — | New workers/runtime/src/delivery-result.ts classifies returned batch states; focused test | delivery assessment module diff | failed/partial/unknown rejected, all-delivered accepted, empty explicitly idle | ambiguous success or changed unrelated file: reject | L,S / C |
| R04 | P0 | R03 | workers/runtime/src/run.ts consumes assessment instead of discarding statuses; focused test | worker integration diff | failure result cannot advance loop lastSuccessAt | test fails: withhold integration | S / C |
| R05 | P0 | — | packages/config/src/index.ts adds validated delivery enable switch; tests/config.test.ts | config switch diff | invalid switch rejected and default compatibility asserted | default surprises: reject | L,S / C |
| R06 | P0 | R04,R05 | workers/runtime/src/run.ts gates initial/timer delivery, preserves other loops | delivery gate diff | disabled mode makes zero delivery calls and exposes disabled reason | any send when disabled: reject | S / C |
| R07 | P0 | R00 | scripts/fixture-inventory.mjs read-only exact fixture identity classifier | inventory JSON | fixture/live/ambiguous rows separated by stable IDs without secrets | ambiguity retained, no updates | D / C then read |
| R08 | P0 | R07 | scripts/quarantine-fixtures.mjs exact-ID approved manifest; deactivate subscriptions only | quarantine command diff | isolated mixed fixture/live DB keeps live rows byte-equivalent | manifest/count mismatch rolls transaction back | S / C |
| R09 | P0 | R01,R08,R20 | Apply approved subscription quarantine manifest to production | quarantine receipt | active fixture subscriptions zero; records retained | unexpected rows: rollback transaction | D / O |
| R10 | P0 | — | tests/e2e DB admission helper rejects production/mismatched database and shared unsafe DSNs | DB admission diff | hostile connection matrix rejected before connect | any production connection: reject | S / C |
| R11 | P0 | — | packages/core/src/domain/delivery-period.ts computes daily/weekly timezone buckets; focused test | period function diff | fixed boundary corpus, KST and DST transitions | ambiguous weekly anchor requires product decision | S / C |
| R12 | P0 | R11 | RapiAgent.runScheduledDeliveries uses canonical buckets, not rolling now | scheduler diff | repeated ticks request identical bucket until next period | changed daily semantics outside contract: reject | S / C |
| R13 | P0 | R12 | PostgresStore.freezeBatch handles concurrent identical bucket inserts | atomic batch diff | two concurrent calls yield one batch | duplicates/deadlocks: reject | S / C |
| R14 | P0 | R13 | Empty batch records no external delivery | empty-batch diff | zero-item batch produces zero transport calls | empty false delivery success: reject | S / C |
| R15 | P0 | R13 | Delivery attempt claim uses transaction/lease rather than unguarded SELECT | attempt claim diff | competing workers produce one active sender | concurrent sends: reject | S / C |
| R16 | P0 | R15 | Scheduler resumes eligible failed attempts on same frozen batch with bounded retries | retry-selection diff | same batch retries to terminal without new batch | retry creates new batch: reject | S / C |
| R17 | P0 | R16 | Transport accepted but DB acknowledgement lost is explicit uncertain delivery | uncertain-result diff | crash window is surfaced without claiming exactly-once | automatic unsafe resend: reject | S / C |
| R18 | P0 | — | scripts/verify-migration-set.mjs compares filenames to applied migration names | schema-set verifier diff | 0007 fixture fails; 0010 exact set passes; unknown names reported | false pass with missing name: reject | S / C |
| R19 | P0 | R18,R67 | scripts/restore-smoke.sh calls exact migration-set verifier on restored target | restore gate diff | old incomplete restore fails exact-set check | restore touches source DB: reject | S / C |
| R20 | P0 | R19,R67 | Restore existing production dump into disposable isolated DB | restore receipt | data counts and exact pre-upgrade schema match source snapshot | never overwrite source DB; retain failed artifact | S,D / O for data handling |
| R21 | P0 | R18,R20 | Apply existing 0008~0010 only to restored snapshot | upgrade rehearsal receipt | pending migrations zero and old rows preserved | transaction failure: keep production untouched | S / C |
| R22 | P0 | R09,R21,R29 | Apply 0008~0010 to drained production after fresh backup | migration receipt | exact repository set and smoke pass | abort rollout; no blind down-migration | D / O |
| R23 | P0 | R18 | Required schema-set check participates in bot readiness | schema readiness diff | missing 0008 returns non-ready while liveness remains 200 | schema drift returns ready: reject | S / C |
| R24 | P0 | R04 | Readiness reports actual recent delivery outcomes, separate idle and disabled | delivery health diff | latest failure dominates previous loop success | false green: reject | S / C |
| R25 | P0 | — | Source readiness excludes unsupported Aside from healthy collector count | source health diff | only unsupported source cannot report healthy collection | silent healthy unsupported source: reject | S / C |
| R26 | P0 | — | Task status labels over-age running execution stale without killing guessed PID | stale status diff | old running fixture displays stale/unknown | status implies actual process termination: reject | S / C |
| R27 | P0 | R02 | CI runs web-proxy:test as independent existing command | CI proxy gate diff | exact-SHA CI includes passing four proxy tests | unrelated workflow changes: reject | L then D / C,G |
| R28 | P0 | R02,R10 | CI records E2E SHA/environment and cannot count skipped downstream gates as green | CI evidence diff | clean CI has E2E/restart/restore results, no missing artifact | any missing gate: no acceptance | S,D / C,G |
| R29 | P0 | R66,R67,R68,R02,R04,R06,R12,R13,R14,R15,R16,R17,R19,R23,R24,R25,R26,R27,R28 | Owner combines accepted patches and runs isolated release candidate suite | candidate verification receipt | npm ci, check, test:e2e, proxy, audit all pass serially on recorded diff digest | any failure returns only offending atomic task for one retry | L,S / C |

## P1: real product outcomes and release gate

| ID | Priority | Depends | Exact scope and observable change | Single artifact | Primary oracle / done | Failure and rollback | Evidence / permission |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R30 | P1 | R29 | scripts/deploy-revision.sh validates SHA/diff and prepares versioned release without switching service | staged release manifest | fresh installation reproduces candidate suite | source/manifest mismatch aborts | L,S / C |
| R31 | P1 | R30 | Deployment switch drains and switches one service set with recorded previous artifact | deployment switch diff | isolated switch failure restores previous running artifact | no prior artifact: refuse switch | S / C |
| R32 | P1 | R22,R31 | Owner deploys approved candidate and verifies loaded service revision | deployment receipt | service boot revision, DB schema and manifest agree | readiness failure restores previous compatible app | R,D / O,G |
| R33 | P1 | R32 | Register one approved real RSS source (not fixture) | real-source receipt | new raw event retains original payload and source timestamp | invalid source disabled, rows preserved | D / O |
| R34 | P1 | R33 | Source HTTP adapter adds bounded request/body timeout; focused test | source timeout diff | hanging source terminates and other collector finishes | interruption loses cursor/raw event: reject | S / C |
| R35 | P1 | R34 | Source raw persistence stores original provider payload before normalization | raw provenance diff | malformed normalizer retains verifiable raw payload | irreversible loss: reject | S / C |
| R36 | P1 | R35 | Summary port returns schema-validated source-linked result with explicit excerpt fallback | summary contract diff | malformed model output yields labeled fallback and preserves source | unsupported claim presented as fact: reject | S / C |
| R37 | P1 | R36 | Summary cache binds input digest, prompt and model policy version | summary cache diff | identical input/version makes one model call | stale result reused after version change: reject | S / C |
| R38 | P1 | R37 | Run approved model on small real corpus | corpus receipt | each summary checked against original sources | quality threshold unmet: retain excerpt label | R,H / X,H |
| R39 | P1 | R32,R33,R38 | Create one consented Discord-only subscription and deliver fixed batch | Discord receipt | user sees one correct DM with source links; replay sends none | failure quarantines exact subscription, not whole bot | D,H / O,X,H |
| R40 | P1 | — | SMTP response reader terminates on timeout/error/close; focused local server test | SMTP lifecycle diff | silent/closed server rejects boundedly without hang | unresolved promise or leaked socket: reject | S / C |
| R41 | P1 | R40 | SMTP response classification distinguishes retryable, permanent, uncertain outcome | SMTP classification diff | response/crash matrix maps correctly | uncertain marked successful: reject | S / C |
| R42 | P1 | R41 | Configure designated sender credential and consented test recipient | email configuration receipt | provider auth succeeds with secret-free receipt | auth failure: disable transport, keep old secret reference | D / O,X |
| R43 | P1 | R39,R42 | Deliver same frozen batch to test email recipient | email receipt | human verifies item set equals Discord, text/HTML links work | duplication or mismatch blocks milestone | D,H / X,H |
| R44 | P1 | R32 | Probe selected OMP provider authentication with bounded approved task | provider receipt | real request works, not just auth-file presence | auth needed: pause this path without substituting provider | R / X |
| R45 | P1 | R44 | Execute one approved revision in disposable repository through slash/approval path | OMP receipt | report/test/revision correspond to same attempt | mismatch remains blocked, never completed | R,D,H / X,H |
| R46 | P1 | R45 | Cancel one disposable active execution through real entrypoint | cancellation receipt | exact child exited and state agrees | unknown external descendants reported unknown | R,D,H / X,H |
| R47 | P1 | R32 | MDX publisher parses frontmatter visibility structurally, not whole-body regex | MDX visibility diff | private body containing visibility: public never publishes | leaked private fixture: reject | S / C |
| R48 | P1 | R47 | Render generated MDX in agreed existing blog integration with unsafe syntax escaped | rendered preview | public page renders, private absent from output/feed | integration crosses another repo: ask before writing | S,R / C plus scope approval |
| R49 | P1 | R48 | Publish one consented public briefing to designated host | publication receipt | real URL matches approved content/revision | accidental disclosure triggers exact artifact rollback | D,H / X,O,H |
| R50 | P1 | R31,R32 | Rehearse app rollback to exact previous compatible revision in isolated deployment | rollback receipt | user smoke works after rollback with preserved state | incompatible schema: abort, use documented recovery | S,R / C |
| R51 | P1 | R19,R32 | Restore current backup to isolated DB and boot same candidate against it | app restore receipt | core read smoke and integrity pass after restore | retain failed drill; never replace production automatically | S,R / O |
| R52 | P1 | R39,R43,R45,R46,R49,R50,R51 | Owner observes production over approved cadence windows | observation receipt | no unexplained loss/duplicates, failure and recovery visible | incident reopens exact causal task | D / read |
| R53 | P1 | R52 | Consented owner completes subscription/search/receipt/failure-recovery flow | human QA receipt | person confirms useful briefing and correct error guidance | failed flow prevents personal-release acceptance | H / H |
| R54 | P1 | R53 | README and MVP verification claims cite exact evidence and excluded capabilities | release claims diff | every completion assertion maps to L/S/R/D/H artifact | unsupported assertion removed, not marked done | L / C |
| R55 | P1 | R54 | Decide and record owner-only release versus public community release | scope decision | user explicitly chooses scope; public unavailable features not advertised | no choice: no public-release claim | H / user decision |
| R56 | P1 | R55,R22 | Enable isolated public-agent only for approved community scope | public-agent readiness receipt | real isolated question, no application secrets exposed | failure disables exact service | R,D / O,X |
| R57 | P1 | R55,R22 | Enable allowlist gateway/tunnel with approved hostname | ingress receipt | forbidden routes blocked and signed allowed interaction passes | mismatch reverts route/service changes | D / O,X |
| R58 | P1 | R56,R57 | Apply previewed Discord role/channel plan to designated test guild | community configuration receipt | approved plan digest matches applied snapshot | drift refuses application, no deletion by guess | D / O,X |
| R59 | P1 | R58 | Human checks USER/ADMIN/SUPERADMIN denial and quota boundary | tier QA receipt | each tier sees only granted data/actions | privilege leak blocks public release | D,H / X,H |
| R60 | P1 | R54,R55 | Publish approved exact revision with release evidence after all selected gates | release receipt | published SHA equals verified artifact | any gate missing: no publication | D / G |

## P2: after selected release

| ID | Priority | Depends | Exact scope and observable change | Single artifact | Primary oracle / done | Failure and rollback | Evidence / permission |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R61 | P2 | R60 | Add one approved Aside source adapter preserving private provenance | adapter diff | private sample cannot reach public renderer | source session missing: stop adapter path | S,R / C,X |
| R62 | P2 | R60 | Register one real signed GitHub webhook and replay same delivery ID | webhook receipt | two receipts produce one durable effect | mismatch disables connection only | D / O,X |
| R63 | P2 | R60 | Enforce one approved raw-data retention policy in dry-run then isolated delete test | retention diff | eligible rows only, linked audit policy preserved | ambiguous ownership: retain rows | S / C; live deletion O |
| R64 | P2 | R60 | Add out-of-host heartbeat alarm for whole-VM outage | heartbeat configuration | isolated heartbeat loss triggers one alert | alert storm disables new monitor only | R,D / O,X |
| R65 | P2 | R60 | Set required CI checks on selected canonical branch | protection receipt | failing candidate cannot merge | wrong branch: revert exact setting | D / G |

## Dependency DAG and waves

The following additional P0 rows close the existing restart/restore target
selection gap before any such test is executed. These are implementation tasks,
not permission to run existing broad Compose commands on a production host.

| ID | Priority | Depends | Exact scope and observable change | Single artifact | Primary oracle / done | Failure and rollback | Evidence / permission |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R66 | P0 | — | scripts/restart-smoke.sh uses explicitly isolated test Compose project and seeded test DB | restart isolation diff | command capture shows only owned disposable service restarted | any default/production project reference: reject | S / C |
| R67 | P0 | — | scripts/restore-smoke.sh requires isolated unique target DB/project, never drops a fixed shared name | restore isolation diff | negative target tests refuse production/default/shared target before writes | unsafe drop/restart target: reject | S / C |
| R68 | P0 | R66,R67 | CI selects isolated restart and restore invocations with recorded fixture counts | isolation CI diff | seeded count before/after restart is nonzero and identical | zero-row smoke or shared DB: reject | S / C,G |

R19 additionally depends on R67; R20 additionally depends on R67; R29
additionally depends on R66/R67/R68. These additional edges are mandatory.

Each row's Depends column plus the extra isolation edges above is the
authoritative adjacency list. No task may
consume an unaccepted dependency. This table is already topologically ordered
except the deliberate forward references R09→R20 and R22→R29; evaluate edges,
not row order. Independent code tracks can run before gated operations.

- Wave 1, immediately: R02 and R03, each based on 6627035, distinct worktrees.
- Wave 2 after review: R04 after R03; R05 independently.
- Wave 3: R06 after R04/R05; R18 independently.
- Remaining safe code tracks: R07→R08, R10, R11→R12→R13→R14/R15→R16→R17,
  R18→R19, R23/R24/R25/R26, R27/R28, then R29 owner integration.
- Operations: R00→approval→R01; R20→R21; R01/R08/R20→R09;
  R09/R21/R29→approval→R22. Never delay urgent approved containment for CI work.
- Product: R30→R31→R32→R33→R34→R35→R36→R37→R38→R39;
  SMTP R40→R41→R42 in parallel, then R39/R42→R43.
- OMP R44→R45→R46; publication R47→R48→R49; recovery R50/R51;
  converge R52→R53→R54→R55. Public scope adds R56→R58 and R57→R58→R59.
- R60 requires every P0 and every selected P1 gate, including R59 if public.
  The dependency on selected scope is an explicit release predicate, not a
  bypass of R56–R59. MDX/OMP remain product requirements unless user changes scope.

No seven-day wait is an already-approved acceptance condition. Record actual
daily/weekly cadence boundaries and incident coverage; obtain a concrete user
choice if a fixed soak duration is needed. Success cannot be inferred from zero
fixture traffic or an idle loop. Existing tests/backup plumbing are retained.

## Milestones and definition of done

- Contained: R01/R09 production receipts, not merely local switches.
- Correct candidate: R29 passes with reviewed diff and exact test environment.
- Migrated/deployed: R22/R32; loaded revision and schema match.
- Personal product: R39/R43/R45/R46/R49/R50/R51/R53 observed successes.
- Public product: additionally R56–R59 and explicit approved scope.
- Goal complete only when selected product flow, failure recovery, real external
  receipts, approved human QA and release evidence all satisfy the above gates.
  A checklist, worker report, passing unit suite or launch is never completion.

## Wave 1 pre-launch contracts

R02: Devin `--model swe-2`; worktree codex/rapi-r02-check-order; allowed edit
package.json only. Artifact: one check-script ordering diff. Oracle: serial
`npm ci && npm run clean && npm run check`. Do not suppress lint rules, change
dependency versions, or modify any other script. Stop after this single task.

R03: Devin `--model swe-2`; worktree codex/rapi-r03-delivery-result; allowed edits
workers/runtime/src/delivery-result.ts and tests/delivery-result.test.ts only.
Artifact: pure batch result assessment and its focused test. Oracle:
`node --import tsx --test tests/delivery-result.test.ts`. delivered-only means
healthy; empty means idle with no success claim; failed, partially_failed,
dead_letter and unknown/unexpected states mean failed. No runtime wiring yet.

Both: two Todo items maximum (implement, verify), 10-minute initial task window,
no subagents, no production/network messages, no secrets, no Git mutations beyond
working-file edits. On failure narrow once; no model fallback. Owner records
accept/reject after direct diff and oracle rerun, then integrates only accepted
files into owner worktree without commit. Meter coverage: devin is uncovered;
model listing confirms swe-2 family, initial task must prove actual availability.
