/* global document, location */
// This function executes in the owned Aside tab. It follows no article links,
// submits no forms, and reads no cookies or account state.
export function extractHackerNews() {
  if (location.href !== "https://news.ycombinator.com/")
    throw new Error("Unexpected Aside page");
  const rows = [...document.querySelectorAll("tr.athing")].slice(0, 30);
  if (!rows.length) throw new Error("Aside page has no stories");
  return rows.map((row) => {
    const link = row.querySelector(".titleline > a");
    if (!link || !/^\d{1,16}$/.test(row.id))
      throw new Error("Aside page structure changed");
    return {
      id: row.id,
      title: link.textContent.trim(),
      articleUrl: link.href,
      author:
        row.nextElementSibling?.querySelector(".hnuser")?.textContent ?? null,
    };
  });
}

export function browserCode(marker) {
  if (!/^RAPI_ASIDE_[a-f0-9]{32}:$/.test(marker))
    throw new Error("Invalid output marker");
  return `const p = await openTab("https://news.ycombinator.com/");
    try { const stories = await p.evaluate(${extractHackerNews.toString()});
      console.log(${JSON.stringify(marker)} + JSON.stringify({pageUrl:"https://news.ycombinator.com/",collectedAt:new Date().toISOString(),stories}));
    } finally { await p.close(); }`;
}

export function parseBrowserOutput(output, marker) {
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker));
  if (lines.length !== 1) throw new Error("Aside returned no unique snapshot");
  const snapshot = JSON.parse(lines[0].slice(marker.length));
  if (
    snapshot.pageUrl !== "https://news.ycombinator.com/" ||
    !Array.isArray(snapshot.stories) ||
    !snapshot.stories.length ||
    snapshot.stories.length > 30
  )
    throw new Error("Invalid Aside snapshot");
  return snapshot;
}
