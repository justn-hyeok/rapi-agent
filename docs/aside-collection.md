# Aside collection

The first supported browser source is the Hacker News front page at
`https://news.ycombinator.com/`. It extracts at most 30 story titles, article
links, authors, and stable story IDs. It does not follow links, submit forms,
read cookies, or inspect other tabs. Results are private, with page URL,
capture time and `aside-browser` provenance. They use the ordinary raw-event,
normalization, summary, retention and deletion paths. No public publication or
outbound subscription is created automatically.

Existing catch-all subscriptions cannot include browser data. Only the source
owner's subscription that explicitly selects its source can include it, and
Discord channel targets or DMs to another user exclude browser items. Email
targets require that same explicit owner subscription.

## Runtime

Aside runs in the existing signed-in Mac installation, not on the Linux VM.
The Mac launch agent `me.justn.rapi-aside-bridge` checks for due work every
minute, over the existing `rapi-agent` SSH alias. The server grants one browser
lease at a time, across manual runs and multiple Macs. Successful sources are
polled every 15 minutes. A failure retries after exponential backoff, capped
at 30 minutes. A lost process or transport releases its lease after 3 minutes.
An expired or replaced token cannot ingest a snapshot. All items and cursor
success are committed in one transaction; a partial failure rolls back.

The bridge opens and closes only its own Aside tab. Its captured data stays in
memory until SSH delivers it to the server. Its private local status and logs
contain counts and outcomes, not page content or account credentials. The Mac
holds no database URL or browser cookies copied from Aside. The receiver is
SSH-only, uses the existing server environment, and exposes no new public API.

If the Mac is asleep/offline, or Aside is unavailable, browser collection
waits. RSS/GitHub continue independently. An approved browser source without
a successful capture in 30 minutes reports failed source readiness; a missing
first capture never reports healthy collection. Only this explicitly approved
adapter is supported: arbitrary sites and private logged-in dashboards need
their own approved extractor and account-bound validation.

## Setup and inspection

From a verified server release, with the canonical environment:

```sh
node --env-file=/home/justn/rapi-agent/.env --import tsx scripts/configure-aside-source.ts
```

Then on this Mac, from the matching source checkout:

```sh
node scripts/install-aside-bridge.mjs
launchctl print gui/$(id -u)/me.justn.rapi-aside-bridge
```

Files live in `~/Library/Application Support/Rapi/aside-bridge/` and
`~/Library/LaunchAgents/me.justn.rapi-aside-bridge.plist`.
For a manual run, pass the installed private `config.json` to
`scripts/aside-bridge.mjs`. `/수집원 상태` shows the source's last capture and
failure count. The worker's `/ready` includes browser-source health.

To pause, disable the source in the server or boot out this exact launch agent;
do not remove any Aside sessions or account state. After a CLI/API change,
verify current Aside help and the extractor before resuming. A timed-out CLI
can leave its own tab open; do not close unrelated user tabs as recovery.
