import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { isoDate } from "@skillwiki/shared";
import { appendLastOp } from "../utils/last-op.js";

export interface SeedInput {
  vault: string;
}

export interface SeedOutput {
  created: string[];
  skipped: string[];
  humanHint: string;
}

const TODAY = new Date().toISOString().slice(0, 10);

const EXAMPLE_PAGES: Record<string, string> = {
  "entities/example-project.md": `---
title: Example Project
aliases: [example-project]
created: ${TODAY}
updated: ${TODAY}
type: entity
tags: [research]
sources: []
confidence: medium
provenance: research
---

# Example Project

## Overview

This is a seed entity page demonstrating the typed-knowledge format. Replace it with a real entity from your research.

## Key Facts

- This vault was seeded on ${TODAY}
- Entity pages describe people, organizations, products, or projects
- Each page should cite sources from the \`raw/\` directory
`,
  "concepts/example-concept.md": `---
title: Example Concept
aliases: [example-concept]
created: ${TODAY}
updated: ${TODAY}
type: concept
tags: [concept]
sources: []
confidence: medium
provenance: research
---

# Example Concept

## Overview

This is a seed concept page. Concept pages capture topics, patterns, and ideas that span multiple sources.

## Related

- [[example-project]]

## Sources

(Add source citations here after ingesting raw material with \`wiki-ingest\`)
`,
};

const EXAMPLE_RAW = `---
source_url: https://example.com
ingested: ${TODAY}
sha256: 0000000000000000000000000000000000000000000000000000000000000000
---

# Example Source Article

This is a placeholder raw source. Replace it with real content ingested via \`skillwiki hash\` and the wiki-ingest skill.

Real sources are immutable after ingestion — never edit them.
`;

export async function runSeed(input: SeedInput): Promise<{ exitCode: number; result: Result<SeedOutput> }> {
  // Verify vault exists (must have SCHEMA.md)
  try {
    await stat(join(input.vault, "SCHEMA.md"));
  } catch {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { root: input.vault, reason: "SCHEMA.md missing — run `skillwiki init` first" }) };
  }

  const created: string[] = [];
  const skipped: string[] = [];

  // Create example typed-knowledge pages
  for (const [relPath, content] of Object.entries(EXAMPLE_PAGES)) {
    const absPath = join(input.vault, relPath);
    try {
      await stat(absPath);
      skipped.push(relPath);
    } catch {
      await mkdir(join(absPath, ".."), { recursive: true });
      await writeFile(absPath, content, "utf8");
      created.push(relPath);
    }
  }

  // Create example raw source
  const rawPath = join(input.vault, "raw", "articles", "example-source.md");
  try {
    await stat(rawPath);
    skipped.push("raw/articles/example-source.md");
  } catch {
    await mkdir(join(rawPath, ".."), { recursive: true });
    await writeFile(rawPath, EXAMPLE_RAW, "utf8");
    created.push("raw/articles/example-source.md");
  }

  if (created.length > 0) {
    appendLastOp(input.vault, {
      operation: "seed",
      summary: `seeded ${created.length} example pages`,
      files: created,
      timestamp: new Date().toISOString(),
    });
  }

  const hintLines = [`seeded: ${created.length}`, `skipped (already exist): ${skipped.length}`];
  if (created.length > 0) {
    hintLines.push("next steps: ingest real sources with wiki-ingest, then cite them in concept/entity pages");
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({ created, skipped, humanHint: hintLines.join("\n") }),
  };
}
