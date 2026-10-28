export { eventsUrlFromMcp } from "../utils/mcp-events-url.js";

export interface ChangedSseEvent {
  kind: "changed";
  id?: string;
  vault_id: string;
  paths: string[];
}

export interface ResyncSseEvent {
  kind: "resync";
  inventory_required: true;
  cursor?: string;
}

export type MirrorSseEvent = ChangedSseEvent | ResyncSseEvent;

export function parseMirrorSseBlock(block: string): MirrorSseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  let id: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  const data = dataLines.join("\n");
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (event === "resync" || parsed.inventory_required === true) {
      return {
        kind: "resync",
        inventory_required: true,
        cursor: typeof parsed.cursor === "string" ? parsed.cursor : id,
      };
    }
    if (event !== "changed") return null;
    if (typeof parsed.vault_id !== "string" || !Array.isArray(parsed.paths)) return null;
    return {
      kind: "changed",
      id: typeof parsed.id === "string" || typeof parsed.id === "number" ? String(parsed.id) : id,
      vault_id: parsed.vault_id,
      paths: parsed.paths.filter((path): path is string => typeof path === "string"),
    };
  } catch {
    return null;
  }
}
