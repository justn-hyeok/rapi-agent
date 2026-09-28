import assert from "node:assert/strict";
import { it } from "node:test";
import { monitor, probeOrigin } from "../scripts/external-monitor.mjs";

it("persists one down alert, suppresses repeats, and closes after recovery", async () => {
  const issues: Array<Record<string, unknown>> = [];
  const alerts: string[] = [];
  let healthy = false;
  const dependencies = {
    origin: "https://example.com",
    api: async (
      method: string,
      _path: string,
      body?: Record<string, unknown>,
    ) => {
      if (method === "GET")
        return issues.filter((issue) => issue.state !== "closed");
      if (method === "POST") {
        const issue = {
          ...body,
          number: 1,
          html_url: "https://example.com/issues/1",
          user: { login: "github-actions[bot]" },
        };
        issues.push(issue);
        return issue;
      }
      Object.assign(issues[0]!, body);
      return issues[0];
    },
    notify: async (content: string) => {
      alerts.push(content);
      return { id: String(alerts.length) };
    },
    probe: async () => [{ name: "blog", ok: healthy }],
  };
  assert.equal((await monitor(dependencies)).transition, "down");
  assert.equal((await monitor(dependencies)).transition, "none");
  assert.equal(alerts.length, 1);
  healthy = true;
  assert.equal((await monitor(dependencies)).transition, "recovered");
  assert.equal(issues[0]?.state, "closed");
  assert.equal((await monitor(dependencies)).transition, "none");
  assert.equal(alerts.length, 2);
});

it("does not treat redirects, changed signature enforcement, or network failures as healthy", async () => {
  const result = await probeOrigin(
    "https://example.com",
    async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return new Response("", { status: 302 });
      throw new Error("network failure");
    },
  );
  assert.deepEqual(
    result.map((check: { ok: boolean }) => check.ok),
    [false, false],
  );
});
