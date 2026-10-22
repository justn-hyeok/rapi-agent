# Data lifecycle measurement — 2026-10-22

What the retention sweep, the backup gate and user deletion actually change, measured
by seeding randomized data into a disposable PostgreSQL and counting rows before and
after. Raw per-run counts: [data-lifecycle-measure-20261022.jsonl](data-lifecycle-measure-20261022.jsonl).

## Conditions

- Code: `origin/main` `850ab0e` plus `scripts/measure-privacy-lifecycle.ts`.
- Database: fresh `postgres:16-alpine` from `compose.test.yaml` (project `rapi-measure-b`),
  all migrations applied, torn down afterwards. The script refuses any database whose
  name does not end in `_test` (`resetForTests`). No production data was touched.
- 100 runs, seed `20261022`. Every run resets the database and seeds new random counts.

```sh
DATABASE_URL=postgresql://rapi:rapi-local-only@127.0.0.1:<port>/rapi_test \
  npx tsx scripts/measure-privacy-lifecycle.ts --runs 100 --seed 20261022
```

## Results (100 runs)

| Scenario                                                                   | Before                  | After                                             |
| -------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------- |
| Email addresses on delivery receipts older than 90 days (terminal batches) | 1,126                   | 0 (replaced by HMAC refs)                         |
| Completed task records older than 1 year                                   | 543                     | 0                                                 |
| Receipts under 90 days or in batches still sending                         | 1,544                   | 1,544 (0 changed)                                 |
| Running tasks or tasks under 1 year                                        | 1,087                   | 1,087 (0 changed)                                 |
| Re-sends to a pseudonymized receipt's original address                     | —                       | 0 of 1,126                                        |
| Maintenance with the last backup 27–200 hours old                          | 1,117 expired addresses | 1,117 (0 changed, worker exited non-zero 100/100) |
| Same data after a backup 1 hour old                                        | 1,117                   | 0                                                 |
| Owner's chat messages after a deletion preview only                        | 540                     | 540                                               |
| Confirmation by another user                                               | 237 attempts            | 237 rejected                                      |
| Confirmation after the 24-hour window                                      | 100 attempts            | 100 rejected                                      |
| Owner's chat messages after the owner confirms                             | 540                     | 0                                                 |
| Other users' chat messages through the same deletion                       | 1,313                   | 1,313 (0 changed)                                 |

## Runtime observations (same day, read-only)

- `rapi-privacy-maintenance` runs daily and has changed 0 rows so far: no production data
  has passed the 90-day or 1-year windows yet (the service started in September).
- One private item collected 2026-09-08 sits in a delivery batch that has stayed `ready`
  with no attempts since 2026-09-09. Because the batch never becomes terminal,
  `rapi-source-expiry` defers that item every day (`pendingItemsDeferred: 1`).
- `rapi-retention-report` counts publications requiring withdrawal without filtering
  `visibility='public'`; its 2 candidates are private publications, so nothing public
  is waiting to be withdrawn.
- `rapi-privacy-worker` logged one failure at the 2026-10-05 boot and none since; the
  loop retries every 15 seconds and only logs failures.
