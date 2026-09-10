import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL이 필요합니다.");
const deadline = Date.now() + Number(process.env.DRAIN_TIMEOUT_MS ?? "300000");
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 5_000,
});
await client.connect();
try {
  while (true) {
    const result = await client.query(`SELECT
      (SELECT count(*) FROM queue_jobs WHERE state='leased') +
      (SELECT count(*) FROM execution_attempts WHERE state IN ('dispatched','running')) +
      (SELECT count(*) FROM chatops_runs WHERE phase IN ('accepted','running','cancel_requested')) AS active`);
    const active = Number(result.rows[0]?.active ?? 0);
    if (active === 0) break;
    if (Date.now() >= deadline)
      throw new Error(
        `작업 drain 제한 시간을 넘겼습니다. 남은 작업: ${active}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  await client.end();
}
process.stdout.write("실행 중 작업 drain을 확인했습니다.\n");
