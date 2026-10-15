import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "../utils/atomic-write.js";

export type JournalState =
  | "queued"
  | "localized"
  | "uploaded"
  | "awaiting_reconcile"
  | "conflict"
  | "held";

export interface JournalEntry {
  captureId: string;
  articleKey: string;
  assetKeys: string[];
  sha256: Record<string, string>;
  state: JournalState;
  reason?: string;
}

export async function readJournal(stateRoot: string): Promise<JournalEntry[]> {
  try {
    const raw = await readFile(join(stateRoot, "journal.json"), "utf8");
    const parsed = JSON.parse(raw) as JournalEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeJournal(stateRoot: string, entries: JournalEntry[]): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  const result = await atomicWriteText(join(stateRoot, "journal.json"), JSON.stringify(entries, null, 2));
  if (!result.ok) {
    throw new Error(`journal write failed: ${result.error}`);
  }
}

export function upsertJournal(entries: JournalEntry[], next: JournalEntry): JournalEntry[] {
  const rest = entries.filter((e) => e.captureId !== next.captureId);
  return [...rest, next];
}
