import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestFromCache } from "../../utils/auto-update.js";
import { semverGt } from "../../utils/semver.js";
import { findPlugin, findPluginInstallations, type PluginChannelInstall } from "../../utils/plugin-registry.js";
import type { CheckResult, CheckStatus, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

function findSkillMd(dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(join(dir, entry.name));
    } else if (entry.isDirectory()) {
      results.push(...findSkillMd(join(dir, entry.name)));
    }
  }
  return results;
}

/** Return skill directory names (e.g. "wiki-init", "proj-decide") that contain a SKILL.md. */
function findSkillNames(dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md"))) {
      results.push(entry.name);
    }
  }
  return results;
}

function findInstalledSkillMd(dir: string): string[] {
  const directSkills = findSkillNames(dir).map(name => join(dir, name, "SKILL.md"));
  return directSkills.length > 0 ? directSkills : findSkillMd(dir);
}

function checkSkillsInstalled(home: string, cwd?: string): CheckResult {
  // Check CWD source tree first (for dev/project runs)
  const srcDir = cwd ? join(cwd, "packages", "skills") : undefined;
  if (srcDir && existsSync(srcDir)) {
    const found = findInstalledSkillMd(srcDir);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (source)`);
    }
  }
  const plugin = findPlugin(home);
  if (plugin) {
    const found = findInstalledSkillMd(plugin.installPath);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (plugin v${plugin.version})`);
    }
  }
  const skillsDir = join(home, ".claude", "skills");
  if (existsSync(skillsDir)) {
    const found = findInstalledSkillMd(skillsDir);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (CLI install)`);
    }
  }
  return check("warn", "skills_installed", "Skills installed", "No SKILL.md files found");
}

function checkDuplicateSkills(home: string): CheckResult {
  const plugin = findPlugin(home);
  const skillsDir = join(home, ".claude", "skills");
  const agentSkillDirs = [
    { label: "~/.codex/skills/", path: join(home, ".codex", "skills") },
    { label: "~/.agents/skills/", path: join(home, ".agents", "skills") },
  ];

  // No plugin means no reference set to compare against
  if (!plugin) {
    return check("pass", "skills_duplicate", "Skills not duplicated", "Single install channel");
  }

  const pluginSkills = findSkillNames(plugin.installPath);

  // Check ~/.claude/skills/ overlap (warn — user should remove CLI copies)
  const cliSkills = findSkillNames(skillsDir);
  const cliDuplicates = cliSkills.filter(name => pluginSkills.includes(name));

  // Check agent-skill dirs overlap (info — stale but harmless)
  const agentDuplicates: { dir: string; names: string[] }[] = [];
  for (const { label, path } of agentSkillDirs) {
    const overlap = findSkillNames(path).filter(name => pluginSkills.includes(name));
    if (overlap.length > 0) {
      agentDuplicates.push({ dir: label, names: overlap });
    }
  }

  if (cliDuplicates.length === 0 && agentDuplicates.length === 0) {
    return check("pass", "skills_duplicate", "Skills not duplicated", "No overlap between plugin and other channels");
  }

  // Build detail message
  const parts: string[] = [];
  if (cliDuplicates.length > 0) {
    parts.push(`${cliDuplicates.length} skill(s) in both plugin and ~/.claude/skills/ — remove CLI copies: rm -r ~/.claude/skills/{${cliDuplicates.slice(0, 3).join(",")}${cliDuplicates.length > 3 ? ",…" : ""}}`);
  }
  for (const { dir, names } of agentDuplicates) {
    parts.push(`${names.length} stale skill(s) in ${dir} — plugin provides: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`);
  }

  // CLI duplicates are warn; agent-only duplicates are info
  const status: CheckStatus = cliDuplicates.length > 0 ? "warn" : "info";
  return check(status, "skills_duplicate", "Skills not duplicated", parts.join("; "));
}

const GROK_ACTIVATION_REFERENCE =
  "Read @~/.grok/skillwiki.md for SkillWiki activation context.";
const STALE_GROK_ACTIVATION_REFERENCE = "Read @skillwiki.md";
const ACTIVATION_FIX_HINT = "run `npm run install:activation` from the llm-wiki repo";

function findGrokActivationTemplate(home: string, cwd?: string): string | undefined {
  if (cwd) {
    const src = join(cwd, "packages", "skills", "using-skillwiki", "activation.md");
    if (existsSync(src)) return src;
  }
  const pluginsRoot = join(home, ".grok", "installed-plugins");
  if (!existsSync(pluginsRoot)) return undefined;
  let entries;
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(pluginsRoot, entry.name);
    for (const rel of ["using-skillwiki/activation.md", "skills/using-skillwiki/activation.md"]) {
      const candidate = join(root, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Read-only Grok activation drift check. Never writes ~/.grok/AGENTS.md. */
export function checkGrokActivation(home: string, cwd?: string): CheckResult {
  const grokDir = join(home, ".grok");
  if (!existsSync(grokDir)) {
    return check("pass", "activation_grok", "Grok activation", "Not a Grok host");
  }

  const activationPath = join(grokDir, "skillwiki.md");
  const agentsPath = join(grokDir, "AGENTS.md");
  const hasActivation = existsSync(activationPath);
  const issues: string[] = [];

  if (!hasActivation) {
    issues.push("~/.grok/skillwiki.md missing");
  }

  if (!existsSync(agentsPath)) {
    issues.push("~/.grok/AGENTS.md missing");
  } else {
    const agents = readFileSync(agentsPath, "utf8");
    const hasBegin = agents.includes("<!-- skillwiki:begin -->");
    const hasExpected = agents.includes(GROK_ACTIVATION_REFERENCE);
    const hasStale = agents.includes(STALE_GROK_ACTIVATION_REFERENCE);
    if (!hasBegin) {
      issues.push("AGENTS.md marker missing");
    } else if (hasStale && !hasExpected) {
      issues.push("AGENTS.md marker is stale (@skillwiki.md)");
    } else if (!hasExpected) {
      issues.push("AGENTS.md marker is stale");
    }
  }

  if (hasActivation) {
    const template = findGrokActivationTemplate(home, cwd);
    if (template) {
      try {
        const installed = readFileSync(activationPath, "utf8");
        const expected = readFileSync(template, "utf8");
        if (installed !== expected) {
          issues.push("~/.grok/skillwiki.md differs from template");
        }
      } catch {
        // unreadable template or file — skip byte compare
      }
    }
  }

  if (issues.length > 0) {
    return check(
      "warn",
      "activation_grok",
      "Grok activation",
      `${issues.join("; ")} — ${ACTIVATION_FIX_HINT}`,
    );
  }
  return check("pass", "activation_grok", "Grok activation", "Marker and compact file are current");
}

function checkNpmUpdate(home: string, currentVersion: string): CheckResult {
  const { hasUpdate, latest, distTag } = latestFromCache(home, currentVersion);
  if (!latest) {
    return check("pass", "npm_update", "npm CLI version", `v${currentVersion} (${distTag}: no cache yet)`);
  }
  if (hasUpdate) {
    return check("warn", "npm_update", "npm CLI version", `v${currentVersion} — ${distTag} update available: v${latest}. Run \`skillwiki update --tag ${distTag}\`.`);
  }
  return check("pass", "npm_update", "npm CLI version", `v${currentVersion} (${distTag}: v${latest})`);
}

function pluginUpdateCommand(plugin: PluginChannelInstall, currentVersion: string): string {
  if (semverGt(plugin.version, currentVersion)) {
    return "npm install -g skillwiki@latest";
  }
  if (plugin.channel === "claude") {
    return "claude plugin update skillwiki@llm-wiki";
  }
  if (plugin.sourceType === "git") {
    return "codex plugin marketplace upgrade llm-wiki && codex plugin remove skillwiki@llm-wiki && codex plugin add skillwiki@llm-wiki";
  }
  return "codex plugin remove skillwiki@llm-wiki && codex plugin add skillwiki@llm-wiki";
}

function checkPluginVersionDrift(home: string, currentVersion: string, devSourceRun: boolean): CheckResult {
  const plugins = findPluginInstallations(home);
  if (plugins.length === 0) {
    return check("pass", "plugin_version_drift", "Plugin/CLI version", "Plugin not installed — CLI only");
  }

  const drifted = plugins.filter(plugin => plugin.version !== currentVersion);
  if (drifted.length === 0) {
    if (plugins.length === 1 && plugins[0].channel === "claude") {
      return check("pass", "plugin_version_drift", "Plugin/CLI version", `Both at v${currentVersion}`);
    }
    if (plugins.length === 1) {
      return check("pass", "plugin_version_drift", "Plugin/CLI version", `${plugins[0].label} plugin and CLI both at v${currentVersion}`);
    }
    const labels = plugins.map(plugin => `${plugin.label} plugin`).join(", ");
    return check("pass", "plugin_version_drift", "Plugin/CLI version", `${labels}, and CLI all at v${currentVersion}`);
  }

  if (devSourceRun && drifted.every(plugin => semverGt(currentVersion, plugin.version))) {
    const details = drifted.map(plugin => `${plugin.label} plugin v${plugin.version}`).join(", ");
    return check("info", "plugin_version_drift", "Plugin/CLI version", `Dev source v${currentVersion} is ahead of installed ${details}`);
  }

  const details = drifted.map(plugin => {
    const updateCmd = pluginUpdateCommand(plugin, currentVersion);
    return `${plugin.label} plugin v${plugin.version} ≠ CLI v${currentVersion} — run \`${updateCmd}\``;
  });
  return check(
    "warn",
    "plugin_version_drift",
    "Plugin/CLI version",
    details.join("; ")
  );
}

export const skillsPluginsProbe: DoctorProbe = {
  id: "skills_plugins",
  run(ctx: DoctorContext): CheckResult[] {
    return [
      checkSkillsInstalled(ctx.input.home, ctx.input.cwd),
      checkDuplicateSkills(ctx.input.home),
      checkGrokActivation(ctx.input.home, ctx.input.cwd),
      checkNpmUpdate(ctx.input.home, ctx.input.currentVersion),
      checkPluginVersionDrift(ctx.input.home, ctx.input.currentVersion, ctx.devSourceRun),
    ];
  },
};
