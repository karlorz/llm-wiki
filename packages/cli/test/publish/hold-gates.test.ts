import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExitCode } from "@skillwiki/shared";
import { runPagePublish } from "../../src/commands/page-publish.js";
import { runProjectPagePublish } from "../../src/commands/project-page-publish.js";
import { runSourceReviews } from "../../src/commands/source-compile.js";
import { readLogEvents } from "../../src/utils/log-events.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeVault(tags: string[] = ["research", "adr"]): string {
  const vault = mkdtempSync(join(tmpdir(), "hold-gates-vault-"));
  dirs.push(vault);
  writeFileSync(
    join(vault, "SCHEMA.md"),
    `# Vault Schema\n\n## Tag Taxonomy\n\n\`\`\`yaml\ntaxonomy:\n${tags.map((t) => `  - ${t}`).join("\n")}\n\`\`\`\n`,
  );
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Queries\n\n## Concepts\n");
  writeFileSync(join(vault, "log.md"), "# Vault Log\n");
  for (const dir of ["entities", "concepts", "comparisons", "queries", "meta"]) {
    mkdirSync(join(vault, dir), { recursive: true });
  }
  mkdirSync(join(vault, "raw", "articles"), { recursive: true });
  writeFileSync(
    join(vault, "raw", "articles", "source.md"),
    "---\ntitle: Source\nsource_url: https://example.com\ningested: 2026-08-02\n---\nBody\n",
  );
  mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
  writeFileSync(
    join(vault, "projects", "llm-wiki", "README.md"),
    "---\ntitle: llm-wiki\n---\n\n# llm-wiki\n",
  );
  return vault;
}

function writeDraftFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hold-gates-draft-"));
  dirs.push(dir);
  const file = join(dir, "draft.md");
  writeFileSync(file, content);
  return file;
}

function cleanPageDraft(): string {
  return `---
title: Clean Query
aliases: []
created: 2026-08-18
updated: 2026-08-18
type: query
tags: [research]
sources: [raw/articles/source.md]
confidence: medium
---

# Clean Query

Summary of findings ^[raw/articles/source.md].

## Sources

- ^[raw/articles/source.md]
`;
}

function schemaInvalidDraft(): string {
  return `---
title: Schema Invalid Query
aliases: []
created: 2026-08-18
updated: 2026-08-18
type: query
tags: "not-an-array"
sources: [raw/articles/source.md]
confidence: medium
---

# Schema Invalid Query

Summary ^[raw/articles/source.md].

## Sources

- ^[raw/articles/source.md]
`;
}

function brokenWikilinkDraft(): string {
  return `---
title: Broken Link Query
aliases: []
created: 2026-08-18
updated: 2026-08-18
type: query
tags: [research]
sources: [raw/articles/source.md]
confidence: medium
---

# Broken Link Query

Link to [[nonexistent-destination]] here ^[raw/articles/source.md].

## Sources

- ^[raw/articles/source.md]
`;
}

function citationMarkerMissingDraft(): string {
  return `---
title: Missing Citation Marker Query
aliases: []
created: 2026-08-18
updated: 2026-08-18
type: query
tags: [research]
sources: [raw/articles/source.md]
confidence: medium
---

# Missing Citation Marker Query

This body declares sources in frontmatter but contains no citation markers anywhere.
`;
}

function sensitiveContentDraft(): string {
  return `---
title: Sensitive Query
aliases: []
created: 2026-08-18
updated: 2026-08-18
type: query
tags: [research]
sources: [raw/articles/source.md]
confidence: medium
---

# Sensitive Query

Authorization: Bearer sk-ant-api03-${"a".repeat(32)}

## Sources

- ^[raw/articles/source.md]
`;
}

describe("deterministic auto-hold review gates", () => {
  it("clean draft publishes unchanged on write", async () => {
    const vault = makeVault();
    const draft = writeDraftFile(cleanPageDraft());

    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/clean.md",
      write: true,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("publish failed");
    expect((result.result.data as { held?: boolean }).held).toBeFalsy();
    expect(existsSync(join(vault, "queries", "clean.md"))).toBe(true);
  });

  it("dry-run on clean draft previews publication without hold", async () => {
    const vault = makeVault();
    const draft = writeDraftFile(cleanPageDraft());

    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/clean.md",
      write: false,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("dry run failed");
    expect((result.result.data as { held?: boolean }).held).toBe(false);
    expect((result.result.data as { hold_reasons?: string[] }).hold_reasons).toEqual([]);
    expect(existsSync(join(vault, "queries", "clean.md"))).toBe(false);
  });

  it("gate 1: schema-invalid draft holds on publish --write (exit 0, held:true, review event emitted, no vault write)", async () => {
    const vault = makeVault();
    const draft = writeDraftFile(schemaInvalidDraft());

    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/invalid.md",
      write: true,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("hold publish failed");
    const data = result.result.data as {
      held: boolean;
      hold_reasons: string[];
      review_event_id?: string;
    };
    expect(data.held).toBe(true);
    expect(data.hold_reasons).toContain("schema-invalid");
    expect(typeof data.review_event_id).toBe("string");
    expect(data.review_event_id).toMatch(/^[0-9a-f]{64}$/);

    // Assert NO vault write occurred
    expect(existsSync(join(vault, "queries", "invalid.md"))).toBe(false);

    // Assert review event written with status open
    const logEvents = await readLogEvents(vault);
    expect(logEvents.ok).toBe(true);
    if (!logEvents.ok) throw new Error("readLogEvents failed");
    const reviewEvent = logEvents.data.find((e) => e.operation_id === data.review_event_id);
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent?.kind).toBe("source-review");
    expect(reviewEvent?.metadata.status).toBe("open");

    // Assert held page appears in existing review listing
    const reviews = await runSourceReviews({ vault });
    expect(reviews.exitCode).toBe(0);
    expect(reviews.result.ok).toBe(true);
    if (!reviews.result.ok) throw new Error("listing failed");
    const listing = reviews.result.data as { items: Array<{ raw_path: string; status: string; typed_paths?: string[] }> };
    expect(listing.items.some((i) => i.raw_path === "queries/invalid.md" && i.status === "open")).toBe(true);
  });

  it("gate 2: broken-wikilink draft holds on publish --write", async () => {
    const vault = makeVault();
    const draft = writeDraftFile(brokenWikilinkDraft());

    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/broken-link.md",
      write: true,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("hold publish failed");
    const data = result.result.data as { held: boolean; hold_reasons: string[]; review_event_id?: string };
    expect(data.held).toBe(true);
    expect(data.hold_reasons).toContain("broken-wikilink");
    expect(existsSync(join(vault, "queries", "broken-link.md"))).toBe(false);

    const reviews = await runSourceReviews({ vault });
    expect(reviews.result.ok).toBe(true);
    if (!reviews.result.ok) throw new Error("listing failed");
    const listing = reviews.result.data as { items: Array<{ raw_path: string; status: string }> };
    expect(listing.items.some((i) => i.raw_path === "queries/broken-link.md" && i.status === "open")).toBe(true);
  });

  it("gate 3: citation-marker-missing draft holds when sources declared but body has no ^[ markers", async () => {
    const vault = makeVault();
    const draft = writeDraftFile(citationMarkerMissingDraft());

    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/missing-citation.md",
      write: true,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("hold publish failed");
    const data = result.result.data as { held: boolean; hold_reasons: string[]; review_event_id?: string };
    expect(data.held).toBe(true);
    expect(data.hold_reasons).toContain("citation-marker-missing");
    expect(existsSync(join(vault, "queries", "missing-citation.md"))).toBe(false);

    const reviews = await runSourceReviews({ vault });
    expect(reviews.result.ok).toBe(true);
    if (!reviews.result.ok) throw new Error("listing failed");
    const listing = reviews.result.data as { items: Array<{ raw_path: string; status: string }> };
    expect(listing.items.some((i) => i.raw_path === "queries/missing-citation.md" && i.status === "open")).toBe(true);
  });

  it("gate 4: sensitive-content in draft body holds on publish --write", async () => {
    const vault = makeVault();
    const draft = writeDraftFile(sensitiveContentDraft());

    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/sensitive.md",
      write: true,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("hold publish failed");
    const data = result.result.data as { held: boolean; hold_reasons: string[]; review_event_id?: string };
    expect(data.held).toBe(true);
    expect(data.hold_reasons).toContain("sensitive-content");
    expect(existsSync(join(vault, "queries", "sensitive.md"))).toBe(false);

    const reviews = await runSourceReviews({ vault });
    expect(reviews.result.ok).toBe(true);
    if (!reviews.result.ok) throw new Error("listing failed");
    const listing = reviews.result.data as { items: Array<{ raw_path: string; status: string }> };
    expect(listing.items.some((i) => i.raw_path === "queries/sensitive.md" && i.status === "open")).toBe(true);
  });

  it("dry-run reports held: true + reasons as would-hold preview without writing anything or review events", async () => {
    const vault = makeVault();
    const draft = writeDraftFile(brokenWikilinkDraft());

    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/broken-link.md",
      write: false,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("dry-run failed");
    const data = result.result.data as {
      held: boolean;
      hold_reasons: string[];
      review_event_id?: string;
      approval_token?: string;
    };
    expect(data.held).toBe(true);
    expect(data.hold_reasons).toContain("broken-wikilink");
    expect(data.review_event_id).toBeUndefined();
    expect(typeof data.approval_token).toBe("string");

    // Assert NO files or events written
    expect(existsSync(join(vault, "queries", "broken-link.md"))).toBe(false);
    const logEvents = await readLogEvents(vault);
    expect(logEvents.ok).toBe(true);
    if (!logEvents.ok) throw new Error("readLogEvents failed");
    expect(logEvents.data).toEqual([]);
  });

  it("project-page publish also inherits hold gates", async () => {
    const vault = makeVault();
    const draftContent = `---
title: Example Architecture ADR
aliases: []
created: 2026-08-18
updated: 2026-08-18
type: concept
tags: [adr]
sources: [projects/llm-wiki/work/example/spec.md]
confidence: medium
provenance: project
provenance_projects: ["[[llm-wiki]]"]
---

# Example Architecture ADR

Body referencing [[broken-project-link]] ^[raw/articles/source.md].

## Sources

- ^[raw/articles/source.md]
`;
    const draft = writeDraftFile(draftContent);

    // Dry run
    const preview = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/example.md",
      write: false,
    });
    expect(preview.exitCode).toBe(ExitCode.OK);
    expect(preview.result.ok).toBe(true);
    if (!preview.result.ok) throw new Error("preview failed");
    const previewData = preview.result.data as { held: boolean; hold_reasons: string[]; approval_token?: string };
    expect(previewData.held).toBe(true);
    expect(previewData.hold_reasons).toContain("broken-wikilink");
    const token = previewData.approval_token!;

    // Write with approval
    const written = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/example.md",
      write: true,
      approve: token,
    });
    expect(written.exitCode).toBe(ExitCode.OK);
    expect(written.result.ok).toBe(true);
    if (!written.result.ok) throw new Error("write failed");
    const writtenData = written.result.data as { held: boolean; hold_reasons: string[]; review_event_id?: string };
    expect(writtenData.held).toBe(true);
    expect(writtenData.hold_reasons).toContain("broken-wikilink");
    expect(typeof writtenData.review_event_id).toBe("string");
    expect(existsSync(join(vault, "projects", "llm-wiki", "architecture", "example.md"))).toBe(false);

    // Surfaced in review listing
    const reviews = await runSourceReviews({ vault });
    expect(reviews.result.ok).toBe(true);
    if (!reviews.result.ok) throw new Error("listing failed");
    const listing = reviews.result.data as { items: Array<{ raw_path: string; status: string }> };
    expect(listing.items.some((i) => i.raw_path === "projects/llm-wiki/architecture/example.md" && i.status === "open")).toBe(true);
  });
});
