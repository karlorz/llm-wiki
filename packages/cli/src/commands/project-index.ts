import { readdir, readFile, mkdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { atomicWriteText } from "../utils/atomic-write.js";

export interface ProjectIndexInput {
  vault: string;
  slug: string;
  apply: boolean;
}

export interface IndexEntry {
  page: string;
  type: string;
  title: string;
}

export interface ProjectIndexOutput {
  slug: string;
  entries: IndexEntry[];
  existing: boolean;
  stale: boolean;
  index_path: string;
  humanHint: string;
}

const LAYER2_DIRS = ["entities", "concepts", "comparisons", "queries", "meta"];
const PROJECT_LOCAL_DIRS = ["requirements", "work", "architecture", "history"];

async function scanMarkdownTree(rootAbs: string, rootRel: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(rootAbs, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const abs = join(rootAbs, entry.name);
    const rel = `${rootRel}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...await scanMarkdownTree(abs, rel));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(rel);
    }
  }

  return found;
}

function projectLocalType(slug: string, page: string, data: Record<string, unknown>): string {
  if (page.startsWith(`projects/${slug}/requirements/`)) return "requirement";
  if (page.startsWith(`projects/${slug}/work/`)) {
    if (typeof data.kind === "string") return data.kind;
    const name = basename(page, ".md");
    if (name === "spec" || name === "plan" || name === "retro") return name;
    return "work";
  }
  if (page.startsWith(`projects/${slug}/architecture/`)) {
    return typeof data.type === "string" ? data.type : "architecture";
  }
  if (page.startsWith(`projects/${slug}/history/`)) {
    if (typeof data.kind === "string") return data.kind;
    if (typeof data.type === "string") return data.type;
    return "history";
  }
  return typeof data.type === "string" ? data.type : "project";
}

export interface ProjectIndexRender {
  text: string;
  entries: IndexEntry[];
  index_path: string;
}

/** Pure project knowledge.md renderer used by project-index and derived-conflict resolution. */
export async function renderProjectIndex(
  vault: string,
  slug: string,
  opts: { today?: string } = {},
): Promise<Result<ProjectIndexRender>> {
  const projectDir = join(vault, "projects", slug);

  try {
    await readdir(projectDir);
  } catch {
    return err("PROJECT_NOT_FOUND", { slug, path: projectDir });
  }

  const wikilinkPattern = `[[${slug}]]`;
  const entries: IndexEntry[] = [];

  const compoundDir = join(vault, "projects", slug, "compound");
  try {
    const compoundFiles = await readdir(compoundDir, { withFileTypes: true });
    for (const entry of compoundFiles) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = join(compoundDir, entry.name);
      let text: string;
      try { text = await readFile(filePath, "utf8"); } catch { continue; }

      const fm = extractFrontmatter(text);
      if (!fm.ok) continue;

      entries.push({
        page: `projects/${slug}/compound/${entry.name}`,
        type: typeof fm.data.type === "string" ? fm.data.type : "compound",
        title: typeof fm.data.title === "string" ? fm.data.title : entry.name.replace(/\.md$/, ""),
      });
    }
  } catch { /* no compound dir */ }

  for (const dir of LAYER2_DIRS) {
    let files: Array<{ name: string; isFile: () => boolean }>;
    try {
      files = await readdir(join(vault, dir), { withFileTypes: true });
    } catch { continue; }

    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = join(vault, dir, entry.name);
      let text: string;
      try { text = await readFile(filePath, "utf8"); } catch { continue; }

      const fm = extractFrontmatter(text);
      if (!fm.ok) continue;

      const pp = fm.data.provenance_projects;
      if (!Array.isArray(pp) || !pp.some((p: unknown) => String(p) === wikilinkPattern)) continue;

      entries.push({
        page: `${dir}/${entry.name}`,
        type: typeof fm.data.type === "string" ? fm.data.type : dir.slice(0, -1),
        title: typeof fm.data.title === "string" ? fm.data.title : entry.name.replace(/\.md$/, ""),
      });
    }
  }

  for (const dir of PROJECT_LOCAL_DIRS) {
    const rootAbs = join(projectDir, dir);
    const rootRel = `projects/${slug}/${dir}`;
    const pages = await scanMarkdownTree(rootAbs, rootRel);

    for (const page of pages) {
      const filePath = join(vault, page);
      let text: string;
      try { text = await readFile(filePath, "utf8"); } catch { continue; }

      const fm = extractFrontmatter(text);
      if (!fm.ok) continue;

      entries.push({
        page,
        type: projectLocalType(slug, page, fm.data),
        title: typeof fm.data.title === "string" ? fm.data.title : basename(page, ".md"),
      });
    }
  }

  const typeOrder: Record<string, number> = {
    entity: 0, concept: 1, comparison: 2, query: 3, summary: 4, meta: 5, requirement: 6,
    spec: 7, plan: 8, retro: 9, architecture: 10, pattern: 11, gotcha: 12, lesson: 13,
    antipattern: 14, compound: 15, work: 16, history: 17,
  };
  entries.sort((a, b) => {
    const ta = typeOrder[a.type] ?? 99;
    const tb = typeOrder[b.type] ?? 99;
    return ta !== tb ? ta - tb : a.title.localeCompare(b.title);
  });

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const grouped = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const group = e.type;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(e);
  }

  let body = `# Knowledge Index: ${slug}\n\nAutogenerated by \`skillwiki project-index\` on ${today}.\n\n`;
  for (const [type, items] of grouped) {
    body += `## ${type}\n\n`;
    for (const item of items) {
      const pageRef = item.page.replace(/\.md$/, "");
      body += `- [[${pageRef}]] — ${item.title}\n`;
    }
    body += "\n";
  }

  if (entries.length === 0) {
    body += `No Layer 2 pages reference \`[[${slug}]]\` in provenance_projects.\n`;
  }

  return ok({
    text: body,
    entries,
    index_path: `projects/${slug}/knowledge.md`,
  });
}

export async function runProjectIndex(input: ProjectIndexInput): Promise<{ exitCode: number; result: Result<ProjectIndexOutput> }> {
  const slug = input.slug;
  const projectDir = join(input.vault, "projects", slug);
  const rendered = await renderProjectIndex(input.vault, slug);
  if (!rendered.ok) {
    return {
      exitCode: rendered.error === "PROJECT_NOT_FOUND" ? ExitCode.PROJECT_NOT_FOUND : ExitCode.WRITE_FAILED,
      result: rendered,
    };
  }

  const indexPath = join(projectDir, "knowledge.md");
  const entries = rendered.data.entries;

  let existing = false;
  let stale = false;
  try {
    const existingText = await readFile(indexPath, "utf8");
    existing = true;
    const existingEntries = existingText.split("\n").filter(l => l.startsWith("- [["));
    const existingPages = new Set(existingEntries.map(l => {
      const m = l.match(/\[\[([^\]]+)\]\]/);
      return m ? m[1] : "";
    }));
    const currentPages = new Set(entries.map(e => e.page.replace(/\.md$/, "")));
    stale = existingPages.size !== currentPages.size || [...currentPages].some(p => !existingPages.has(p));
  } catch { /* no existing index */ }

  if (input.apply) {
    try {
      await mkdir(dirname(indexPath), { recursive: true });
    } catch (e: unknown) {
      return {
        exitCode: ExitCode.WRITE_FAILED,
        result: err("WRITE_FAILED", { file: indexPath, message: String(e) }),
      };
    }
    const written = await atomicWriteText(indexPath, rendered.data.text);
    if (!written.ok) {
      return { exitCode: ExitCode.WRITE_FAILED, result: written };
    }
  }

  const action = input.apply
    ? `written ${entries.length} entries to ${indexPath}`
    : `${entries.length} entries found (use --apply to write)`;
  const staleHint = stale ? " (STALE — existing index outdated)" : existing ? " (up to date)" : "";

  return {
    exitCode: ExitCode.OK,
    result: ok({
      slug,
      entries,
      existing,
      stale,
      index_path: rendered.data.index_path,
      humanHint: `project: ${slug}\nentries: ${entries.length}${staleHint}\n${action}\n\n${entries.map(e => `  ${e.type}: [[${e.page.replace(/\.md$/, "")}]] — ${e.title}`).join("\n")}`,
    }),
  };
}
