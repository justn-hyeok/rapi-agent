import { URL } from "node:url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** @param {string} value @returns {URL} */
export function assertTestDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Test database URL must be a valid postgresql URL");
  }
  if (url.protocol !== "postgresql:")
    throw new Error("Test database URL must use postgresql://");
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error("Test database URL must use a loopback host");
  if (url.pathname !== "/rapi_test")
    throw new Error("Test database URL must target /rapi_test");
  for (const key of ["database", "dbname"]) {
    if (url.searchParams.has(key))
      throw new Error("Test database URL must not override its database name");
  }
  return url;
}
