import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { git } from "./git.js";
import { readLogEvents } from "./log-events.js";
import { scanVault } from "./vault.js";
import { isGitPromotablePath } from "./git-promotion.js";

function gitBlobOid(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function headBlobOids(projection: string): Map<string, string> | undefined {
  const output = git(projection, ["ls-tree", "-rz", "-r", "HEAD"]);
  if (!output) return undefined;
  const blobs = new Map<string, string>();
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const match = entry.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/s);
    if (match) blobs.set(match[2]!, match[1]!);
  }
  return blobs;
}

export async function measureAuthoritativeLiveDrift(
  liveVault: string,
  projection: string,
): Promise<{ content?: number; ledger?: number; unknown?: boolean; detail?: string }> {
  const projectionBlobs = headBlobOids(projection);
  if (!projectionBlobs) return { unknown: true, detail: "projection HEAD unreadable" };

  const scan = await scanVault(liveVault);
  if (!scan.ok) return { unknown: true, detail: "live Markdown inventory unavailable" };

  let content = 0;
  const livePromotable = new Set<string>();
  for (const page of scan.data.allMarkdown) {
    const rel = relative(liveVault, page.absPath).split(sep).join("/");
    if (!isGitPromotablePath(rel)) continue;
    livePromotable.add(rel);
    const bytes = await readFile(page.absPath);
    if (projectionBlobs.get(rel) !== gitBlobOid(bytes)) content += 1;
  }
  for (const rel of projectionBlobs.keys()) {
    if (rel.endsWith(".md") && isGitPromotablePath(rel) && !livePromotable.has(rel)) content += 1;
  }

  const events = await readLogEvents(liveVault);
  if (!events.ok) return { unknown: true, detail: "live event ledger unreadable" };
  return {
    content,
    ledger: events.data.length,
    detail: content > 0 || events.data.length > 0 ? "authoritative live data ahead of GitHub" : undefined,
  };
}
