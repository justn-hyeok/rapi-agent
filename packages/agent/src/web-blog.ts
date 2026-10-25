import { escapeHtml as h, safeLearnerUrl } from "@rapi/core";

const decodeEntities = (value: string): string =>
  value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(+code))
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");

/** `[text](https://…)` becomes a link only for https URLs; everything else is inert text. */
function inline(value: string): string {
  let out = "";
  let last = 0;
  for (const match of value.matchAll(
    /\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g,
  )) {
    out += h(decodeEntities(value.slice(last, match.index)));
    const url = safeLearnerUrl(decodeEntities(match[2]!));
    const label = h(decodeEntities(match[1]!));
    out += url
      ? `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label;
    last = match.index! + match[0].length;
  }
  return out + h(decodeEntities(value.slice(last)));
}

/**
 * Renders the MDX the blog service writes (escaped text, `#` headings, `-`
 * lists, https links) as HTML. Anything else is shown as escaped text, so a
 * stored post can never inject markup into the web page.
 */
export function renderBlogMdx(mdx: string): string {
  const body = mdx.replace(/^---\n[\s\S]*?\n---\n/, "");
  const html: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (list.length) html.push(`<ul>${list.join("")}</ul>`);
    list = [];
  };
  let paragraph: string[] = [];
  const endParagraph = (): void => {
    if (paragraph.length) html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  for (const line of body.split("\n")) {
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    const item = /^- (.+)$/.exec(line);
    if (heading) {
      // The page already shows the title as its h1.
      if (heading[1]!.length === 1 && !html.length) continue;
      endParagraph();
      flush();
      // The page title is the h1, so post headings start at h2.
      const level = Math.max(heading[1]!.length, 2);
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (item) {
      endParagraph();
      list.push(`<li>${inline(item[1]!)}</li>`);
    } else if (!line.trim()) {
      endParagraph();
      flush();
    } else {
      flush();
      paragraph.push(line.trim());
    }
  }
  endParagraph();
  flush();
  return html.join("");
}
