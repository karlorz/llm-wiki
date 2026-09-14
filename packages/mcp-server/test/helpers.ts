import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { PutObject } from "../src/txn.js";
import type { GetObject } from "../src/versions.js";

export function makeS3Store(initial: Record<string, string> = {}) {
  const store = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, Buffer.from(v, "utf8"));
  }
  const getObject: GetObject = async (relPath: string) => {
    const found = store.get(relPath);
    if (!found) return null;
    return {
      sha256: createHash("sha256").update(found).digest("hex"),
      body: found,
    };
  };
  const putObject: PutObject = async (relPath: string, body: Buffer) => {
    store.set(relPath, body);
  };
  return { store, getObject, putObject };
}

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
