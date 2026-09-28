# Natural wake phrase regression — 2026-09-28

The actual owner message `1553952792266416280` in channel
`1553943104950636544` was `라피! 오늘 주요 ai 뉴스 찾아줘`. The Gateway admission
filter accepted only literal `라피야!`, so it silently returned before invoking
the public responder. Channel enablement, guild allowance and public execution
were already enabled; this was not a model or connectivity failure.

- Added shared `parseRapiInvocation` for Gateway admission and orchestration.
  `라피!`, `라피야!`, `라피 질문`, and `라피야 질문` normalize to the same request.
  Unrelated words and quoted/mid-sentence references remain ignored. Existing
  channel, guild and role restrictions are unchanged.
- Added the exact reported message as a regression and exercised public routing
  through the actual orchestrator, asserting normalized input and one reply.
- `npm run check`: 185 tests, format/typecheck/lint pass. Fresh staged install
  passed E2E 18/18, proxy 4/4, restart/restore and production audit.
- Deployed `9e20fa0c37b93619827c6a1facd358b3b6010ea6` at
  `/home/justn/rapi-releases/rapi-9e20fa0c37b9-latQOI`; chat readiness reports
  that boot revision.
- Recovered the ignored request once using its original message ID, fresh member
  roles, existing access checks and the real orchestrator/public responder.
  Discord accepted reply `1553955348413681685`; a fresh REST read verified the
  bot reply, 1,013 characters and four source links.

Reply: https://discord.com/channels/1545832299671847013/1553943104950636544/1553955348413681685

The worker remains inactive. No new collection or outbound newsletter was enabled.
