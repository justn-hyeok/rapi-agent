# Discord typing feedback — 2026-09-28

Deployed code `5b2ad9af08f3c351d200878b88b49f0be50a9f1e` at
`/home/justn/rapi-releases/rapi-5b2ad9af08f3-MBuOeL`.

- Public answers and private model work start typing immediately and renew every
  eight seconds. Concurrent work in one channel shares a heartbeat. Completion,
  failure and cancellation cleanup stop renewals and abort an in-flight request.
  Typing errors never delay or fail the answer. Rejected public execution requests
  do not start typing or model work.
- Local `npm run check`: format, typecheck, lint and 191 tests passed. Regressions
  cover renewals, concurrent requests, network failure, slow transport, both
  public/private orchestration and access refusal.
- Fresh server staging passed check 191/191, E2E 18/18, proxy 4/4, restart/restore
  drills and production audit with zero vulnerabilities. The sealed revision was
  switched successfully; chat and public gateway readiness report the candidate
  boot revision.
- The compiled helper sent real typing signals to question channel
  `1553943104950636544`. Discord returned 204 at `02:44:59.669Z` and
  `02:45:06.557Z`; after completion, nine seconds of observation showed no new
  request. No text message was posted. This proves API acceptance and cleanup;
  client display was not visually inspected.
- Tunnel reconnection initially encountered QUIC timeouts, then recovered without
  configuration changes. Readiness returned 200 with an active connection;
  public `/health` returned the intended 404 and unsigned `/interactions` POST
  returned 401. Core/public services remain active and the worker inactive.

Typing expiry and the API are documented in
[Discord's channel resource](https://docs.discord.com/developers/resources/channel#trigger-typing-indicator).
Private server receipts: `typing-stage.log`, `switch-5b2ad9a.json`, and
`typing-live.json` under `/home/justn/rapi-release-evidence/20260928/`.
