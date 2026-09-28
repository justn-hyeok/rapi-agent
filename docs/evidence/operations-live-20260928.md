# GitHub and operations evidence — 2026-09-28

## Applied release

- Source/runtime SHA: `d036205f0292d44fb1c8fe79f9ddc5974772f1c5`.
- [v0.1.0](https://github.com/justn-hyeok/rapi-agent/releases/tag/v0.1.0) is published
  with an annotated tag resolving to that exact commit.
- The divergent default branch's monitor changes and delivery migration history
  were preserved by merge `feb688e`; existing branches were not deleted.
- `main` is now the default branch. Protection applies to admins, requires a PR,
  current `verify`, `secret-scan`, `blog-browser` checks and resolved conversations,
  and prevents force pushes and branch deletion. Required peer approvals are zero
  for this single-owner repository; future PR merges use squash.
- [Exact-SHA CI](https://github.com/justn-hyeok/rapi-agent/actions/runs/36383759625)
  passed all three required jobs. The tag's CI also passed.
- Local check: 202 unit tests, typecheck, lint, formatting; proxy 4/4;
  desktop/mobile blog browser test passed. Native `codex review --commit d036205`
  completed without actionable findings. Actionlint and shellcheck passed.
- Local Docker was unavailable. Disposable PostgreSQL checks instead ran on
  GitHub and in a fresh sealed server stage: 22 E2E tests, restart, restore
  (31 tables, 12 migrations, 105 constraints), production dependency audit zero.

## Runtime and backup

The sealed artifact is `/home/justn/rapi-releases/rapi-d036205f0292-rVUb6a`.
The bounded switch receipt records previous `798a3a2`, current `d036205`,
`status: switched`, and no rollback. Eight services are active and enabled.
Monitor readiness is true including worker, backup, public gateway and tunnel.

The backup service now runs the current sealed release's script. A fresh real
production dump `rapi-20260928T055404Z.dump` was created mode 0600. The first age
prune retained every current backup (`removed: []`). The fresh dump restored
successfully into an isolated disposable PostgreSQL instance: 31 tables, exact
12 migrations, 105 constraints. Production data was not overwritten.
Both backup and read-only retention inventory timers are enabled.

## External alert flow

The private alert channel is `1553943111602938006`. Its dedicated webhook is
stored as a repository Actions secret. Temporary transfer files were removed.
The public origin is a repository variable, and no private readiness route was
exposed. Probe acceptance is `/blog/` HTML 200 plus unsigned interactions 401.

| Run                                                                                           | Actual observation                                                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Initial failure](https://github.com/justn-hyeok/rapi-agent/actions/runs/36383786351)         | Closed runner-local port was unreachable; one Discord down alert arrived and owned incident issue 1 opened.   |
| [Repeated failure](https://github.com/justn-hyeok/rapi-agent/actions/runs/36383840158)        | Still unreachable, transition none; no repeated down alert.                                                   |
| [Recovery during switch](https://github.com/justn-hyeok/rapi-agent/actions/runs/36383875969)  | Public origin returned 530 during restart; correctly retained the incident instead of sending false recovery. |
| [Verified recovery](https://github.com/justn-hyeok/rapi-agent/actions/runs/36383963345)       | Real origin returned HTML 200 and unsigned POST 401; one recovery alert arrived and issue 1 closed.           |
| [Normal production probe](https://github.com/justn-hyeok/rapi-agent/actions/runs/36384043586) | Both checks healthy; no new incident or alert.                                                                |

Discord receipts: down `1554007895564226570`, recovery
`1554008512130977864`. Self-test has a separate incident marker from production.
This proves the off-VM workflow and real notification path, not a VM power-cut
drill. Scheduled Actions can be delayed and can be disabled after 60 days of
inactivity in a public repository; see [GitHub's schedule contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Source-expiry follow-up

The live read-only inventory reported zero candidates for raw bodies, item
bodies, summaries, classifications, recipient identifiers, delivery audit,
task audit and linked publication withdrawal. No DB content was expired.

A follow-up executor prepares public 90-day/private 30-day body expiry,
derived-content removal and exclusion from search/new or pending deliveries.
Pending deliveries are deferred; unresolved published history handling fails
before writes. Its PostgreSQL regression runs in its own schema and covers
read-only planning, rollback on unresolved publication handling, fresh data,
pending delivery protection, derived expiry and repeated application.

The follow-up defaults to withdrawing connected public history when its
underlying source expires. A persistent gateway deny list removes the post,
index entry and RSS item before the database expiry commits. A release lacking
withdrawal support cannot start the gateway under its persistent systemd guard.
The expiry service requires a recent successful backup and reports its own
failure or overdue status through the existing monitor. Production activation
and exact-SHA acceptance are recorded after the follow-up's deployment checks.
Metadata/audit expiry and deletion-request tracking are inventory scope; this
is not a claim of full policy execution.
