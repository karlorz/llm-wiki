import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "@skillwiki/shared";
import { runPageRenderHtml, renderPageHtml } from "../../src/commands/page-render-html.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "output-standard-v2");

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - documentation
\`\`\`
`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-html-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw/articles"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

function page(opts: { html?: boolean; body?: string }): string {
  return [
    "---",
    "title: Render Target",
    `created: ${today()}`,
    `updated: ${today()}`,
    "type: comparison",
    "tags: [documentation]",
    "sources: [raw/articles/x.md]",
    "provenance: research",
    "output_standard: v2",
    opts.html ? "html_render: true" : "",
    "---",
    "",
    opts.body ?? "# Render Target\n\n## Overview\n\nHello world.\n\n## Details\n\nMore text.\n",
  ].filter((line) => line !== "").join("\n");
}

describe("page render-html", () => {
  it("refuses pages that did not opt in", async () => {
    const v = vault();
    writeFileSync(join(v, "comparisons/plain.md"), page({ html: false }));
    const out = join(tmpdir(), `sw-html-${Date.now()}.html`);
    const res = await runPageRenderHtml({ vault: v, page: "comparisons/plain.md", out });
    expect(res.exitCode).toBe(ExitCode.HTML_RENDER_NOT_OPTED_IN);
    expect(res.result.ok).toBe(false);
    if (!res.result.ok) expect(res.result.error).toBe("HTML_RENDER_NOT_OPTED_IN");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses an --out path inside the vault", async () => {
    const v = vault();
    writeFileSync(join(v, "comparisons/ok.md"), page({ html: true }));
    const res = await runPageRenderHtml({
      vault: v,
      page: "comparisons/ok.md",
      out: join(v, "rendered.html"),
    });
    expect(res.result.ok).toBe(false);
    if (!res.result.ok) expect(res.result.error).toBe("HTML_RENDER_OUT_INSIDE_VAULT");
    expect(existsSync(join(v, "rendered.html"))).toBe(false);
  });

  it("renders the comparison sample to a self-contained file", async () => {
    const v = vault();
    const src = readFileSync(join(FIXTURE_DIR, "comparison-sample.md"), "utf8")
      .replace(/^created: .+$/m, `created: ${today()}`)
      .replace(/^updated: .+$/m, `updated: ${today()}`);
    writeFileSync(join(v, "comparisons/comparison-sample.md"), src);
    const out = join(mkdtempSync(join(tmpdir(), "sw-html-out-")), "comparison.html");
    const res = await runPageRenderHtml({
      vault: v,
      page: "comparisons/comparison-sample.md",
      out,
    });
    expect(res.exitCode).toBe(ExitCode.OK);
    expect(res.result.ok).toBe(true);
    const html = readFileSync(out, "utf8");
    expect(html).not.toMatch(/<script\s+src/i);
    expect(html).not.toMatch(/<link\s+rel=["']stylesheet["']/i);
    expect(html).not.toMatch(/<(script|link|img)\b[^>]+\b(?:src|href)=["']https?:\/\//i);
    expect(html).toContain('class="toc"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("<details");
    expect(html).not.toContain("cdn.jsdelivr");
    expect(html).not.toContain("mermaid.min.js");
  });

  it("keeps mermaid as readable source and inlines CSS/JS only", () => {
    const html = renderPageHtml("Demo", [
      "# Demo",
      "",
      "## Overview",
      "",
      "A short paragraph with **bold**, *italic*, `code`, [[Wiki Page]], and a [link](https://example.com).",
      "",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "## Details",
      "",
      "- one",
      "- two",
    ].join("\n"));
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("flowchart TD");
    expect(html).toContain("Wiki Page");
    expect(html).not.toContain("[[Wiki Page]]");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toMatch(/<script\s+src/i);
    expect(html).not.toMatch(/<link\s+rel=["']stylesheet["']/i);
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).toContain('id="toc"');
    expect(html).toContain("<details");
  });

  it("drops links with unsafe schemes and keeps their label", () => {
    const html = renderPageHtml("Demo", [
      "# Demo",
      "",
      "## Overview",
      "",
      "Click [here](javascript:alert(1)) or [docs](https://example.com).",
    ].join("\n"));
    expect(html).not.toContain("javascript:");
    expect(html).toContain("here");
    expect(html).toContain('<a href="https://example.com">docs</a>');
  });
});
