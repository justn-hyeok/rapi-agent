# Public community application — 2026-09-28

The owner authorized candidate commits, server deployment and community
configuration in this session. This receipt supersedes the pending operational
state in `completion-resume-20260928.md`; its earlier verification remains a
historical snapshot.

## Applied

- Deployed code: `948b40d113e59edc22c6fdb5cbf831d967e68bd5`, tree
  `8998822ecdd641f35c2d40b7e1f6e75cb912b950`.
- Current artifact: `/home/justn/rapi-releases/rapi-948b40d113e5-eHXFuP`.
  Main bot, ChatOps and OMP readiness return this boot-captured revision.
  The sealed file digests still match after startup.
- Guild: `1545832299671847013`, invite `https://discord.gg/DVbb9uwu8V`.
  Added one USER role, three categories and six channels. Adopted existing ADMIN;
  all 12 previous channel/category resources remain. Total resources: 21.
- Enabled the bot's Administrator permission and verified its role is above
  ADMIN using Discord REST. The isolated public account completed device login.
- Fixed the installer to copy the native Codex executable instead of its npm
  wrapper; corrected the public unit from Node 18 to Node 22.13.1.
  A real search exposed its missing `codex-code-mode-host`; the installer now
  copies that bundled helper too, and public readiness rejects its absence.
- Public questions use `gpt-5.6-luna`. A real Spark request returned a 400
  unsupported-model error for this ChatGPT account. Luna appeared in the account's
  model catalog, then passed a real request; the public runtime and usage ledger
  were updated together. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna).
- Authorized only the `justn.me` Cloudflare zone and provisioned Named Tunnel
  `8b0c4b3b-5771-4b84-aa45-f86e13c8bd7e` at
  `https://rapi-07ab7899e00f.justn.me`.
- Discord accepted the new interaction endpoint after its signed verification.
  Registered all 16 commands in the designated guild. Public GETs to `/health`,
  `/ready`, `/omp/callback` and `/v1/answer` return 404; unsigned POST to
  `/interactions` returns 401. Two tunnel connections were ready at final check.

## Evidence

- Every deployed candidate ran fresh `npm ci`, format/typecheck/lint plus **183
  tests**, proxy **4/4**, PostgreSQL E2E **18/18**, restart, restore and dependency
  audit. The final artifact records all seven gates and exact migration set 12.
- First-adoption tests reject schema drift and overlapping/reused recovery
  receipts before stopping services, and restore legacy runtime after failed
  startup. Actual production schema matched the candidate; no migration was
  applied by adoption. Previous units/environment and the original checkout
  were preserved for recovery.
- The installed systemd public executor returned `2` for an approved arithmetic
  request. The same request through `PublicCommunityService`, real quota
  reservation and completion recording also returned `2` successfully.
- A real web-search request called the search tool and returned the official
  KMA site. A second invocation under a transient unit with the public service's
  user/group and security restrictions also performed web search successfully.
  This verifies the bundled helper under those restrictions without weakening
  shell/app/plugin/other disabled-feature boundaries. Installed file digests
  for both executables and the public JS files are recorded in the receipt.
- A narrow **non-isolated**, existing-account Aside UI flow clicked the role
  registration button once. Discord returned the ephemeral success message
  confirming the current account received `라피 USER`. The question and admin
  channels are present; their lock icons describe their role-gated visibility.
  This is automation evidence, not independent human tier QA.
- Receipts: `deployment-receipt-20260928.json`,
  `community-applied-20260928.json`, `public-service-smoke-20260928.json`.
  Private recovery files and authentication materials remain on the server and
  are not committed.

## Scope and remaining observations

The collection/delivery worker remains intentionally inactive, preserving prior
containment. The monitor's own health is 200, while dependency readiness retains
the stopped-worker warning. New collection, SMTP delivery, publication and
development-task execution were not activated or independently verified in this
community application. Human checks across separate USER/ADMIN/SUPERADMIN
participants are not claimed.

Changes are committed on `codex/rapi-completion-owner` and transferred to the
server through a Git bundle. GitHub push, merge, tag and GitHub release were not
requested or performed; no current GitHub CI claim is made.
