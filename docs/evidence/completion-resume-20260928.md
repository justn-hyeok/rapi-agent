# Completion scope — 2026-09-28

Understood as: finish Rapi for the user's public Discord community, with public
questions and commands, administrator operations, isolated execution, recovery,
public ingress and USER/ADMIN/SUPERADMIN boundaries.

The user selected public community scope in this session. Work continues in the
existing completion-owner worktree, preserving its uncommitted R30 preparation.
Implementation and isolated verification are authorized. Production deployment,
account configuration, real sends, commits and publication retain the applicable
explicit approval boundaries. Older evidence is historical until refreshed.

The user supplied guild `1545832299671847013` and invite
`https://discord.gg/DVbb9uwu8V`, then rejected requests to select RSS, email and
blog hosting. Those historical roadmap dependencies are not completion gates
for this community task. The optional model-summary implementation drafted
during inspection was removed; existing feed/delivery privacy and reliability
fixes remain part of the candidate's verification.

Live read-only inspection found 12 existing channels and the existing `ADMIN`
role. The guild-specific additive layout adopts that role, adds one USER role,
three categories and six channels, and contains no deletes. The layout preview
is recorded in `community-plan-20260928.json` with `applied: false`.

Live blockers: the bot has no Administrator role; the isolated public Codex
account has no `auth.json`; a fixed public tunnel is not configured. Bot/chat/
OMP are running on the old revision, public-agent/gateway/tunnel are inactive,
and the collection/delivery worker remains stopped.

## Candidate changes

- Fixed the invalid `/guilds/:guild/members/@me` lookup after a live GET returned
  400; resolve `/users/@me` first and query the actual bot member ID. Admission
  now checks the hierarchy of every desired role, including adopted ADMIN.
- Public execution reserves capacity before reading a request, releases aborted
  uploads, terminates broken response streams and has a total response deadline.
  Uploads themselves have a bounded deadline so stalled bodies release capacity.
  Cancellation escalates to SIGKILL for an uncooperative child. Disabled public
  questions do not reserve quota or execute a model.
- The allowlist gateway exercises the actual signed Discord interaction path and
  reports failed readiness when its upstream is unhealthy.
- Prepared sealed staged releases, boot-captured revision endpoints, recoverable
  systemd/environment wiring, service switching and rollback. Monitor preflight
  observes its own revision/liveness while retaining stopped-worker warnings.
  Tunnel setup preserves the inactive worker.
  Verification ports are parsed from the same environment file as the services.
- Prepared the additive guild layout and a separate public-community environment
  configuration command; RSS/email/GitHub registration is not required by it.
- Existing ingestion and delivery paths also retain malformed original payloads,
  bound HTTP/SMTP waits, classify uncertain/partial deliveries, suppress Discord
  mentions, prevent private MDX publication and escape source MDX syntax.
  Isolated smoke entrypoints discard inherited migration connection overrides.

## Verification and limits

`npm run check` passes format, typecheck, lint and 181 tests. Focused tests use
real local HTTP/TLS servers, signed Discord interactions and disposable child
processes; model processes are fixtures, not authenticated provider evidence.
Two independent review runs found four distinct defects: release unit wiring,
monitor preflight, stalled uploads and configured health ports. All four were
fixed and their focused regression checks pass. The last two narrow fixes were
verified by the owner; there has not been a third independent review of the
final snapshot.

Database checks execute this worktree's code against owned PostgreSQL containers
on `rapi-agent` via Docker SSH and owned loopback forwards. Production DB and
production services are not used by these tests. Restart preserves `0:0:1`;
restore verifies 31 tables, 12 migrations and 105 constraints. Proxy tests pass
4/4 and production dependency audit reports zero vulnerabilities. The final
PostgreSQL E2E rerun passes 18/18. Exact gate outcomes and source digest are
in `verification-20260928.json`.

The live Discord route correction was checked against the
[official Get Guild Member contract](https://docs.discord.com/developers/resources/guild#get-guild-member).
Service environment parsing uses
[Node's parseEnv](https://nodejs.org/api/util.html#utilparseenvcontent), also verified
on the server's Node 22.13.1 without reading or printing credentials.

No candidate commit, deployment, role/channel application, real model question
or human tier QA has been performed. The first live release also needs approved
baseline adoption: the old running checkout has no sealed release or boot
revision marker. The switch script refuses that unverified predecessor instead
of manufacturing rollback evidence. Live permissions/authentication and the
applicable operational/Git approvals remain the blocking boundary.
