export function eventsUrlFromMcp(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = "/events";
  url.search = "";
  url.hash = "";
  return url.toString();
}
