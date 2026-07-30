import { access, readFile, rename, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { appendLastOp } from "../utils/last-op.js";

const ENTRY_RE = /^## \[(\d{4})-\d{2}-\d{2}\]/gm;
const FULL_DATE_RE = /^## \[(\d{4}-\d{2}-\d{2})\]/gm;

export interface LogRotateInput { vault: string; threshold: number; apply: boolean }
export interface LogRotateOutput {
  entries: number;
  threshold: number;
  rotated: boolean;
  rotated_to?: string;
  archived_existing_to?: string;
  humanHint: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Build vault-convention archive name: log-archive-YYYY-MM-DD-to-MM-DD.md */
export function archiveNameForExistingYearLog(existingText: string, fallbackYear: string): string {
  const dates = [...existingText.matchAll(FULL_DATE_RE)].map((m) => m[1]);
  if (dates.length === 0) {
    return `log-archive-${fallbackYear}-unknown.md`;
  }
  const first = dates[0];
  const last = dates[dates.length - 1];
  // Match vault convention used by log-archive-2026-05-04-to-05-12.md
  const lastMd = last.slice(5); // MM-DD
  return `log-archive-${first}-to-${lastMd}.md`;
}

/**
 * If log-YYYY.md already exists, rename it to a non-colliding log-archive-* path.
 * Never overwrite an existing year archive via rename(log.md → log-YYYY.md).
 */
export async function sidelineExistingYearLog(
  vault: string,
  rotatedPath: string,
  fallbackYear: string,
): Promise<string | undefined> {
  if (!(await pathExists(rotatedPath))) return undefined;
  const existingText = await readFile(rotatedPath, "utf8");
  let archiveName = archiveNameForExistingYearLog(existingText, fallbackYear);
  let archivePath = join(vault, archiveName);
  if (await pathExists(archivePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    archiveName = archiveName.replace(/\.md$/, `-${stamp}.md`);
    archivePath = join(vault, archiveName);
  }
  await rename(rotatedPath, archivePath);
  return archiveName;
}

export async function runLogRotate(input: LogRotateInput): Promise<{ exitCode: number; result: Result<LogRotateOutput> }> {
  try { await stat(join(input.vault, "SCHEMA.md")); }
  catch { return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { vault: input.vault }) }; }

  const logPath = join(input.vault, "log.md");
  let logText: string;
  try { logText = await readFile(logPath, "utf8"); }
  catch { return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: logPath }) }; }

  const matches = [...logText.matchAll(ENTRY_RE)];
  const entries = matches.length;

  if (entries < input.threshold) {
    return { exitCode: ExitCode.OK, result: ok({ entries, threshold: input.threshold, rotated: false, humanHint: `${entries}/${input.threshold} entries — no rotation needed` }) };
  }

  const newestYear = matches[matches.length - 1][1];
  const rotatedName = `log-${newestYear}.md`;
  const rotatedPath = join(input.vault, rotatedName);
  const yearExists = await pathExists(rotatedPath);

  if (!input.apply) {
    const hint = yearExists
      ? `${entries}/${input.threshold} entries — rotation needed (use --apply); existing ${rotatedName} will be sidelined to log-archive-* first`
      : `${entries}/${input.threshold} entries — rotation needed (use --apply)`;
    return {
      exitCode: ExitCode.LOG_ROTATE_NEEDED,
      result: ok({ entries, threshold: input.threshold, rotated: false, humanHint: hint })
    };
  }

  let archivedExistingTo: string | undefined;
  try {
    archivedExistingTo = await sidelineExistingYearLog(input.vault, rotatedPath, newestYear);
    await rename(logPath, rotatedPath);
    const today = new Date().toISOString().slice(0, 10);
    const sidelineNote = archivedExistingTo
      ? `\n- Prior ${rotatedName} preserved as ${archivedExistingTo}\n`
      : "";
    const fresh = `# Vault Log\n\nChronological action log. Newest entries last. Skill writes append entries; lint may rotate.\n\n## [${today}] rotate | Log rotated from ${entries} entries\n\n- Previous log moved to ${rotatedName}${sidelineNote}`;
    await writeFile(logPath, fresh, "utf8");
  } catch (e: unknown) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { message: String(e) }) };
  }

  const files = ["log.md", rotatedName];
  if (archivedExistingTo) files.push(archivedExistingTo);
  const summary = archivedExistingTo
    ? `rotated ${entries} entries to ${rotatedName}; archived existing to ${archivedExistingTo}`
    : `rotated ${entries} entries to ${rotatedName}`;

  appendLastOp(input.vault, {
    operation: "log-rotate",
    summary,
    files,
    timestamp: new Date().toISOString(),
  });

  return {
    exitCode: ExitCode.OK,
    result: ok({
      entries,
      threshold: input.threshold,
      rotated: true,
      rotated_to: rotatedName,
      archived_existing_to: archivedExistingTo,
      humanHint: summary,
    }),
  };
}
