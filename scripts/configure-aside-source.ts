import { loadEnvironment } from "@rapi/config";
import { PostgresStore } from "@rapi/db";
import { ASIDE_ADAPTER, ASIDE_LOCATOR } from "@rapi/adapters";

const config = loadEnvironment();
const ownerId = config.DISCORD_SUPERADMIN_USER_IDS?.[0];
if (!ownerId) throw new Error("An existing superadmin owner is required");
const store = new PostgresStore(config.DATABASE_URL);
try {
  const id = await store.transaction(async (client) => {
    const existing = await client.query<{
      id: string;
      state: string;
      collection_policy: { visibility?: string; aside?: { adapter?: string } };
    }>(
      "SELECT id,state,collection_policy FROM sources WHERE kind='aside' AND locator=$1 FOR UPDATE",
      [ASIDE_LOCATOR],
    );
    if (existing.rows[0]) {
      const source = existing.rows[0];
      if (
        source.state !== "active" ||
        source.collection_policy.visibility !== "private" ||
        source.collection_policy.aside?.adapter !== ASIDE_ADAPTER
      )
        throw new Error(
          "Refusing to overwrite or reactivate an existing Aside source",
        );
      return source.id;
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO sources(id,kind,locator,collection_policy)
      VALUES(gen_random_uuid(),'aside',$1,$2::jsonb) RETURNING id`,
      [
        ASIDE_LOCATOR,
        JSON.stringify({
          visibility: "private",
          ownerId,
          aside: {
            adapter: ASIDE_ADAPTER,
            intervalSeconds: 900,
            purpose: "Hacker News front-page story titles and links",
            sessionScope: "public-page-no-login",
          },
        }),
      ],
    );
    return result.rows[0]!.id;
  });
  process.stdout.write(
    JSON.stringify({
      sourceId: id,
      adapter: ASIDE_ADAPTER,
      visibility: "private",
    }) + "\n",
  );
} finally {
  await store.close();
}
