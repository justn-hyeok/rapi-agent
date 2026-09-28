import { pathToFileURL, URL } from "node:url";

// GitHub Issues persist incident state outside the monitored VM. Only issues
// created by this workflow with its exact marker are eligible for mutation.
export async function monitor({ origin, mode = "normal", api, notify, probe }) {
  if (!["normal", "self-test-fail", "self-test-recover"].includes(mode))
    throw new Error("Invalid monitor mode");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Monitor origin must be an HTTPS origin");
  const namespace = mode === "normal" ? "production" : "self-test";
  const marker = `<!-- rapi-external-monitor:${namespace}:v1 -->`;
  const checks = await probe(
    mode === "self-test-fail" ? "http://127.0.0.1:65534" : url.origin,
  );
  const healthy = checks.every((check) => check.ok);
  const issues = await api(
    "GET",
    "/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100",
  );
  let issue = issues.find(
    (item) =>
      !item.pull_request &&
      item.user?.login === "github-actions[bot]" &&
      item.body?.startsWith(marker),
  );
  const state = issue
    ? JSON.parse(issue.body.slice(marker.length).trim())
    : undefined;
  if (healthy && !issue) return { healthy, checks, transition: "none" };
  if (!issue) {
    issue = await api("POST", "/issues", {
      title: `[Rapi monitor${namespace === "self-test" ? " self-test" : ""}] Public endpoint unavailable`,
      body: `${marker}\n${JSON.stringify({ phase: "down-pending", origin: url.origin, startedAt: new Date().toISOString(), checks })}`,
    });
  }
  const phase = state?.phase ?? "down-pending";
  if (!["down-pending", "down-sent", "recovery-sent"].includes(phase))
    throw new Error("Unrecognized incident state; manual inspection required");
  if (phase === "recovery-sent") {
    await api("PATCH", `/issues/${issue.number}`, {
      state: "closed",
      state_reason: "completed",
    });
    return { healthy, checks, transition: "closed", issue: issue.number };
  }
  if (phase === "down-pending") {
    // Never print the webhook URL, token, response body, or a raw fetch error.
    const receipt = await notify(
      `[라피 외부 장애${namespace === "self-test" ? " · 감시 테스트" : ""}] ${url.origin}\n${issue.html_url}\n${checks.map((check) => `${check.name}: ${check.ok ? "OK" : "FAILED"}`).join("\n")}`,
    );
    await api("PATCH", `/issues/${issue.number}`, {
      body: `${marker}\n${JSON.stringify({ ...(state ?? {}), phase: "down-sent", origin: url.origin, checks, alertId: receipt.id, startedAt: state?.startedAt ?? new Date().toISOString() })}`,
    });
  }
  if (healthy) {
    const receipt = await notify(
      `[라피 외부 복구${namespace === "self-test" ? " · 감시 테스트" : ""}] ${url.origin}\n${issue.html_url}`,
    );
    await api("PATCH", `/issues/${issue.number}`, {
      body: `${marker}\n${JSON.stringify({ phase: "recovery-sent", origin: url.origin, checks, recoveryAlertId: receipt.id, recoveredAt: new Date().toISOString() })}`,
    });
    await api("PATCH", `/issues/${issue.number}`, {
      state: "closed",
      state_reason: "completed",
    });
  }
  return {
    healthy,
    checks,
    transition: healthy
      ? "recovered"
      : phase === "down-pending"
        ? "down"
        : "none",
    issue: issue.number,
  };
}

export async function probeOrigin(origin, request = fetch) {
  return Promise.all(
    [
      { name: "blog", path: "/blog/", method: "GET", expected: 200 },
      {
        name: "interaction-signature",
        path: "/interactions",
        method: "POST",
        expected: 401,
      },
    ].map(async ({ name, path, method, expected }) => {
      try {
        const response = await request(`${origin}${path}`, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
          ...(method === "POST"
            ? { body: "{}", headers: { "content-type": "application/json" } }
            : {}),
        });
        const ok =
          response.status === expected &&
          (name !== "blog" ||
            (response.headers.get("content-type")?.includes("text/html") &&
              (await response.text()).includes('href="/blog/feed.xml"')));
        await response.body?.cancel().catch(() => undefined);
        return { name, ok: Boolean(ok), status: response.status };
      } catch {
        return { name, ok: false, status: "unreachable" };
      }
    }),
  );
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
    throw new Error("Invalid repository");
  const token = process.env.GITHUB_TOKEN;
  const webhook = new URL(process.env.RAPI_MONITOR_ALERT_WEBHOOK_URL ?? "");
  if (
    !token ||
    webhook.origin !== "https://discord.com" ||
    !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook.pathname)
  )
    throw new Error("Monitor credentials missing or invalid");
  const api = async (method, path, body) => {
    const response = await fetch(
      `https://api.github.com/repos/${repository}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw new Error(`Incident API status ${response.status}`);
    return response.json();
  };
  const notify = async (content) => {
    webhook.searchParams.set("wait", "true");
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(`Alert delivery status ${response.status}`);
    return response.json();
  };
  const result = await monitor({
    origin: process.env.RAPI_MONITOR_ORIGIN,
    mode: process.env.RAPI_MONITOR_MODE ?? "normal",
    api,
    notify,
    probe: probeOrigin,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write(
      "External monitor failed; inspect incident state and credential configuration.\n",
    );
    process.exitCode = 1;
  });
