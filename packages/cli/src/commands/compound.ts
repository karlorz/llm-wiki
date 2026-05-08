import { writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { runProjectIndex } from "./project-index.js";

export interface CompoundInput {
  vault: string;
  project: string;
  dryRun?: boolean;
}

export interface CompoundOutput {
  scanned: number;
  promoted: string[];
  skipped: string[];
  humanHint: string;
}

export interface CompoundListInput {
  vault: string;
  project: string;
}

export interface CompoundListEntry {
  file: string;
  title: string;
  type: string;
  created: string;
  tags: string[];
}

export interface CompoundListOutput {
  project: string;
  entries: CompoundListEntry[];
  humanHint: string;
}

interface RetroEntry {
  date: string;
  cycleName: string;
  improve: string;
  friction: string;
  generalize: string;
}

const RETRO_HEADING_RE = /^## \[(\d{4}-\d{2}-\d{2})(?:\s+[^\]]+)?\] retro \| loop cycle(?: (\d+))?: (.+)$/;

const FIELD_RE = {
  improve: /^-\s+\*?\*?Improve:?\*?\*?\s*(.+)$/m,
  friction: /^-\s+\*?\*?Friction:?\*?\*?\s*(.+)$/m,
  generalize: /^-\s+\*?\*?Generalize\?:?\*?\*?\s*(.+)$/m,
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/g, "");
}

function inferType(improve: string, friction: string): string {
  if (/\bshould\b/i.test(improve)) return "pattern";
  if (/\bbug\b|\berror\b/i.test(friction)) return "gotcha";
  return "lesson";
}

function extractTags(generalize: string): string[] {
  const tags: string[] = [];

  // Extract parenthetical tokens like (drift detection)
  const parenRe = /\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = parenRe.exec(generalize)) !== null) {
    const words = match[1]!.trim().split(/\s+/);
    for (const w of words) {
      const cleaned = w.toLowerCase().replace(/[^a-z0-9-]/g, "").trim();
      if (cleaned.length > 0) tags.push(cleaned);
    }
  }

  // Extract "applies to any X"
  const appliesRe = /applies to any\s+(.+?)(?:\.|,|$)/i;
  const appliesMatch = generalize.match(appliesRe);
  if (appliesMatch) {
    const words = appliesMatch[1]!.trim().split(/\s+/);
    for (const w of words) {
      const cleaned = w.toLowerCase().replace(/[^a-z0-9-]/g, "").trim();
      if (cleaned.length > 0) tags.push(cleaned);
    }
  }

  if (tags.length === 0) {
    tags.push("dev-loop");
  }

  // Deduplicate
  return [...new Set(tags)];
}

function parseRationale(generalize: string): string {
  // Extract the rationale text after "yes"
  const yesMatch = generalize.match(/^yes[,:]\s*(.+)$/i);
  if (yesMatch) return yesMatch[1]!.trim();
  // If just "yes" with no rationale
  if (/^yes$/i.test(generalize.trim())) return "";
  return generalize.trim();
}

function parseRetroEntries(logText: string): RetroEntry[] {
  const entries: RetroEntry[] = [];
  const lines = logText.split("\n");

  let currentDate = "";
  let currentCycleName = "";
  let currentBlock: string[] = [];
  let foundHeading = false;

  for (const line of lines) {
    const headingMatch = line.match(RETRO_HEADING_RE);
    if (headingMatch) {
      // Flush previous retro block
      if (foundHeading && currentBlock.length > 0) {
        const entry = extractRetroFields(currentDate, currentCycleName, currentBlock);
        if (entry) entries.push(entry);
      }
      currentDate = headingMatch[1]!;
      currentCycleName = headingMatch[3]!;
      currentBlock = [];
      foundHeading = true;
      continue;
    }

    // A new ## heading that is NOT a retro ends the current retro block
    if (foundHeading && /^## /.test(line)) {
      const entry = extractRetroFields(currentDate, currentCycleName, currentBlock);
      if (entry) entries.push(entry);
      foundHeading = false;
      currentBlock = [];
      continue;
    }

    if (foundHeading) {
      currentBlock.push(line);
    }
  }

  // Flush last retro block
  if (foundHeading && currentBlock.length > 0) {
    const entry = extractRetroFields(currentDate, currentCycleName, currentBlock);
    if (entry) entries.push(entry);
  }

  return entries;
}

function extractRetroFields(date: string, cycleName: string, block: string[]): RetroEntry | null {
  const text = block.join("\n");

  const improveMatch = text.match(FIELD_RE.improve);
  const frictionMatch = text.match(FIELD_RE.friction);
  const generalizeMatch = text.match(FIELD_RE.generalize);

  if (!generalizeMatch) return null;

  return {
    date,
    cycleName,
    improve: improveMatch?.[1]?.trim() ?? "",
    friction: frictionMatch?.[1]?.trim() ?? "",
    generalize: generalizeMatch[1]!.trim(),
  };
}

export async function runCompound(input: CompoundInput): Promise<{ exitCode: number; result: Result<CompoundOutput> }> {
  const logPath = join(input.vault, "log.md");

  let logText: string;
  try {
    logText = await readFile(logPath, "utf8");
  } catch {
    return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: logPath }) };
  }

  const entries = parseRetroEntries(logText);
  const promoted: string[] = [];
  const skipped: string[] = [];

  const compoundDir = join(input.vault, "projects", input.project, "compound");

  for (const entry of entries) {
    const generalizeValue = entry.generalize.trim();

    if (!/^yes/i.test(generalizeValue)) {
      skipped.push(entry.date);
      continue;
    }

    const slug = slugify(entry.cycleName);
    const compoundPath = join(compoundDir, `${slug}.md`);

    // Idempotent: skip if compound file already exists
    if (existsSync(compoundPath)) {
      skipped.push(entry.date);
      continue;
    }

    const type = inferType(entry.improve, entry.friction);
    const rationale = parseRationale(generalizeValue);
    const tags = extractTags(generalizeValue);
    const tagsYaml = tags.map(t => t).join(", ");

    const title = entry.cycleName;
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

    const frontmatter = [
      "---",
      `title: ${title}`,
      `created: ${entry.date}`,
      `updated: ${entry.date}`,
      `type: ${type}`,
      `tags: [${tagsYaml}]`,
      `confidence: medium`,
      `project: "[[${input.project}]]"`,
      `work_items: []`,
      "---",
    ].join("\n");

    const body = [
      `## ${typeLabel}`,
      "",
      entry.improve,
      "",
      "## Evidence",
      "",
      entry.friction,
      "",
      "## Source",
      "",
      `Retro from ${entry.date} | ${entry.cycleName}. Generalize rationale: ${rationale}`,
      "",
    ].join("\n");

    const content = frontmatter + "\n" + body;

    if (!input.dryRun) {
      if (!existsSync(compoundDir)) {
        await mkdir(compoundDir, { recursive: true });
      }
      await writeFile(compoundPath, content, "utf8");
    }

    promoted.push(`${slug}.md`);
  }

  const exitCode = promoted.length > 0 ? ExitCode.COMPOUND_PROMOTED : ExitCode.OK;

  const hintLines: string[] = [`scanned: ${entries.length}`];
  if (promoted.length > 0) hintLines.push(`promoted: ${promoted.length}`);
  if (skipped.length > 0) hintLines.push(`skipped (Generalize?: no): ${skipped.length}`);

  return {
    exitCode,
    result: ok({
      scanned: entries.length,
      promoted,
      skipped,
      humanHint: hintLines.join("\n"),
    }),
  };
}

export interface CompoundDeleteInput {
  vault: string;
  project: string;
  entry: string;
}

export interface CompoundDeleteOutput {
  deleted: string;
  project: string;
  humanHint: string;
}

export async function runCompoundDelete(input: CompoundDeleteInput): Promise<{ exitCode: number; result: Result<CompoundDeleteOutput> }> {
  const projectDir = join(input.vault, "projects", input.project);

  // Check project exists
  if (!existsSync(projectDir)) {
    return {
      exitCode: ExitCode.PROJECT_NOT_FOUND,
      result: err("PROJECT_NOT_FOUND", { slug: input.project, path: projectDir }),
    };
  }

  // Ensure entry name doesn't have .md suffix — normalize it
  const entryName = input.entry.replace(/\.md$/, "");
  const compoundPath = join(projectDir, "compound", `${entryName}.md`);

  if (!existsSync(compoundPath)) {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("FILE_NOT_FOUND", { path: compoundPath }),
    };
  }

  // Delete the compound file
  try {
    await unlink(compoundPath);
  } catch (e) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { file: compoundPath, message: String(e) }),
    };
  }

  // Regenerate knowledge.md
  const indexResult = await runProjectIndex({ vault: input.vault, slug: input.project, apply: true });
  if (!indexResult.result.ok) {
    return {
      exitCode: indexResult.exitCode,
      result: err("INDEX_REGEN_FAILED", { detail: indexResult.result }),
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      deleted: compoundPath,
      project: input.project,
      humanHint: `deleted: ${entryName}.md\nproject: ${input.project}\nknowledge.md regenerated`,
    }),
  };
}

export async function runCompoundList(input: CompoundListInput): Promise<{ exitCode: number; result: Result<CompoundListOutput> }> {
  const compoundDir = join(input.vault, "projects", input.project, "compound");

  if (!existsSync(compoundDir)) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        project: input.project,
        entries: [],
        humanHint: `project: ${input.project}\nentries: 0\nno compound directory found`,
      }),
    };
  }

  let dirents: Array<{ name: string; isFile: () => boolean }>;
  try {
    dirents = await readdir(compoundDir, { withFileTypes: true });
  } catch {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        project: input.project,
        entries: [],
        humanHint: `project: ${input.project}\nentries: 0\ncould not read compound directory`,
      }),
    };
  }

  const entries: CompoundListEntry[] = [];

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
    const filePath = join(compoundDir, dirent.name);
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const fm = extractFrontmatter(text);
    if (!fm.ok) continue;

    const tags = Array.isArray(fm.data.tags)
      ? fm.data.tags.map((t: unknown) => String(t))
      : typeof fm.data.tags === "string"
        ? fm.data.tags.split(",").map((s: string) => s.trim())
        : [];

    entries.push({
      file: dirent.name,
      title: typeof fm.data.title === "string" ? fm.data.title : dirent.name.replace(/\.md$/, ""),
      type: typeof fm.data.type === "string" ? fm.data.type : "lesson",
      created: typeof fm.data.created === "string" ? fm.data.created : "",
      tags,
    });
  }

  const hint = entries.length > 0
    ? [`project: ${input.project}`, `entries: ${entries.length}`, "", ...entries.map(e => `  ${e.file}: ${e.title} (${e.type}, created: ${e.created || "unknown"}, tags: ${e.tags.join(", ") || "none"})`)].join("\n")
    : `project: ${input.project}\nentries: 0\nno compound entries found`;

  return {
    exitCode: ExitCode.OK,
    result: ok({
      project: input.project,
      entries,
      humanHint: hint,
    }),
  };
}
