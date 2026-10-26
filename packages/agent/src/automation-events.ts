import { createHmac } from "node:crypto";
import { isAllowedAutomationUrl } from "@rapi/core";

/** What Rapi tells an automation tool (n8n) about; add kinds here, never free-form text. */
export type AutomationEvent = {
  type: "blog.published";
  data: { slug: string; title: string; url: string | null };
};

export interface AutomationSink {
  notify(event: AutomationEvent): Promise<boolean>;
}

const TIMEOUT_MS = 5_000;
/** `sha256=<hex>` over `<timestamp>.<body>`; the receiver recomputes it and checks the age. */
export function signAutomationBody(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface AutomationNotifierOptions {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  onWarning?: (message: string) => void;
}

/**
 * Posts signed JSON events to an automation webhook. It never throws and never
 * waits long: a down or slow automation tool must not hold up Rapi.
 */
export class AutomationNotifier implements AutomationSink {
  constructor(private readonly options: AutomationNotifierOptions) {
    if (!isAllowedAutomationUrl(options.url))
      throw new Error("automation webhook URL must be https or loopback http");
  }

  async notify(event: AutomationEvent): Promise<boolean> {
    const now = (this.options.now ?? (() => new Date()))();
    const body = JSON.stringify({ ...event, at: now.toISOString() });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rapi-timestamp": timestamp,
          "x-rapi-signature": signAutomationBody(
            this.options.secret,
            timestamp,
            body,
          ),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok)
        this.options.onWarning?.(
          `automation webhook answered ${response.status}`,
        );
      return response.ok;
    } catch (error) {
      this.options.onWarning?.(
        `automation webhook failed: ${error instanceof Error ? error.name : "error"}`,
      );
      return false;
    }
  }
}

export function createAutomationNotifier(
  config: {
    AUTOMATION_WEBHOOK_URL?: string | undefined;
    AUTOMATION_WEBHOOK_SECRET?: string | undefined;
  },
  onWarning?: (message: string) => void,
): AutomationNotifier | undefined {
  if (!config.AUTOMATION_WEBHOOK_URL || !config.AUTOMATION_WEBHOOK_SECRET)
    return undefined;
  return new AutomationNotifier({
    url: config.AUTOMATION_WEBHOOK_URL,
    secret: config.AUTOMATION_WEBHOOK_SECRET,
    ...(onWarning ? { onWarning } : {}),
  });
}
