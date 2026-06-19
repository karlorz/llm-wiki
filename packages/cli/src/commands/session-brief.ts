import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { err, ok, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { scanVault, readPage, type VaultPage } from "../utils/vault.js";
import { appendLastOp } from "../utils/last-op.js";

export interface SessionBriefInput {
  vault: string;
  project?: string;
  write?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface SessionBriefItem {
  path: string;
  title: string;
  summary: string;
  date: string;
}

export interface SessionBriefOutput {
  project?: string;
  brief: string;
  word_count: number;
  files_written: string[];
  index_updated: boolean;
  log_updated: boolean;
  generated_at: string;
  memory_topics: SessionBriefMemoryTopic[];
  humanHint: string;
}

export interface SessionBriefMemoryTopic {
  name: string;
  summary: string;
  project?: string;
  updated: string;
  paths: string[];
}

interface PageInfo {
  path: string;
  title: string;
  summary: string;
  date: string;
  kind?: string;
  project?: string;
  workItem?: string;
  status?: string;
}

const MAX_WORDS = 900;

export async function runSessionBrief(
  input: SessionBriefInput
): Promise<{ exitCode: number; result: Result<SessionBriefOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };
  }

  const now = new Date();
  const generatedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const today = generatedAt.slice(0, 10);
  const project = await resolveProject(input);

  try {
    const transcripts = await loadTranscriptInfo(scan.data.raw);
    const workItems = await loadWorkItems(scan.data.workItems);
    const digests = await loadTrendDigests(scan.data.typedKnowledge);
    const healthWarnings = await loadHealthWarnings(input.vault);
    const memoryTopics = project ? await loadMemoryTopics(input.vault, project) : [];

    const latestLogs = newest(transcripts.filter((t) => t.kind === "session-log"), 3);
    const unclaimedCaptures = newest(transcripts.filter((t) => {
      if (t.kind !== "task" && t.kind !== "bug") return false;
      return !t.workItem && (!project || t.project === project);
    }), 5);
    const activeWork = newest(workItems.filter((w) => {
      if (w.status !== "planned" && w.status !== "in-progress") return false;
      return !project || w.project === project;
    }), 5);
    const latestDigest = newest(digests, 1);
    const projectLogs = project
      ? newest(transcripts.filter((t) => t.kind === "session-log" && t.project === project), 3)
      : [];

    const brief = capWords(renderBrief({
      project,
      generatedAt,
      latestLogs,
      unclaimedCaptures,
      activeWork,
      latestDigest,
      projectLogs,
      memoryTopics,
      healthWarnings,
    }), MAX_WORDS);

    let filesWritten: string[] = [];
    let indexUpdated = false;
    let logUpdated = false;

    if (input.write) {
      const writeResult = await writeBriefArtifacts(input.vault, {
        project,
        brief,
        generatedAt,
        today,
        wordCount: countWords(brief),
        memoryTopics,
      });
      filesWritten = writeResult.filesWritten;
      indexUpdated = writeResult.indexUpdated;
      logUpdated = writeResult.logUpdated;
    }

    const humanHint = brief;
    return {
      exitCode: ExitCode.OK,
      result: ok({
        project,
        brief,
        word_count: countWords(brief),
        files_written: filesWritten,
        index_updated: indexUpdated,
        log_updated: logUpdated,
        generated_at: generatedAt,
        memory_topics: memoryTopics,
        humanHint,
      }),
    };
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { message: String(e) }),
    };
  }
}

async function resolveProject(input: SessionBriefInput): Promise<string | undefined> {
  if (input.project && input.project !== "auto") return input.project;

  const envProject = input.env?.SKILLWIKI_PROJECT;
  if (envProject) return envProject;

  const cwd = input.cwd ?? process.cwd();
  const projectDotenv = await readProjectSlug(join(cwd, ".skillwiki", ".env"));
  if (projectDotenv) return projectDotenv;

  const inferred = inferProjectFromPath(input.vault, cwd);
  if (inferred) return inferred;

  return undefined;
}

async function readProjectSlug(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = line.match(/^PROJECT_SLUG=(.+)$/);
    if (match && match[1].trim().length > 0) return unquote(match[1].trim());
  }
  return undefined;
}

function inferProjectFromPath(vault: string, cwd: string): string | undefined {
  const rel = relative(vault, cwd).split(sep).join("/");
  const match = rel.match(/^projects\/([^/]+)(?:\/|$)/);
  return match?.[1];
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

async function loadTranscriptInfo(rawPages: VaultPage[]): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  for (const page of rawPages.filter((p) => p.relPath.startsWith("raw/transcripts/"))) {
    const text = await readPage(page);
    const fm = extractFrontmatter(text);
    if (!fm.ok) continue;
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    out.push({
      path: page.relPath,
      title: titleFromFmOrPath(fm.data, page.relPath),
      summary: summarize(body),
      date: stringField(fm.data.ingested) || dateFromPath(page.relPath),
      kind: stringField(fm.data.kind),
      project: wikilinkSlug(fm.data.project),
      workItem: wikilinkSlug(fm.data.work_item),
    });
  }
  return out;
}

async function loadWorkItems(workItemPages: VaultPage[]): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  for (const page of workItemPages.filter((p) => p.relPath.endsWith("/spec.md"))) {
    const text = await readPage(page);
    const fm = extractFrontmatter(text);
    if (!fm.ok) continue;
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    out.push({
      path: page.relPath,
      title: titleFromFmOrPath(fm.data, page.relPath),
      summary: summarize(body),
      date: stringField(fm.data.updated) || stringField(fm.data.created) || dateFromPath(page.relPath),
      status: stringField(fm.data.status),
      project: wikilinkSlug(fm.data.project),
    });
  }
  return out;
}

async function loadTrendDigests(typedPages: VaultPage[]): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  for (const page of typedPages.filter((p) => p.relPath.startsWith("queries/") && p.relPath.includes("agent-memory-trends"))) {
    const text = await readPage(page);
    const fm = extractFrontmatter(text);
    if (!fm.ok) continue;
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    out.push({
      path: page.relPath,
      title: titleFromFmOrPath(fm.data, page.relPath),
      summary: summarize(body),
      date: stringField(fm.data.updated) || stringField(fm.data.created) || dateFromPath(page.relPath),
    });
  }
  return out;
}

function renderBrief(input: {
  project?: string;
  generatedAt: string;
  latestLogs: PageInfo[];
  unclaimedCaptures: PageInfo[];
  activeWork: PageInfo[];
  latestDigest: PageInfo[];
  projectLogs: PageInfo[];
  memoryTopics: SessionBriefMemoryTopic[];
  healthWarnings: string[];
}): string {
  const lines = [
    "# Session Brief",
    "",
    `Generated: ${input.generatedAt}`,
    `Scope: ${input.project ? `[[${input.project}]] plus global context` : "global context"}`,
    "",
  ];

  appendSection(lines, "Active Work", input.activeWork, "No active project work found.");
  appendSection(lines, "Unclaimed Captures", input.unclaimedCaptures, "No unclaimed task or bug captures found.");
  appendSection(lines, "Recent Session Logs", input.project ? input.projectLogs : input.latestLogs, "No recent session logs found.");
  appendSection(lines, "Latest Agent Memory Trends", input.latestDigest, "No agent memory trends digest found.");
  appendMemoryTopicsSection(lines, input.project, input.memoryTopics);
  appendTextSection(lines, "Health Warnings", input.healthWarnings, "No high-level health warnings found.");

  lines.push(
    "## Suggested Commands",
    "",
    "- `skillwiki status`",
    input.project ? `- \`skillwiki project-index ${input.project}\`` : "- `skillwiki query \"active work\"`",
    "- `skillwiki transcripts --since <date>`",
    "",
  );

  return lines.join("\n").trimEnd() + "\n";
}

function appendMemoryTopicsSection(lines: string[], project: string | undefined, topics: SessionBriefMemoryTopic[]): void {
  if (!project || topics.length === 0) return;
  lines.push("## Memory Topics", "");
  for (const topic of topics.slice(0, 5)) {
    const sourceCount = topic.paths.length === 1 ? "1 source" : `${topic.paths.length} sources`;
    lines.push(`- ${topic.updated} ${topic.name} (${sourceCount}) — ${topic.summary}; recall: \`skillwiki memory recall --project ${project} --topic ${topic.name}\``);
  }
  lines.push("");
}

function appendSection(lines: string[], title: string, items: PageInfo[], empty: string): void {
  lines.push(`## ${title}`, "");
  if (items.length === 0) {
    lines.push(`- ${empty}`, "");
    return;
  }
  for (const item of items) {
    const status = item.status ? ` [${item.status}]` : "";
    const date = item.date ? `${item.date} ` : "";
    const summary = item.summary ? ` — ${item.summary}` : "";
    lines.push(`- ${date}${item.title}${status} (${item.path})${summary}`);
  }
  lines.push("");
}

function appendTextSection(lines: string[], title: string, items: string[], empty: string): void {
  lines.push(`## ${title}`, "");
  if (items.length === 0) {
    lines.push(`- ${empty}`, "");
    return;
  }
  for (const item of items.slice(0, 5)) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

async function loadHealthWarnings(vault: string): Promise<string[]> {
  const text = await readIfExists(join(vault, ".skillwiki", "health.json"));
  if (!text) return [];

  try {
    const parsed = JSON.parse(text) as {
      warnings?: unknown;
      risk_flags?: unknown;
      status?: unknown;
    };
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((w): w is string => typeof w === "string")
      : [];
    const riskFlags = Array.isArray(parsed.risk_flags)
      ? parsed.risk_flags.filter((w): w is string => typeof w === "string")
      : [];
    const status = typeof parsed.status === "string" && parsed.status !== "ok"
      ? [`health status: ${parsed.status}`]
      : [];
    return [...status, ...warnings, ...riskFlags].slice(0, 5);
  } catch {
    return [];
  }
}

async function loadMemoryTopics(vault: string, project: string): Promise<SessionBriefMemoryTopic[]> {
  const text = await readIfExists(join(vault, ".skillwiki", "memory", project, "topics.json"));
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { topics?: unknown };
    if (!Array.isArray(parsed.topics)) return [];
    return parsed.topics
      .filter((topic): topic is Record<string, unknown> => typeof topic === "object" && topic !== null && !Array.isArray(topic))
      .map((topic) => ({
        name: stringField(topic.name),
        summary: stringField(topic.summary),
        project: stringField(topic.project) || undefined,
        updated: stringField(topic.updated),
        paths: Array.isArray(topic.paths)
          ? topic.paths.filter((path): path is string => typeof path === "string")
          : [],
      }))
      .filter((topic) => topic.name && topic.summary && topic.updated && topic.paths.length > 0)
      .sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name))
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function writeBriefArtifacts(vault: string, input: {
  project?: string;
  brief: string;
  generatedAt: string;
  today: string;
  wordCount: number;
  memoryTopics: SessionBriefMemoryTopic[];
}): Promise<{ filesWritten: string[]; indexUpdated: boolean; logUpdated: boolean }> {
  const metaPath = join(vault, "meta", "latest-session-brief.md");
  const cacheMdPath = join(vault, ".skillwiki", "session-brief.md");
  const cacheJsonPath = join(vault, ".skillwiki", "session-brief.json");

  await mkdir(join(vault, "meta"), { recursive: true });
  await mkdir(join(vault, ".skillwiki"), { recursive: true });

  const committed = renderCommittedBrief(input);
  const previousComparable = comparableBrief(await readIfExists(metaPath));
  const nextComparable = comparableBrief(committed);
  const materialChange = previousComparable !== nextComparable;

  await writeFile(metaPath, committed, "utf8");
  await writeFile(cacheMdPath, input.brief, "utf8");
  await writeFile(cacheJsonPath, `${JSON.stringify({
    project: input.project,
    brief: input.brief,
    word_count: input.wordCount,
    generated_at: input.generatedAt,
    memory_topics: input.memoryTopics,
  }, null, 2)}\n`, "utf8");

  const indexUpdated = await ensureIndexEntry(vault);
  const logUpdated = materialChange ? await appendMaterialLog(vault, input.today) : false;

  if (materialChange) {
    appendLastOp(vault, {
      operation: "session-brief",
      summary: "refreshed latest session brief",
      files: [
        "meta/latest-session-brief.md",
        ".skillwiki/session-brief.md",
        ".skillwiki/session-brief.json",
      ],
      timestamp: input.generatedAt,
    });
  }

  return {
    filesWritten: [
      "meta/latest-session-brief.md",
      ".skillwiki/session-brief.md",
      ".skillwiki/session-brief.json",
    ],
    indexUpdated,
    logUpdated,
  };
}

function renderCommittedBrief(input: {
  project?: string;
  brief: string;
  generatedAt: string;
  today: string;
}): string {
  const projectLine = input.project ? `project_hint: "[[${input.project}]]"\n` : "";
  return [
    "---",
    "title: Latest Session Brief",
    `created: ${input.today}`,
    `updated: ${input.today}`,
    "type: meta",
    "tags: [meta, session-brief]",
    "confidence: high",
    "generated_by: skillwiki session-brief",
    `generated_at: ${input.generatedAt}`,
    "generated_kind: session-brief",
    projectLine.trimEnd(),
    "---",
    "",
    input.brief.trimEnd(),
    "",
  ].filter((line) => line !== "").join("\n");
}

async function ensureIndexEntry(vault: string): Promise<boolean> {
  const indexPath = join(vault, "index.md");
  let text = await readIfExists(indexPath);
  if (!text) return false;
  if (text.includes("[[meta/latest-session-brief]]")) return false;

  const entry = "- [[meta/latest-session-brief]] — Latest Session Brief";
  const lines = text.split(/\r?\n/);
  const sectionIdx = lines.findIndex((line) => line.trim() === "## Meta");
  if (sectionIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", "## Meta", entry);
  } else {
    let insertAt = sectionIdx + 1;
    while (insertAt < lines.length && !lines[insertAt].startsWith("## ")) insertAt++;
    lines.splice(insertAt, 0, entry);
  }
  await writeFile(indexPath, lines.join("\n"), "utf8");
  return true;
}

async function appendMaterialLog(vault: string, today: string): Promise<boolean> {
  const logPath = join(vault, "log.md");
  const text = await readIfExists(logPath);
  if (!text) return false;
  const entry = `\n## [${today}] session-brief | refreshed: meta/latest-session-brief.md`;
  await writeFile(logPath, text.trimEnd() + entry + "\n", "utf8");
  return true;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function comparableBrief(text: string): string {
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("created:"))
    .filter((line) => !line.startsWith("updated:"))
    .filter((line) => !line.startsWith("generated_at:"))
    .filter((line) => !line.startsWith("Generated: "))
    .join("\n")
    .trim();
}

function newest<T extends { date: string; path: string }>(items: T[], limit: number): T[] {
  return [...items]
    .sort((a, b) => b.date.localeCompare(a.date) || b.path.localeCompare(a.path))
    .slice(0, limit);
}

function titleFromFmOrPath(fm: Record<string, unknown>, path: string): string {
  return stringField(fm.title) || path.split("/").pop()?.replace(/\.md$/, "") || path;
}

function summarize(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("```"));
  const summary = lines.join(" ").replace(/\s+/g, " ").trim();
  return summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}...` : summary;
}

function capWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "\n";
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function wikilinkSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^\[\[([^\]]+)\]\]$/);
  return match?.[1] ?? value;
}

function dateFromPath(path: string): string {
  return path.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}
