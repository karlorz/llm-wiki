import { mkdir, readFile, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteText } from "../utils/atomic-write.js";

export type JournalState = "discovered" | "preparing" | "sealed" | "assets-verified" | "article-verified" | "notify-pending" | "central-visible" | "mirrored" | "conflict" | "held";
export interface JournalEntry {
  captureId: string;
  snapshotId?: string;
  source?: string;
  sourceSha256?: string;
  articleKey: string;
  assetKeys: string[];
  sha256: Record<string, string>;
  sizes?: Record<string, number>;
  receipts?: Record<string, "created" | "idempotent">;
  state: JournalState;
  reason?: string;
  attempts?: number;
  updatedAt?: string;
  retryAt?: number;
}
export async function readJournal(stateRoot: string): Promise<JournalEntry[]> {
  let raw: string;
  try { raw = await readFile(join(stateRoot, "journal.json"), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const key = z.string().regex(/^raw\/(articles|assets)\/[A-Za-z0-9._/-]+$/).refine((s) => s.split("/").every((p) => p && p !== "." && p !== ".."));
  const schema = z.object({
    captureId: z.string().regex(/^[a-f0-9]{16,32}$/),
    snapshotId: z.string().regex(/^[a-f0-9]{16}$/).optional(),
    source: z.string().optional(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    articleKey: key.refine((s) => s.startsWith("raw/articles/")),
    assetKeys: z.array(key.refine((s) => s.startsWith("raw/assets/"))),
    sha256: z.record(z.string().regex(/^[a-f0-9]{64}$/)), sizes: z.record(z.number().int().nonnegative()).optional(),
    receipts: z.record(z.enum(["created", "idempotent"])).optional(),
    state: z.enum(["discovered", "preparing", "sealed", "assets-verified", "article-verified", "notify-pending", "central-visible", "mirrored", "conflict", "held"]),
    reason: z.string().optional(), attempts: z.number().int().nonnegative().optional(),
    updatedAt: z.string().optional(), retryAt: z.number().finite().optional(),
  }).refine((e) => !e.sourceSha256 || (e.snapshotId && [e.articleKey, ...e.assetKeys].every((k) => e.sha256[k] && e.sizes?.[k] !== undefined)));
  const result = z.array(schema).safeParse(JSON.parse(raw));
  if (!result.success) throw new Error("invalid clip journal; retain and inspect it before restarting");
  return result.data;

}
export async function writeJournal(stateRoot: string, entries: JournalEntry[]): Promise<void> {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const result = await atomicWriteText(join(stateRoot, "journal.json"), JSON.stringify(entries, null, 2));
  if (!result.ok) throw new Error("journal write failed");
  for (const path of [stateRoot, dirname(stateRoot)]) {
    const dir = await open(path, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
}
export function upsertJournal(entries: JournalEntry[], next: JournalEntry): JournalEntry[] {
  return [...entries.filter((e) => e.captureId !== next.captureId), next];
}
