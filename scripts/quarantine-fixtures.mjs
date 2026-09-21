import { URL } from "node:url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MANIFEST_KEYS = new Set([
  "deactivateSubscriptionIds",
  "retainedFixtureIds",
]);

function uniqueNonEmptyStrings(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const values = value.map((item) => {
    if (typeof item !== "string" || item.trim() === "")
      throw new Error(`${name} must contain non-empty strings`);
    return item;
  });
  if (new Set(values).size !== values.length)
    throw new Error(`${name} must not contain duplicate ids`);
  return values;
}

export function parseQuarantineManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Quarantine manifest must be an object");
  if (Object.keys(value).some((key) => !MANIFEST_KEYS.has(key)))
    throw new Error("Quarantine manifest contains an unknown key");
  const deactivateSubscriptionIds = uniqueNonEmptyStrings(
    value.deactivateSubscriptionIds,
    "deactivateSubscriptionIds",
  );
  const retainedFixtureIds = uniqueNonEmptyStrings(
    value.retainedFixtureIds,
    "retainedFixtureIds",
  );
  const retained = new Set(retainedFixtureIds);
  if (deactivateSubscriptionIds.some((id) => !retained.has(id)))
    throw new Error("Every deactivated subscription must be retained");
  return { deactivateSubscriptionIds, retainedFixtureIds };
}

export function assertQuarantineDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Quarantine database URL must be a valid postgresql URL");
  }
  if (url.protocol !== "postgresql:")
    throw new Error("Quarantine database URL must use postgresql://");
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error("Quarantine database URL must use a loopback host");
  if (url.pathname !== "/rapi_test")
    throw new Error("Quarantine database URL must target /rapi_test");
  if (url.searchParams.has("database") || url.searchParams.has("dbname"))
    throw new Error(
      "Quarantine database URL must not override its database name",
    );
  return url;
}
