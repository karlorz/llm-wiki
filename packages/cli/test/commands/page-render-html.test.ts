import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

  it("refuses --out via a symlinked alias of the vault before any write", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-html-alias-"));
    const v = join(root, "vault");
    mkdirSync(v);
    writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
    writeFileSync(join(v, "index.md"), "# Index\n");
    writeFileSync(join(v, "log.md"), "# Vault Log\n");
    mkdirSync(join(v, "comparisons"), { recursive: true });
    writeFileSync(join(v, "comparisons/ok.md"), page({ html: true }));
    const alias = join(root, "alias");
    symlinkSync(v, alias);

    const res = await runPageRenderHtml({
      vault: v,
      page: "comparisons/ok.md",
      out: join(alias, "written-inside-vault.html"),
    });
    expect(res.result.ok).toBe(false);
    if (!res.result.ok) expect(res.result.error).toBe("HTML_RENDER_OUT_INSIDE_VAULT");
    expect(existsSync(join(v, "written-inside-vault.html"))).toBe(false);
    expect(existsSync(join(alias, "written-inside-vault.html"))).toBe(false);
  });

  it("refuses --out in the real vault when the vault argument is a symlink alias", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-html-valias-"));
    const v = join(root, "vault");
    mkdirSync(v);
    writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
    writeFileSync(join(v, "index.md"), "# Index\n");
    writeFileSync(join(v, "log.md"), "# Vault Log\n");
    mkdirSync(join(v, "comparisons"), { recursive: true });
    writeFileSync(join(v, "comparisons/ok.md"), page({ html: true }));
    const alias = join(root, "alias");
    symlinkSync(v, alias);

    const res = await runPageRenderHtml({
      vault: alias,
      page: "comparisons/ok.md",
      out: join(v, "written-via-vault-alias.html"),
    });
    expect(res.result.ok).toBe(false);
    if (!res.result.ok) expect(res.result.error).toBe("HTML_RENDER_OUT_INSIDE_VAULT");
    expect(existsSync(join(v, "written-via-vault-alias.html"))).toBe(false);
  });

  it("refuses a relative --out path that resolves inside the vault from cwd", async () => {
    const v = vault();
    writeFileSync(join(v, "comparisons/ok.md"), page({ html: true }));
    const outAbs = join(v, "via-relative.html");
    const outRel = relative(process.cwd(), outAbs);
    expect(outRel.length).toBeGreaterThan(0);
    const res = await runPageRenderHtml({
      vault: v,
      page: "comparisons/ok.md",
      out: outRel,
    });
    expect(res.result.ok).toBe(false);
    if (!res.result.ok) expect(res.result.error).toBe("HTML_RENDER_OUT_INSIDE_VAULT");
    expect(existsSync(outAbs)).toBe(false);
  });

  it("refuses a nonexistent nested --out suffix under a vault alias before mkdir", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-html-nested-"));
    const v = join(root, "vault");
    mkdirSync(v);
    writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
    writeFileSync(join(v, "index.md"), "# Index\n");
    writeFileSync(join(v, "log.md"), "# Vault Log\n");
    mkdirSync(join(v, "comparisons"), { recursive: true });
    writeFileSync(join(v, "comparisons/ok.md"), page({ html: true }));
    const alias = join(root, "alias");
    symlinkSync(v, alias);

    const res = await runPageRenderHtml({
      vault: v,
      page: "comparisons/ok.md",
      out: join(alias, "nested", "deeper", "file.html"),
    });
    expect(res.result.ok).toBe(false);
    if (!res.result.ok) expect(res.result.error).toBe("HTML_RENDER_OUT_INSIDE_VAULT");
    expect(existsSync(join(v, "nested"))).toBe(false);
    expect(existsSync(join(alias, "nested"))).toBe(false);
  });

  it("refuses --out when the path itself is an existing symlink", async () => {
    const v = vault();
    writeFileSync(join(v, "comparisons/ok.md"), page({ html: true }));
    const destDir = mkdtempSync(join(tmpdir(), "vault-html-outlink-"));
    const target = join(destDir, "target.html");
    const linked = join(destDir, "linked.html");
    writeFileSync(target, "old\n");
    symlinkSync(target, linked);
    const res = await runPageRenderHtml({
      vault: v,
      page: "comparisons/ok.md",
      out: linked,
    });
    expect(res.result.ok).toBe(false);
    if (!res.result.ok) expect(res.result.error).toBe("HTML_RENDER_OUT_INSIDE_VAULT");
    expect(readFileSync(target, "utf8")).toBe("old\n");
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

  it("wires TOC and hash navigation through the same activate function as tab clicks", () => {
    const html = renderPageHtml("Demo", [
      "# Demo",
      "",
      "## Overview",
      "",
      "First panel.",
      "",
      "## Comparison",
      "",
      "Second panel.",
    ].join("\n"));
    expect(html).toContain("function activate");
    expect(html).toContain("nav.toc a[href^='#']");
    expect(html).toContain("hashchange");
    expect(html).toContain("location.hash");
    expect(html).toContain("fromHash");
    expect(html).toContain('id="comparison"');
    expect(html).toMatch(/<section id="comparison"[^>]* hidden/);

    const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    expect(script).toBeTruthy();

    type El = {
      id: string;
      hidden: boolean;
      attrs: Record<string, string>;
      listeners: Record<string, Array<() => void>>;
      getAttribute(name: string): string | null;
      setAttribute(name: string, value: string): void;
      addEventListener(type: string, fn: () => void): void;
    };
    const makeEl = (init: Record<string, string | boolean>): El => {
      const el: El = {
        id: String(init.id ?? ""),
        hidden: Boolean(init.hidden),
        attrs: Object.fromEntries(
          Object.entries(init).filter(([, value]) => typeof value === "string") as Array<[string, string]>,
        ),
        listeners: {},
        getAttribute(name) {
          return el.attrs[name] ?? null;
        },
        setAttribute(name, value) {
          el.attrs[name] = value;
        },
        addEventListener(type, fn) {
          el.listeners[type] = el.listeners[type] ?? [];
          el.listeners[type]!.push(fn);
        },
      };
      if (typeof init.hidden === "boolean") el.hidden = init.hidden;
      return el;
    };
    const run = (initialHash: string) => {
      const tabs = [
        makeEl({ "data-tab": "overview", "aria-selected": "true" }),
        makeEl({ "data-tab": "comparison", "aria-selected": "false" }),
      ];
      const panels = [
        makeEl({ id: "overview", hidden: false }),
        makeEl({ id: "comparison", hidden: true }),
      ];
      const toc = [
        makeEl({ href: "#overview" }),
        makeEl({ href: "#comparison" }),
      ];
      let hash = initialHash;
      const windowListeners: Record<string, Array<() => void>> = {};
      const document = {
        querySelectorAll(sel: string) {
          if (sel === '[role="tab"]') return tabs;
          if (sel === ".tab-panel") return panels;
          if (sel === "nav.toc a[href^='#']") return toc;
          return [];
        },
      };
      const windowObj = {
        addEventListener(type: string, fn: () => void) {
          windowListeners[type] = windowListeners[type] ?? [];
          windowListeners[type]!.push(fn);
        },
      };
      const location = { get hash() { return hash; } };
      new Function("document", "window", "location", script!)(document, windowObj, location);
      return {
        tabs,
        panels,
        toc,
        setHash(next: string) {
          hash = next;
          for (const fn of windowListeners.hashchange ?? []) fn();
        },
      };
    };

    const initial = run("#comparison");
    expect(initial.panels[1]!.hidden).toBe(false);
    expect(initial.panels[0]!.hidden).toBe(true);
    expect(initial.tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(initial.tabs[0]!.getAttribute("aria-selected")).toBe("false");

    const clicked = run("");
    clicked.toc[1]!.listeners.click![0]!();
    expect(clicked.panels[1]!.hidden).toBe(false);
    expect(clicked.panels[0]!.hidden).toBe(true);
    expect(clicked.tabs[1]!.getAttribute("aria-selected")).toBe("true");
    clicked.setHash("#overview");
    expect(clicked.panels[0]!.hidden).toBe(false);
    expect(clicked.tabs[0]!.getAttribute("aria-selected")).toBe("true");
    clicked.tabs[1]!.listeners.click![0]!();
    expect(clicked.panels[1]!.hidden).toBe(false);
    expect(clicked.tabs[1]!.getAttribute("aria-selected")).toBe("true");
  });
});
