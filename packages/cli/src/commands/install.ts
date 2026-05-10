import { readdir, stat, symlink, unlink, mkdir, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { atomicCopyWithBackup, writeManifest, type SkillMeta } from "../utils/install-fs.js";

export interface InstallInput {
  skillsRoot: string;   // path to packages/skills
  target: string;       // ~/.claude/skills/
  dryRun: boolean;
  symlink: boolean;     // create symlinks instead of copies (dev mode)
}
export interface InstallOutput {
  installed: string[];
  backed_up: string[];
  manifest_path: string;
  version_warnings: string[];
  humanHint: string;
}

/** Parse version and deprecated from SKILL.md frontmatter. */
function parseSkillMeta(content: string): SkillMeta {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const meta: SkillMeta = { name: "" };
  if (!fmMatch) return meta;
  const fm = fmMatch[1]!;
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (nameMatch) meta.name = nameMatch[1]!.trim();
  const versionMatch = fm.match(/^version:\s*(.+)$/m);
  if (versionMatch) meta.version = versionMatch[1]!.trim();
  const depMatch = fm.match(/^deprecated:\s*(.+)$/m);
  if (depMatch && /^(true|yes)$/i.test(depMatch[1]!.trim())) meta.deprecated = true;
  return meta;
}

async function createSymlink(src: string, dst: string): Promise<Result<{ linked: true }>> {
  await mkdir(dirname(dst), { recursive: true });
  // Remove existing file/symlink at dst
  try { await unlink(dst); } catch { /* not present */ }
  try {
    await symlink(resolve(src), dst);
  } catch (e: unknown) {
    return err("SYMLINK_FAILED", { message: String(e) });
  }
  return ok({ linked: true });
}

export async function runInstall(input: InstallInput): Promise<{ exitCode: number; result: Result<InstallOutput> }> {
  let entries: string[];
  try {
    const dirs = (await readdir(input.skillsRoot, { withFileTypes: true }))
      .filter(d => d.isDirectory());
    const withSkill: string[] = [];
    for (const d of dirs) {
      try { await stat(join(input.skillsRoot, d.name, "SKILL.md")); withSkill.push(d.name); } catch { /* not a skill directory */ }
    }
    entries = withSkill;
  } catch (e: unknown) {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: String(e) }) };
  }
  if (entries.length === 0) {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { reason: "no skills found" }) };
  }

  const installed: string[] = [];
  const backed_up: string[] = [];
  const version_warnings: string[] = [];
  const skillMetas: Record<string, SkillMeta> = {};

  for (const name of entries) {
    const src = join(input.skillsRoot, name, "SKILL.md");
    const dst = join(input.target, name, "SKILL.md");
    try { await stat(src); } catch {
      return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { missing: src }) };
    }

    // Parse skill metadata from source SKILL.md
    try {
      const content = await readFile(src, "utf8");
      const meta = parseSkillMeta(content);
      meta.name = meta.name || name;
      skillMetas[name] = meta;
      if (meta.deprecated) {
        version_warnings.push(`${name}: DEPRECATED — will be removed in a future release`);
      }
      // Check version against installed copy
      if (!input.dryRun) {
        try {
          const existingContent = await readFile(dst, "utf8");
          const existingMeta = parseSkillMeta(existingContent);
          if (existingMeta.version && meta.version && existingMeta.version !== meta.version) {
            version_warnings.push(`${name}: version changed ${existingMeta.version} → ${meta.version}`);
          }
        } catch { /* no existing install — fresh */ }
      }
    } catch { /* can't read — skip meta */ }

    if (input.dryRun) { installed.push(dst); continue; }
    if (input.symlink) {
      const r = await createSymlink(src, dst);
      if (!r.ok) return { exitCode: ExitCode.SYMLINK_FAILED, result: r };
      installed.push(dst);
    } else {
      const r = await atomicCopyWithBackup(src, dst);
      if (!r.ok) return { exitCode: ExitCode.ATOMIC_COPY_FAILED, result: r };
      installed.push(dst);
      if (r.data.backupPath) backed_up.push(r.data.backupPath);
    }
  }

  // Deploy bin/skillwiki wrapper if present
  const binSrc = join(input.skillsRoot, "bin", "skillwiki");
  try {
    await stat(binSrc);
    const binDst = join(input.target, "bin", "skillwiki");
    if (!input.dryRun) {
      if (input.symlink) {
        const r = await createSymlink(binSrc, binDst);
        if (!r.ok) return { exitCode: ExitCode.SYMLINK_FAILED, result: r };
        installed.push(binDst);
      } else {
        const r = await atomicCopyWithBackup(binSrc, binDst);
        if (!r.ok) return { exitCode: ExitCode.ATOMIC_COPY_FAILED, result: r };
        installed.push(binDst);
        if (r.data.backupPath) backed_up.push(r.data.backupPath);
      }
    } else {
      installed.push(binDst);
    }
  } catch { /* no bin wrapper — skip silently */ }

  const manifest_path = join(input.target, "wiki-manifest.json");
  if (!input.dryRun) await writeManifest(manifest_path, { installed, backed_up, symlink: input.symlink || undefined, skills: skillMetas });
  const mode = input.symlink ? "symlink (dev mode)" : "copy";
  const hintLines = [
    `installed: ${installed.length} (${mode})`,
    input.dryRun ? "(dry run)" : `backed up: ${backed_up.length}`,
    `manifest: ${manifest_path}`,
  ];
  if (version_warnings.length > 0) {
    hintLines.push(`version warnings: ${version_warnings.length}`);
    for (const w of version_warnings) hintLines.push(`  ${w}`);
  }
  const exitCode = version_warnings.length > 0 ? ExitCode.SKILL_VERSION_MISMATCH : ExitCode.OK;
  return { exitCode, result: ok({ installed, backed_up, manifest_path, version_warnings, humanHint: hintLines.join("\n") }) };
}
