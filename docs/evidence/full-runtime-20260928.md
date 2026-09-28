# Rapi connected runtime — 2026-09-28

The selected implementation and deployment scope is complete. Separate human
USER/ADMIN account tests were declined; acceptance uses live configuration and
automated checks, without claiming independent participant observations.

## Current deployment

Release `v0.1.0`, code `d036205f0292d44fb1c8fe79f9ddc5974772f1c5`, runs from sealed artifact
`/home/justn/rapi-releases/rapi-d036205f0292-rVUb6a`. Bot, chat, worker, OMP,
monitor, public agent, gateway and named tunnel are active and enabled for boot.
Monitor readiness is true including worker, backup and tunnel. No whole-VM power
cycle was performed.

The original collection/mail/execution observations below were made on the
earlier application candidate. The subsequent operations release preserves
those changes and adds external monitoring, backup retention and a read-only
expiry inventory. See [operations evidence](operations-live-20260928.md).

- [Blog](https://rapi-07ab7899e00f.justn.me/blog/)
- [Real briefing](https://rapi-07ab7899e00f.justn.me/blog/ai-weekly-2026-09-21.html)
- [Blog RSS](https://rapi-07ab7899e00f.justn.me/blog/feed.xml)
- [Discord](https://discord.gg/DVbb9uwu8V)

Private diagnostic/executor GET routes remain unavailable through public ingress;
unsigned interaction POSTs return 401. Discord accepted the signed interaction
endpoint verification, and all 16 commands are registered.

## Observed flows

| Flow                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real collection       | OpenAI RSS: 1,230 items; public project GitHub: 10 events. Recollection added zero duplicate items. Original payloads and timestamps are retained. Two healthy collectors are running.                                                                                                                                                                                                                                 |
| Fixture containment   | Fixture subscriptions remain inactive and unsupported Aside input is disabled. Two fixture items previously visible in public search were made private without deletion; 1,240 real public items remained unchanged.                                                                                                                                                                                                   |
| Public questions      | Natural wake phrases, bounded isolated web-search answers and typing heartbeat are deployed. Role registration was exercised in the existing owner account.                                                                                                                                                                                                                                                            |
| Permissions and quota | Live Discord roles/overwrites confirm USER question-channel access and hidden management channels. Signed HTTP E2E covers tier denials, guild rejection, quota, staff behavior, duplicate admission, cooldown, concurrency, reset and pre-start release.                                                                                                                                                               |
| Discord newsletter    | A consented owner subscription froze five real source items and sent one DM. Replay added no delivery attempts. Daily/weekly schedules freeze completed periods; immediate delivery keeps a durable period checkpoint and pending batches are retried.                                                                                                                                                                 |
| Gmail                 | SMTP accepted the same frozen item set. The first setup test exposed sender and malformed Message-ID rewriting. The sender alias was verified through a narrow existing-account Aside flow without changing the personal default. The corrected test arrived once by its valid client Message-ID, preserved `rapi@justn.me`, and contained all five source links. EXAMINE/BODY.PEEK verification did not mark it read. |
| MDX                   | The real batch rendered as a public HTML page whose public digest matched the sealed artifact. Executable MDX, unsafe URLs, raw HTML and private posts are excluded. All posts validate before output replacement; withdrawn pages are removed. Feed URLs follow the effective origin. Future posts require explicit publish/build/deploy approval.                                                                    |
| Development           | The command service prepared and approved a bounded real Codex task. OMP created an isolated clone, wrote a proof file, and applied signed callbacks to the DB with owner notifications. Independent file/revision readback passed. A second actual provider child was cancelled; its exact PID disappeared and DB state agreed.                                                                                       |
| Recovery              | Each candidate passed restart/restore drills. Fresh production dumps were restored to disposable PostgreSQL: 31 tables, exact 12 migrations, 105 constraints. Production was not overwritten. Previous sealed artifacts and rollback receipts remain available.                                                                                                                                                        |

The same deployed revision also booted against the restored production data,
became ready and returned 20 public search matches. The isolated application used
fixture transport configuration and made no actual external sends.

SMTP credentials remain only in the private mode-0600 server environment and the
account's SMTP alias configuration. Temporary credential-transfer files were
removed. The corrected mail was a separate setup verification, not an outbox retry
of the already accepted first mail.

## Verification

Fresh final staging passed installation, format/typecheck/lint, **197 tests**,
PostgreSQL E2E **22/22**, proxy **4/4**, restart/restore and production dependency
audit with zero vulnerabilities. The durable blog browser test passed navigation,
links, origin rotation, private-route exclusion and overflow checks at 1280×900 and
390×844. Both screenshots were viewed by the owner agent.

Two serial independent reviews found cancellation callback recovery, deferred
acknowledgement, withdrawn output, RSS-origin and browser lifecycle defects; these
were fixed and checked with focused regressions. Later scheduler and SMTP changes
were verified by the owner with database and live-provider evidence. No independent
clean review of the final snapshot is claimed. Optional Cursor/Command Code
authentication was not exercised by the default-Codex probes.

Commits and deployment were authorized and transferred via Git bundles. GitHub
push, merge, tag and GitHub release publication were not performed.

Private, credential-free receipts live under
`/home/justn/rapi-release-evidence/20260928/`: `mail-final-stage.log`,
`switch-798a3a2.json`, `live-collection.json`, `github-live-proof.json`,
`live-permissions.json`, `fixture-items-quarantine-proof.json`,
`publication/newsletter-proof.json`, `email-live-proof.json`,
`email-corrected-proof.json`, `gmail-inbox-proof.json`, `omp-live-proof.json`,
`final-production-restore.json`, `restored-app-proof.json`. Environment backups and dumps are private and
excluded from Git.

References: [Discord permissions](https://docs.discord.com/developers/topics/permissions),
[MDX compiler](https://mdxjs.com/packages/mdx/),
[Google app passwords](https://support.google.com/accounts/answer/185833),
[IMAP read-only fetch](https://www.rfc-editor.org/rfc/rfc9051.html#name-fetch-command).
