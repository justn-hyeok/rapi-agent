export interface BrowserSnapshot {
  pageUrl: string;
  collectedAt: string;
  stories: Array<{
    id: string;
    title: string;
    articleUrl: string;
    author: string | null;
  }>;
}
export function browserCode(marker: string): string;
export function parseBrowserOutput(
  output: string,
  marker: string,
): BrowserSnapshot;
