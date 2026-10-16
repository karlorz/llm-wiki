import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { err, ok, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { resolveExistingRegularFileInsideVault } from "../utils/vault-path-safety.js";

export interface PageRenderHtmlInput {
  vault: string;
  page: string;
  out: string;
}

export interface PageRenderHtmlOutput {
  page: string;
  out: string;
  bytes: number;
  humanHint: string;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function slugifyHeading(text: string, used: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n + 1}`;
}

export function renderInlineMarkdown(raw: string): string {
  const re = /(`[^`]+`)|(\[\[(?:[^\]]+)\]\])|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    parts.push(escapeHtml(raw.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(`<code>${escapeHtml(token.slice(1, -1))}</code>`);
    } else if (token.startsWith("[[")) {
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf("|");
      const label = pipe === -1 ? inner : inner.slice(pipe + 1);
      parts.push(escapeHtml(label.trim()));
    } else if (token.startsWith("![")) {
      const alt = token.match(/^!\[([^\]]*)\]/)?.[1] ?? "";
      parts.push(escapeHtml(alt));
    } else if (token.startsWith("[")) {
      const linked = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linked) {
        parts.push(`<a href="${escapeAttr(linked[2]!)}">${escapeHtml(linked[1]!)}</a>`);
      } else {
        parts.push(escapeHtml(token));
      }
    } else if (token.startsWith("**")) {
      parts.push(`<strong>${escapeHtml(token.slice(2, -2))}</strong>`);
    } else {
      parts.push(`<em>${escapeHtml(token.slice(1, -1))}</em>`);
    }
    last = match.index + token.length;
  }
  parts.push(escapeHtml(raw.slice(last)));
  return parts.join("");
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "code"; language: string; text: string };

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEnd = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutEnd.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

export function parseMarkdownBlocks(body: string): Block[] {
  const lines = body.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[2]!;
      const language = fence[3]!.trim();
      const content: string[] = [];
      i++;
      while (i < lines.length) {
        const close = lines[i]!.match(/^(\s*)(`{3,}|~{3,})\s*$/);
        if (close && close[2]![0] === marker[0] && close[2]!.length >= marker.length) break;
        content.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: "code", language, text: content.join("\n") });
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(\S.*)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows = [parseTableRow(line)];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!) && !isTableSeparator(lines[i]!)) {
        rows.push(parseTableRow(lines[i]!));
        i++;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ordered || unordered) {
      const isOrdered = Boolean(ordered);
      const itemRe = isOrdered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i]!.match(itemRe);
        if (!item) break;
        const chunks = [item[1]!];
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i]!) && !itemRe.test(lines[i]!) && !/^(#{1,6})\s+/.test(lines[i]!)) {
          chunks.push(lines[i]!.trim());
          i++;
        }
        items.push(chunks.join(" "));
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (!next.trim()) break;
      if (/^(#{1,6})\s+/.test(next) || /^(\s*)(`{3,}|~{3,})/.test(next) || /^\s*\|.*\|\s*$/.test(next) || /^\s*\d+\.\s+/.test(next) || /^\s*[-*+]\s+/.test(next)) {
        break;
      }
      para.push(next.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }

  return blocks;
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "heading": {
      const tag = `h${Math.min(block.level, 6)}`;
      return `<${tag}>${renderInlineMarkdown(block.text)}</${tag}>`;
    }
    case "paragraph":
      return `<p>${renderInlineMarkdown(block.text)}</p>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "table": {
      if (block.rows.length === 0) return "";
      const [header, ...body] = block.rows;
      const thead = `<thead><tr>${header!.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
      const tbody = body.length > 0
        ? `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
      return `<table>${thead}${tbody}</table>`;
    }
    case "code": {
      const cls = block.language.toLowerCase() === "mermaid" ? " class=\"mermaid\"" : "";
      return `<pre${cls}><code>${escapeHtml(block.text)}</code></pre>`;
    }
  }
}

interface Section {
  id: string;
  title: string;
  blocks: Block[];
}

function groupSections(blocks: Block[]): { title: string; intro: Block[]; sections: Section[] } {
  const used = new Map<string, number>();
  let title = "Page";
  const intro: Block[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 1 && title === "Page") {
      title = block.text;
      continue;
    }
    if (block.kind === "heading" && block.level === 2) {
      current = { id: slugifyHeading(block.text, used), title: block.text, blocks: [] };
      sections.push(current);
      continue;
    }
    if (current) current.blocks.push(block);
    else intro.push(block);
  }

  return { title, intro, sections };
}

export function renderPageHtml(title: string, body: string): string {
  const parsed = parseMarkdownBlocks(body);
  const grouped = groupSections(parsed);
  const pageTitle = grouped.title !== "Page" ? grouped.title : title;
  const sections = grouped.sections.length > 0
    ? grouped.sections
    : [{ id: "content", title: pageTitle, blocks: grouped.intro }];
  const introHtml = grouped.sections.length > 0 && grouped.intro.length > 0
    ? grouped.intro.map(renderBlock).join("\n")
    : "";

  const toc = sections
    .map((section) => `<li><a href="#${escapeAttr(section.id)}">${escapeHtml(section.title)}</a></li>`)
    .join("");
  const tabs = sections
    .map((section, index) =>
      `<button type="button" role="tab" aria-selected="${index === 0 ? "true" : "false"}" aria-controls="${escapeAttr(section.id)}" data-tab="${escapeAttr(section.id)}">${escapeHtml(section.title)}</button>`
    )
    .join("");
  const panels = sections
    .map((section, index) => {
      const inner = section.blocks.map(renderBlock).join("\n");
      return `<section id="${escapeAttr(section.id)}" class="tab-panel" role="tabpanel"${index === 0 ? "" : " hidden"}><details open><summary>${escapeHtml(section.title)}</summary>\n${inner}\n</details></section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f5f0; --fg: #1b1b1b; --accent: #355c7d; --line: #cfc8bc; }
body { margin: 0 auto; max-width: 52rem; padding: 1.5rem; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
nav.toc { border: 1px solid var(--line); padding: 0.75rem 1rem; margin-bottom: 1rem; }
nav.toc ol { margin: 0; padding-left: 1.25rem; }
.tabs { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 1rem 0; }
.tabs button { border: 1px solid var(--line); background: transparent; color: inherit; padding: 0.35rem 0.7rem; cursor: pointer; }
.tabs button[aria-selected="true"] { background: var(--accent); color: #fff; }
.tab-panel { border: 1px solid var(--line); padding: 0.75rem; }
details { margin: 0; }
summary { cursor: pointer; font-weight: 600; }
pre { overflow: auto; padding: 0.75rem; background: #111; color: #f5f5f5; }
pre.mermaid { white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--line); padding: 0.35rem 0.5rem; text-align: left; }
a { color: var(--accent); }
</style>
</head>
<body>
<nav class="toc" id="toc"><strong>Contents</strong><ol>${toc}</ol></nav>
${introHtml}
<div class="tabs" role="tablist">${tabs}</div>
${panels}
<script>
(function () {
  var tabs = document.querySelectorAll('[role="tab"]');
  var panels = document.querySelectorAll('.tab-panel');
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var id = tab.getAttribute("data-tab");
      tabs.forEach(function (other) { other.setAttribute("aria-selected", other === tab ? "true" : "false"); });
      panels.forEach(function (panel) { panel.hidden = panel.id !== id; });
    });
  });
})();
</script>
</body>
</html>
`;
}

function isInsideVault(vault: string, candidate: string): boolean {
  const rel = relative(resolve(vault), resolve(candidate)).split(sep).join("/");
  return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

export async function runPageRenderHtml(
  input: PageRenderHtmlInput,
): Promise<{ exitCode: number; result: Result<PageRenderHtmlOutput> }> {
  if (!input.out || input.out.trim().length === 0) {
    return {
      exitCode: ExitCode.USAGE,
      result: err("USAGE", { message: "--out is required" }),
    };
  }

  const pagePath = await resolveExistingRegularFileInsideVault(input.vault, input.page);
  if (!pagePath.ok) {
    return {
      exitCode: pagePath.error === "FILE_NOT_FOUND" ? ExitCode.FILE_NOT_FOUND : ExitCode.VAULT_PATH_INVALID,
      result: pagePath,
    };
  }

  if (isInsideVault(input.vault, input.out)) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("HTML_RENDER_OUT_INSIDE_VAULT", {
        vault: input.vault,
        out: input.out,
        message: "--out must be outside the vault",
      }),
    };
  }

  let text: string;
  try {
    text = await readFile(pagePath.data, "utf8");
  } catch {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("FILE_NOT_FOUND", { path: input.page }),
    };
  }

  const fm = extractFrontmatter(text);
  if (!fm.ok) {
    return {
      exitCode: ExitCode.INVALID_FRONTMATTER,
      result: fm,
    };
  }
  if (fm.data.html_render !== true) {
    return {
      exitCode: ExitCode.HTML_RENDER_NOT_OPTED_IN,
      result: err("HTML_RENDER_NOT_OPTED_IN", {
        page: input.page,
        message: "page frontmatter must set html_render: true",
      }),
    };
  }

  const split = splitFrontmatter(text);
  if (!split.ok) {
    return { exitCode: ExitCode.MISSING_CLOSING_DELIMITER, result: split };
  }

  const title = typeof fm.data.title === "string" ? fm.data.title : input.page;
  const html = renderPageHtml(title, split.data.body);
  const outAbs = resolve(input.out);

  try {
    await mkdir(dirname(outAbs), { recursive: true });
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { path: outAbs, message: String(error) }),
    };
  }

  const written = await atomicWriteText(outAbs, html);
  if (!written.ok) {
    return { exitCode: ExitCode.WRITE_FAILED, result: written };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      page: input.page,
      out: outAbs,
      bytes: Buffer.byteLength(html, "utf8"),
      humanHint: `Wrote ${outAbs} (${Buffer.byteLength(html, "utf8")} bytes)`,
    }),
  };
}
