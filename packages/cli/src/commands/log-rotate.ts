import { readFile, rename, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { appendLastOp } from "../utils/last-op.js";

const ENTRY_RE = /^## \[(\d{4})-\d{2}-\d{2}\]/gm;

export interface LogRotateInput { vault: string; threshold: number; apply: boolean }
export interface LogRotateOutput {
  entries: number;
  threshold: number;
  rotated: boolean;
  rotated_to?: string;
  humanHint: string;
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

  if (!input.apply) {
    return {
      exitCode: ExitCode.LOG_ROTATE_NEEDED,
      result: ok({ entries, threshold: input.threshold, rotated: false, humanHint: `${entries}/${input.threshold} entries — rotation needed (use --apply)` })
    };
  }

  const newestYear = matches[matches.length - 1][1];
  const rotatedName = `log-${newestYear}.md`;
  const rotatedPath = join(input.vault, rotatedName);

  try {
    await rename(logPath, rotatedPath);
    const today = new Date().toISOString().slice(0, 10);
    const fresh = `# Vault Log\n\nChronological action log. Newest entries last. Skill writes append entries; lint may rotate.\n\n## [${today}] rotate | Log rotated from ${entries} entries\n\n- Previous log moved to ${rotatedName}\n`;
    await writeFile(logPath, fresh, "utf8");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { message: String(e) }) };
  }

  appendLastOp(input.vault, {
    operation: "log-rotate",
    summary: `rotated ${entries} entries to ${rotatedName}`,
    files: ["log.md", rotatedName],
    timestamp: new Date().toISOString(),
  });

  return { exitCode: ExitCode.OK, result: ok({ entries, threshold: input.threshold, rotated: true, rotated_to: rotatedName, humanHint: `rotated ${entries} entries to ${rotatedName}` }) };
}
