import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface LastOpEntry {
  operation: string;
  summary: string;
  files: string[];
  timestamp: string;
}

const LAST_OP_DIR = ".skillwiki";
const LAST_OP_FILE = "last-op.json";

function lastOpPath(vault: string): string {
  return join(vault, LAST_OP_DIR, LAST_OP_FILE);
}

export function readLastOp(vault: string): LastOpEntry[] {
  const p = lastOpPath(vault);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      unlinkSync(p);
      return [];
    }
    return parsed as LastOpEntry[];
  } catch {
    try { unlinkSync(p); } catch {}
    return [];
  }
}

export function appendLastOp(vault: string, entry: LastOpEntry): void {
  const existing = readLastOp(vault);
  existing.push(entry);
  const dir = join(vault, LAST_OP_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(lastOpPath(vault), JSON.stringify(existing, null, 2), "utf8");
}

export function clearLastOp(vault: string): void {
  const p = lastOpPath(vault);
  try { unlinkSync(p); } catch {}
}
