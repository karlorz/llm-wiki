import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

export async function makeTempVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skillwiki-mcp-vault-"));
  await writeFile(join(root, "SCHEMA.md"), "# Schema\n", "utf8");
  await writeFile(join(root, "index.md"), "# Index\n", "utf8");
  await writeFile(
    join(root, "log.md"),
    "# Vault Log\n\nChronological action log. Newest entries last.\n\n## [2026-01-01] create | Wiki initialized\n",
    "utf8",
  );
  await mkdir(join(root, "raw", "transcripts"), { recursive: true });
  await mkdir(join(root, "concepts"), { recursive: true });
  await writeFile(
    join(root, "concepts", "alpha.md"),
    `---
title: Alpha
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: []
sources: [raw/transcripts/seed.md]
---
Alpha concept body.
`,
    "utf8",
  );
  return root;
}
