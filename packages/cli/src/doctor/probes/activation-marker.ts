import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

const GROK_ACTIVATION_REFERENCE =
  "Read @~/.grok/skillwiki.md for SkillWiki activation context.";
const STALE_GROK_ACTIVATION_REFERENCE = "Read @skillwiki.md";
const ACTIVATION_FIX_HINT = "run `npm run install:activation` from the llm-wiki repo";

function findGrokActivationTemplate(home: string, cwd?: string): string | undefined {
  if (cwd) {
    const src = join(cwd, "packages", "skills", "using-skillwiki", "activation.md");
    if (existsSync(src)) return src;
    const directSrc = join(cwd, "skills", "using-skillwiki", "activation.md");
    if (existsSync(directSrc)) return directSrc;
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

/**
 * Audit Grok activation marker state against ADR-9 home-path contract:
 * `Read @~/.grok/skillwiki.md for SkillWiki activation context.`
 *
 * Warnings are advisory (G11) and suggest `npm run install:activation`.
 */
export function checkActivationMarker(home: string, cwd?: string): CheckResult {
  const grokDir = join(home, ".grok");
  if (!existsSync(grokDir)) {
    return check("pass", "activation_marker", "Activation marker", "Not a Grok host — check skipped");
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
    try {
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
    } catch {
      issues.push("could not read ~/.grok/AGENTS.md");
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
      "activation_marker",
      "Activation marker",
      `${issues.join("; ")} — ${ACTIVATION_FIX_HINT}`,
    );
  }

  return check("pass", "activation_marker", "Activation marker", "Marker and compact file match home-path contract");
}

export const activationMarkerProbe: DoctorProbe = {
  id: "activation_marker",
  run(ctx: DoctorContext): CheckResult[] {
    return [checkActivationMarker(ctx.input.home, ctx.input.cwd)];
  },
};
