import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { atomicCopyWithBackup, writeManifest } from "../utils/install-fs.js";

export interface InstallInput {
  skillsRoot: string;   // path to packages/skills
  target: string;       // ~/.claude/skills/
  dryRun: boolean;
}
export interface InstallOutput {
  installed: string[];
  backed_up: string[];
  manifest_path: string;
  humanHint: string;
}

export async function runInstall(input: InstallInput): Promise<{ exitCode: number; result: Result<InstallOutput> }> {
  let entries: string[];
  try {
    entries = (await readdir(input.skillsRoot, { withFileTypes: true }))
      .filter(d => d.isDirectory() && (d.name.startsWith("wiki-") || d.name.startsWith("proj-")))
      .map(d => d.name);
  } catch (e) {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: String(e) }) };
  }
  if (entries.length === 0) {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { reason: "no skills found" }) };
  }

  const installed: string[] = [];
  const backed_up: string[] = [];

  for (const name of entries) {
    const src = join(input.skillsRoot, name, "SKILL.md");
    const dst = join(input.target, name, "SKILL.md");
    try { await stat(src); } catch {
      return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { missing: src }) };
    }
    if (input.dryRun) { installed.push(dst); continue; }
    const r = await atomicCopyWithBackup(src, dst);
    if (!r.ok) return { exitCode: ExitCode.ATOMIC_COPY_FAILED, result: r };
    installed.push(dst);
    if (r.data.backupPath) backed_up.push(r.data.backupPath);
  }

  const manifest_path = join(input.target, "wiki-manifest.json");
  if (!input.dryRun) await writeManifest(manifest_path, { installed, backed_up });
  const hintLines = [
    `installed: ${installed.length}`,
    input.dryRun ? "(dry run)" : `backed up: ${backed_up.length}`,
    `manifest: ${manifest_path}`,
  ];
  return { exitCode: ExitCode.OK, result: ok({ installed, backed_up, manifest_path, humanHint: hintLines.join("\n") }) };
}
