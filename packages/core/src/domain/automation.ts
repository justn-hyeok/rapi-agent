const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where automation events may go: https anywhere, plain http only on this
 * machine. No credentials in the URL, so a copied log line cannot leak them.
 */
export function isAllowedAutomationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}
