import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  host_id: string;
  tool: string;
  path?: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export function appendAudit(filePath: string | undefined, entry: Omit<AuditEntry, "ts">): void {
  if (!filePath) return;
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n";
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, line, "utf8");
}
