import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

export const researchSiteSchema = z.enum(["threads", "x", "reddit"]);
export type ResearchSite = z.infer<typeof researchSiteSchema>;
const siteSchema = z
  .object({
    feed: z.url(),
    domains: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1),
    maxPosts: z.number().int().min(1).max(20),
    dailyPosts: z.number().int().min(1).max(180),
    maxSeconds: z.number().int().min(1).max(120),
  })
  .strict();
export type ResearchSitePolicy = z.infer<typeof siteSchema>;
export const RESEARCH_ACTIONS = [
  "launch",
  "navigate",
  "snapshot",
  "scroll",
  "close",
] as const;

export async function loadResearchPolicy(
  site: ResearchSite,
): Promise<ResearchSitePolicy> {
  const sites = z
    .record(researchSiteSchema, siteSchema)
    .parse(
      JSON.parse(await readFile("ops/browser-research/sites.json", "utf8")),
    );
  const policy = siteSchema.parse(sites[site]);
  const feed = new URL(policy.feed);
  if (feed.protocol !== "https:" || !policy.domains.includes(feed.hostname))
    throw new Error("Invalid research feed policy");
  return policy;
}

export function researchPostUrl(
  site: ResearchSite,
  value: string,
): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password)
      return null;
    const valid =
      site === "x"
        ? ["x.com", "www.x.com"].includes(url.hostname) &&
          /^\/[^/]+\/status\/\d+\/?$/.test(url.pathname)
        : site === "threads"
          ? ["threads.com", "www.threads.com"].includes(url.hostname) &&
            /^\/@[^/]+\/post\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
          : ["reddit.com", "www.reddit.com"].includes(url.hostname) &&
            /^\/r\/[^/]+\/comments\/[a-z0-9]+(?:\/[^/]*)?\/?$/.test(
              url.pathname,
            );
    return valid ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

/** Only a closed set of local commands can reach the CLI. No raw model argv. */
export interface ResearchBrowser {
  open(): Promise<void>;
  snapshot(): Promise<string>;
  scroll(): Promise<void>;
  close(): Promise<void>;
}

const exec = promisify(execFile);
export class AgentResearchBrowser implements ResearchBrowser {
  private directory?: string;
  private readonly session = `rr-${randomUUID().slice(0, 12)}`;
  private readonly env: NodeJS.ProcessEnv;
  private policyFile?: string;
  constructor(
    private readonly options: {
      site: ResearchSite;
      policy: ResearchSitePolicy;
      binary: string;
      authDirectory: string;
      signal: AbortSignal;
    },
  ) {
    // Never inherit attached browsers, profiles, proxies, plugins, headers or keys.
    this.env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
    };
  }

  private async command(args: string[], closing = false): Promise<string> {
    if (!this.directory || !this.policyFile)
      throw new Error("Browser not opened");
    try {
      const { stdout } = await exec(
        this.options.binary,
        [
          "--session",
          this.session,
          "--namespace",
          this.session,
          "--config",
          join(this.directory, "config.json"),
          "--action-policy",
          this.policyFile,
          ...(!closing
            ? [
                "--allowed-domains",
                this.options.policy.domains.join(","),
                "--no-webmcp",
              ]
            : []),
          "--max-output",
          "24000",
          ...args,
        ],
        {
          cwd: this.directory,
          env: this.env,
          timeout: closing ? 10_000 : 20_000,
          maxBuffer: 128_000,
          ...(!closing ? { signal: this.options.signal } : {}),
        },
      );
      return stdout;
    } catch {
      // CLI diagnostics may include cookies or page text. Never propagate them.
      throw new Error(
        "브라우저 조사를 중단했습니다. 비공개 운영 기록을 확인하세요.",
      );
    }
  }

  async open(): Promise<void> {
    const file = resolve(
      this.options.authDirectory,
      `${this.options.site}.json`,
    );
    let saved: { cookies?: unknown; origins?: unknown };
    try {
      const info = await stat(file);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1_000_000)
        throw new Error("Invalid auth file permissions");
      saved = z
        .object({ cookies: z.unknown(), origins: z.unknown().optional() })
        .parse(JSON.parse(await readFile(file, "utf8")));
    } catch {
      throw new Error("로그인 필요로 보류");
    }
    const cookieSchema = z.object({
      name: z.string().min(1),
      value: z.string(),
      domain: z.string(),
      path: z.string().startsWith("/"),
      expires: z.number().optional(),
      httpOnly: z.boolean().optional(),
      secure: z.boolean().optional(),
      sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
    });
    const cookies = z.array(cookieSchema).min(1).max(500).parse(saved.cookies);
    if (
      cookies.some(
        (c) =>
          !this.options.policy.domains.some(
            (d) => d === c.domain.replace(/^\./, ""),
          ),
      )
    )
      throw new Error("로그인 쿠키 도메인이 허용 목록과 다릅니다.");
    this.directory = await mkdtemp(join(tmpdir(), "rapi-research-"));
    this.policyFile = join(this.directory, "policy.json");
    await writeFile(join(this.directory, "config.json"), "{}", { mode: 0o600 });
    const policy = z
      .object({
        default: z.literal("deny"),
        allow: z.array(z.string()),
        deny: z.array(z.string()),
      })
      .parse(
        JSON.parse(await readFile("ops/browser-research/policy.json", "utf8")),
      );
    if (JSON.stringify(policy.allow) !== JSON.stringify(RESEARCH_ACTIONS))
      throw new Error("Invalid browser research action policy");
    // --state/--profile are incompatible with --allowed-domains in 0.39.2.
    // Import only operator-provided cookies into a fresh contained blank context.
    // No page is loaded until the cookie capability has been removed again.
    await writeFile(
      this.policyFile,
      JSON.stringify({
        default: "deny",
        allow: ["launch", "navigate", "cookies_set", "close"],
      }),
      { mode: 0o600 },
    );
    await this.command(["open"]);
    // The 0.39.2 --curl importer strips Secure/HttpOnly/SameSite/path fields.
    // Use the typed setter so cookie scope is preserved. Values never reach
    // shell interpolation, logs, model context or a propagated CLI error.
    for (const cookie of cookies) {
      if (
        [cookie.name, cookie.value].some(
          (value) => value.startsWith("-") || value.includes("\0"),
        )
      )
        throw new Error("Invalid cookie argument");
      await this.command([
        "cookies",
        "set",
        cookie.name,
        cookie.value,
        ...(cookie.domain.startsWith(".")
          ? ["--domain", cookie.domain]
          : ["--url", `https://${cookie.domain}/`]),
        "--path",
        cookie.path,
        ...(cookie.secure ? ["--secure"] : []),
        ...(cookie.httpOnly ? ["--httpOnly"] : []),
        ...(cookie.sameSite ? ["--sameSite", cookie.sameSite] : []),
        ...(cookie.expires !== undefined && cookie.expires > 0
          ? ["--expires", String(cookie.expires)]
          : []),
      ]);
    }
    await writeFile(this.policyFile, JSON.stringify(policy), { mode: 0o600 });
    await this.command(["open", this.options.policy.feed]);
  }
  snapshot(): Promise<string> {
    return this.command(["snapshot", "-c", "-u", "-d", "10"]);
  }
  async scroll(): Promise<void> {
    await this.command(["scroll", "down", "600"]);
  }
  async close(): Promise<void> {
    try {
      if (this.directory) await this.command(["close"], true);
    } finally {
      if (this.directory)
        await rm(this.directory, { recursive: true, force: true });
    }
  }
}
