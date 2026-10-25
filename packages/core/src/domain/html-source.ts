// Policy for `html` sources: a server-rendered list page whose posts are plain
// links. Validation is pure so the same rules apply wherever a source is added.

export const HTML_PATTERN_MAX_LENGTH = 200;
export const HTML_DEFAULT_MAX_ITEMS = 20;
const HTML_MAX_ITEMS_LIMIT = 100;
const HTML_MAX_EXCLUDES = 20;

export interface HtmlSourcePolicy {
  linkPattern: string;
  maxItems: number;
  exclude: string[];
}

function checkPattern(name: string, value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${name} must be a non-empty regex string`);
  if (value.length >= HTML_PATTERN_MAX_LENGTH)
    throw new Error(
      `${name} must be shorter than ${HTML_PATTERN_MAX_LENGTH} characters`,
    );
  try {
    new RegExp(value);
  } catch {
    throw new Error(`${name} is not a valid regular expression`);
  }
  return value;
}

export function parseHtmlSourcePolicy(raw: unknown): HtmlSourcePolicy {
  const policy =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const html =
    policy.html && typeof policy.html === "object"
      ? (policy.html as Record<string, unknown>)
      : undefined;
  if (!html) throw new Error("html source requires collection_policy.html");
  const linkPattern = checkPattern("linkPattern", html.linkPattern);
  let maxItems = HTML_DEFAULT_MAX_ITEMS;
  if (html.maxItems !== undefined) {
    if (
      typeof html.maxItems !== "number" ||
      !Number.isInteger(html.maxItems) ||
      html.maxItems < 1 ||
      html.maxItems > HTML_MAX_ITEMS_LIMIT
    )
      throw new Error(
        `maxItems must be an integer from 1 to ${HTML_MAX_ITEMS_LIMIT}`,
      );
    maxItems = html.maxItems;
  }
  const excludeRaw = html.exclude ?? [];
  if (!Array.isArray(excludeRaw) || excludeRaw.length > HTML_MAX_EXCLUDES)
    throw new Error(`exclude must be a list of at most ${HTML_MAX_EXCLUDES}`);
  const exclude = excludeRaw.map((value) => checkPattern("exclude", value));
  return { linkPattern, maxItems, exclude };
}

// Only an https page may be listed; the locator is the list page URL.
export function validateHtmlSourceLocator(locator: string): void {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error("html source locator must be a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("html source locator must be an https URL");
}
