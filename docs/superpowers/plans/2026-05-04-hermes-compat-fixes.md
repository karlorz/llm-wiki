# Hermes Compatibility Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 7 bugs/gaps in skillwiki CLI so that `skillwiki init --force` on an existing hermes-format vault produces zero lint errors without manual editing.

**Architecture:** All changes are targeted fixes in existing files — no new commands, no architecture changes. `init.ts` gets `--no-env` flag, content-preservation guards, SCHEMA migration, and taxonomy auto-discovery. `taxonomy.ts` changes silent empty-return to an error. `links.ts` and `index-check.ts` get case-insensitive matching. `cli.ts` wires the new `--no-env` flag.

**Tech Stack:** TypeScript (Node ≥20, ESM), Commander 12, Zod 3, js-yaml 4, Vitest 2.

**Spec:** `docs/superpowers/specs/2026-05-04-hermes-compat-fixes-design.md`

---

## Phase 0 — Conventions for every task

- After every code change, run `npm run -w packages/cli typecheck` before committing.
- Run `npm run -w packages/cli test` at the end of each task and confirm green.
- Commit at the end of every task with Conventional Commits.
- All `runInit` changes maintain the existing `Result<T>` envelope and exit codes.

---

## Task 1: Fix 4 — extractTaxonomy returns error on missing block

**Files:**
- Modify: `packages/cli/src/parsers/taxonomy.ts:8`
- Modify: `packages/cli/test/parsers/taxonomy.test.ts`

- [ ] **Step 1: Update the existing test**

Open `packages/cli/test/parsers/taxonomy.test.ts` and change the test at line 40:

```typescript
  it("returns NO_TAXONOMY_BLOCK error when the block is absent", () => {
    const r = extractTaxonomy(MISSING);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("NO_TAXONOMY_BLOCK");
  });
```

- [ ] **Step 2: Run the failing test**

Run: `npm run -w packages/cli test -- --testPathPattern taxonomy`
Expected: FAIL — existing test expects `ok([])` but now gets `err`.

- [ ] **Step 3: Fix taxonomy.ts**

In `packages/cli/src/parsers/taxonomy.ts`, change line 8:

```typescript
  if (!m) return err("NO_TAXONOMY_BLOCK", { message: "No fenced YAML taxonomy block found in SCHEMA.md" });
```

- [ ] **Step 4: Run tests**

Run: `npm run -w packages/cli test -- --testPathPattern taxonomy`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run -w packages/cli typecheck
npm run -w packages/cli test -- --testPathPattern taxonomy
git add packages/cli/src/parsers/taxonomy.ts packages/cli/test/parsers/taxonomy.test.ts
git commit -m "fix: extractTaxonomy returns NO_TAXONOMY_BLOCK error instead of silent empty array"
```

---

## Task 2: Fix 5 — Case-insensitive wikilink matching in links.ts

**Files:**
- Modify: `packages/cli/src/commands/links.ts:15-28`
- Modify: `packages/cli/test/commands/links.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/commands/links.test.ts`:

```typescript
  it("matches wikilinks case-insensitively", async () => {
    // Create a page named "c929.md" and a page that links to [[C929]]
    const dir = mkdtempSync(join(tmpdir(), "links-ci-"));
    mkdirSync(join(dir, "entities"), { recursive: true });
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n## Tag Taxonomy\n```yaml\ntaxonomy: []\n```\n");
    writeFileSync(join(dir, "entities", "c929.md"), `---\ntitle: C929\ncreated: 2026-01-01\nupdated: 2026-01-01\ntype: entity\ntags: []\nsources: []\n---\n\n# C929\n`);
    writeFileSync(join(dir, "concepts", "aviation.md"), `---\ntitle: Aviation\ncreated: 2026-01-01\nupdated: 2026-01-01\ntype: concept\ntags: []\nsources: []\n---\n\nSee [[C929]] for details.\n`);
    const r = await runLinks({ vault: dir });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) expect(r.result.data.broken).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the failing test**

Run: `npm run -w packages/cli test -- --testPathPattern links`
Expected: FAIL — [[C929]] doesn't match c929.md (case-sensitive).

- [ ] **Step 3: Fix links.ts**

In `packages/cli/src/commands/links.ts`, replace lines 15-28:

```typescript
  const slugs = new Map<string, string>(); // lowercase -> actual slug
  for (const p of scan.data.typedKnowledge) {
    const slug = p.relPath.replace(/\.md$/, "").split("/").pop()!;
    slugs.set(slug.toLowerCase(), slug);
  }

  const broken: LinksOutput["broken"] = [];
  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const lines = body.split("\n");
    for (const slug of extractBodyWikilinks(body)) {
      const tail = slug.split("/").pop()!;
      if (!slugs.has(tail.toLowerCase())) {
```

- [ ] **Step 4: Run tests**

Run: `npm run -w packages/cli test -- --testPathPattern links`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run -w packages/cli typecheck
npm run -w packages/cli test -- --testPathPattern links
git add packages/cli/src/commands/links.ts packages/cli/test/commands/links.test.ts
git commit -m "fix(links): case-insensitive wikilink matching"
```

---

## Task 3: Fix 5 (cont.) — Case-insensitive wikilink matching in index-check.ts

**Files:**
- Modify: `packages/cli/src/commands/index-check.ts:20,28-33`
- Modify: `packages/cli/test/commands/index-check.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/commands/index-check.test.ts`:

```typescript
  it("matches index entries case-insensitively", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ic-ci-"));
    mkdirSync(join(dir, "entities"), { recursive: true });
    writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(dir, "entities", "c929.md"), `---\ntitle: C929\ncreated: 2026-01-01\nupdated: 2026-01-01\ntype: entity\ntags: []\nsources: []\n---\n\n# C929\n`);
    // Index uses uppercase [[C929]]
    writeFileSync(join(dir, "index.md"), "# Index\n\n- [[C929]] — widebody\n");
    const r = await runIndexCheck({ vault: dir });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.missing_from_index).toHaveLength(0);
      expect(r.result.data.ghost_entries).toHaveLength(0);
    }
  });
```

- [ ] **Step 2: Run the failing test**

Run: `npm run -w packages/cli test -- --testPathPattern index-check`
Expected: FAIL — [[C929]] in index doesn't match c929.md file slug.

- [ ] **Step 3: Fix index-check.ts**

In `packages/cli/src/commands/index-check.ts`, replace lines 20-33:

```typescript
  const indexSlugsLower = new Map<string, string>(); // lowercase -> original
  for (const s of extractBodyWikilinks(indexText)) {
    const tail = s.split("/").pop()!;
    indexSlugsLower.set(tail.toLowerCase(), tail);
  }
  const fileSlugs = new Map<string, string>(); // slug -> relPath
  for (const p of scan.data.typedKnowledge) {
    const slug = p.relPath.replace(/\.md$/, "").split("/").pop()!;
    fileSlugs.set(slug, p.relPath);
  }

  const missing_from_index: string[] = [];
  for (const [slug, relPath] of fileSlugs.entries()) {
    if (!indexSlugsLower.has(slug.toLowerCase())) missing_from_index.push(relPath);
  }
  const ghost_entries: string[] = [];
  for (const [lower, orig] of indexSlugsLower) {
    let found = false;
    for (const [fileSlug] of fileSlugs) {
      if (fileSlug.toLowerCase() === lower) { found = true; break; }
    }
    if (!found) ghost_entries.push(orig);
  }
```

- [ ] **Step 4: Run tests**

Run: `npm run -w packages/cli test -- --testPathPattern index-check`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run -w packages/cli typecheck
npm run -w packages/cli test -- --testPathPattern index-check
git add packages/cli/src/commands/index-check.ts packages/cli/test/commands/index-check.test.ts
git commit -m "fix(index-check): case-insensitive wikilink matching"
```

---

## Task 4: Fix 6 — Env safety guard (--no-env flag + tmp path skip)

**Files:**
- Modify: `packages/cli/src/commands/init.ts:18-27,120-126,129-141`
- Modify: `packages/cli/src/cli.ts:105-126`
- Modify: `packages/cli/test/commands/init.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/commands/init.test.ts`:

```typescript
  it("--no-env skips env file write", async () => {
    const h = home();
    const target = tmp();
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.env_written).toBe("");
      expect(r.result.data.env_skipped).toBe(true);
    }
    // env file should NOT exist
    expect(() => statSync(join(h, ".skillwiki", ".env"))).toThrow();
  });

  it("skips env write when target is under /tmp", async () => {
    const h = home();
    const target = "/tmp/skillwiki-test-" + Date.now();
    mkdirSync(target, { recursive: true });
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false, noEnv: false
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.env_written).toBe("");
      expect(r.result.data.env_skipped).toBe(true);
    }
  });
```

- [ ] **Step 2: Run the failing tests**

Run: `npm run -w packages/cli test -- --testPathPattern init`
Expected: FAIL — `noEnv` field doesn't exist on InitInput, existing tests fail due to missing field.

- [ ] **Step 3: Update InitInput and InitOutput interfaces**

In `packages/cli/src/commands/init.ts`, update `InitInput` (line 18):

```typescript
export interface InitInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  templates: string;
  domain: string;
  taxonomy: string[] | undefined;
  lang: string | undefined;
  force: boolean;
  noEnv?: boolean;
}
```

Update `InitOutput` (line 29):

```typescript
export interface InitOutput {
  vault: string;
  domain: string;
  taxonomy: string[];
  lang: string;
  created: string[];
  env_written: string;
  env_skipped: boolean;
  imported_from_hermes: boolean;
}
```

- [ ] **Step 4: Add skip logic and update env write block**

Replace the env write block (lines 120-126) with:

```typescript
  const isTempPath = target.startsWith("/tmp") || target.startsWith("/var") || target.startsWith("/private");
  const skipEnv = !!input.noEnv || isTempPath;
  let envWritten = "";
  if (!skipEnv) {
    try {
      await mkdir(dirname(envPath), { recursive: true });
      await writeDotenv(envPath, { WIKI_PATH: target, WIKI_LANG: canonicalLang }, existingEnvRaw);
      envWritten = envPath;
    } catch (e) {
      return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: envPath, message: String(e) }) };
    }
  }
```

Also add the `writeDotenv` import and read `existingEnvRaw` alongside the existing `parseDotenvFile` call (near line 55):

```typescript
import { parseDotenvFile, writeDotenv } from "../utils/dotenv.js";
```

At line 55, also read the raw content:

```typescript
  const envPath = join(input.home, ".skillwiki", ".env");
  let existingEnvRaw: string | undefined;
  try { existingEnvRaw = await readFile(envPath, "utf8"); } catch { /* new file */ }
  const existingEnv = await parseDotenvFile(envPath);
```

- [ ] **Step 5: Update the return object**

Replace the return block (lines 130-141) with:

```typescript
  return {
    exitCode: ExitCode.OK,
    result: ok({
      vault: target,
      domain: input.domain,
      taxonomy,
      lang: canonicalLang,
      created,
      env_written: envWritten,
      env_skipped: skipEnv,
      imported_from_hermes: importedFromHermes
    })
  };
```

- [ ] **Step 6: Update cli.ts to wire --no-env**

In `packages/cli/src/cli.ts`, add `.option("--no-env", "skip writing ~/.skillwiki/.env")` after line 110, and pass it through in the action (line 116):

```typescript
    emit(await runInit({
      flag: opts.target,
      envValue: process.env.WIKI_PATH,
      home: process.env.HOME ?? "",
      templates,
      domain: opts.domain,
      taxonomy,
      lang: opts.lang,
      force: !!opts.force,
      noEnv: !!opts.noEnv
    }));
```

- [ ] **Step 7: Update ALL existing tests to include `noEnv`**

In all existing `runInit(` calls in `packages/cli/test/commands/init.test.ts`, add `noEnv: false` to the input object. This is needed because the new flag defaults to `false` in the interface (`noEnv?: boolean`), so existing tests without it should still work since it's optional — BUT the env_skipped field on output is new, so existing assertions on `env_written` need updating: change `expect(r.result.data.env_written).toBe(...)` to use a truthy check: `expect(r.result.data.env_written).toBeTruthy()`.

- [ ] **Step 8: Run all tests**

Run: `npm run -w packages/cli test`
Expected: ALL PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run -w packages/cli typecheck
npm run -w packages/cli test
git add packages/cli/src/commands/init.ts packages/cli/src/cli.ts packages/cli/test/commands/init.test.ts
git commit -m "feat(init): --no-env flag and /tmp path safety guard"
```

---

## Task 5: Fix 1 — init uses writeDotenv() helper

**Files:**
- Modify: `packages/cli/src/commands/init.ts` (already done in Task 4 — the writeDotenv change is bundled)

This fix is already incorporated in Task 4 Step 4 where `writeDotenv()` replaces the bare `writeFileSync` call. No additional work needed.

Mark as done if Task 4 committed successfully.

---

## Task 6: Fix 2 — init --force preserves existing index.md and log.md

**Files:**
- Modify: `packages/cli/src/commands/init.ts:99-118,29-37`
- Modify: `packages/cli/test/commands/init.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/commands/init.test.ts`:

```typescript
  it("--force preserves existing index.md when it has >10 lines", async () => {
    const h = home();
    const target = tmp();
    const bigIndex = Array.from({ length: 25 }, (_, i) => `- [[page-${i}]] — page ${i}`).join("\n");
    writeFileSync(join(target, "SCHEMA.md"), "# Old\n");
    writeFileSync(join(target, "index.md"), "# Index\n\n" + bigIndex + "\n");
    writeFileSync(join(target, "log.md"), "# Log\n" + "## [2026-01-01] test\n".repeat(15));
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.preserved).toContain("index.md");
    if (r.result.ok) expect(r.result.data.preserved).toContain("log.md");
    // Verify content NOT overwritten
    const idx = readFileSync(join(target, "index.md"), "utf8");
    expect(idx).toContain("page-0");
    expect(idx).not.toContain("Total pages: 0");
  });

  it("--force overwrites empty index.md and log.md", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), "# Old\n");
    writeFileSync(join(target, "index.md"), "");
    writeFileSync(join(target, "log.md"), "");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.preserved).not.toContain("index.md");
    if (r.result.ok) expect(r.result.data.preserved).not.toContain("log.md");
    const idx = readFileSync(join(target, "index.md"), "utf8");
    expect(idx).toContain("Total pages: 0");
  });
```

- [ ] **Step 2: Run the failing tests**

Run: `npm run -w packages/cli test -- --testPathPattern init`
Expected: FAIL — `preserved` field doesn't exist on InitOutput, index.md overwritten.

- [ ] **Step 3: Add `preserved` to InitOutput**

In `packages/cli/src/commands/init.ts`, update `InitOutput`:

```typescript
export interface InitOutput {
  vault: string;
  domain: string;
  taxonomy: string[];
  lang: string;
  created: string[];
  preserved: string[];
  env_written: string;
  env_skipped: boolean;
  imported_from_hermes: boolean;
}
```

- [ ] **Step 4: Add preservation logic for index.md and log.md**

Replace the index.md write block (lines 99-106) with:

```typescript
  const preserved: string[] = [];
  const CONTENT_THRESHOLD = 10;

  // Index
  let skipIndex = false;
  try {
    const existingIdx = await readFile(join(target, "index.md"), "utf8");
    if (existingIdx.split("\n").length > CONTENT_THRESHOLD) {
      skipIndex = true;
      preserved.push("index.md");
    }
  } catch { /* no existing index */ }
  if (!skipIndex) {
    try {
      const idxTpl = await readFile(join(input.templates, "index.md"), "utf8");
      const idx = idxTpl.replace("{{INIT_DATE}}", today);
      await writeFile(join(target, "index.md"), idx, "utf8");
      created.push("index.md");
    } catch (e) {
      return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "index.md", message: String(e) }) };
    }
  }
```

Replace the log.md write block (lines 108-118) with:

```typescript
  // Log
  let skipLog = false;
  try {
    const existingLog = await readFile(join(target, "log.md"), "utf8");
    if (existingLog.split("\n").length > CONTENT_THRESHOLD) {
      skipLog = true;
      preserved.push("log.md");
    }
  } catch { /* no existing log */ }
  if (!skipLog) {
    try {
      const logTpl = await readFile(join(input.templates, "log.md"), "utf8");
      const log = logTpl
        .replace(/\{\{INIT_DATE\}\}/g, today)
        .replace("{{DOMAIN}}", input.domain)
        .replace("{{WIKI_LANG}}", canonicalLang);
      await writeFile(join(target, "log.md"), log, "utf8");
      created.push("log.md");
    } catch (e) {
      return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "log.md", message: String(e) }) };
    }
  }
```

- [ ] **Step 5: Add `preserved` to the return object**

In the return block, add `preserved`:

```typescript
      preserved,
```

- [ ] **Step 6: Run all tests**

Run: `npm run -w packages/cli test`
Expected: ALL PASS (existing tests create empty vaults, so index.md/log.md < 10 lines → still overwritten).

- [ ] **Step 7: Typecheck and commit**

```bash
npm run -w packages/cli typecheck
npm run -w packages/cli test
git add packages/cli/src/commands/init.ts packages/cli/test/commands/init.test.ts
git commit -m "fix(init): --force preserves existing index.md and log.md (>10 lines)"
```

---

## Task 7: Fix 3 — SCHEMA.md migration on --force + Fix 7 — Taxonomy auto-discovery

**Files:**
- Modify: `packages/cli/src/commands/init.ts:83-97`
- Modify: `packages/cli/test/commands/init.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/commands/init.test.ts`:

```typescript
  it("--force migrates existing hermes SCHEMA.md (domain preserved, taxonomy merged)", async () => {
    const h = home();
    const target = tmp();
    // Old hermes-format SCHEMA.md with no fenced YAML block
    writeFileSync(join(target, "SCHEMA.md"), `# Wiki Schema

## Domain
Finance and markets knowledge base — HK/Asia, US, commodities.

## Conventions
- File names: lowercase, hyphens, no spaces
- Use [[wikilinks]] for cross-references

## Tag Taxonomy
- markets, macro, central-bank, earnings, commodity, crypto, forex
`);
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "", taxonomy: undefined, lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    // Domain should be preserved from old SCHEMA.md since --domain was empty
    expect(schema).toContain("Finance and markets");
    // Should have new skillwiki format markers
    expect(schema).toContain("## Output Language");
    expect(schema).toContain("## Layers");
  });

  it("--force discovers taxonomy from existing page tags", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), `# Vault Schema\n\n## Domain\nTest\n`);
    mkdirSync(join(target, "concepts"), { recursive: true });
    mkdirSync(join(target, "entities"), { recursive: true });
    mkdirSync(join(target, "raw"), { recursive: true });
    writeFileSync(join(target, "concepts", "oil.md"),
      `---\ntitle: Oil\ncreated: 2026-01-01\nupdated: 2026-01-01\ntype: concept\ntags: [oil, energy, commodity]\nsources: []\n---\n\n# Oil\n`);
    writeFileSync(join(target, "entities", "fed.md"),
      `---\ntitle: Fed\ncreated: 2026-01-01\nupdated: 2026-01-01\ntype: entity\ntags: [central-bank, fed, usd]\nsources: []\n---\n\n# Fed\n`);
    // User provides a minimal taxonomy via --taxonomy
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Test", taxonomy: ["oil", "commodity"], lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.discovered_tags).toBeGreaterThan(0);
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    // Discovered tags should be in the schema
    expect(schema).toContain("- energy");
    expect(schema).toContain("- central-bank");
    expect(schema).toContain("- fed");
    expect(schema).toContain("- usd");
    // Should have the discovered section marker
    expect(schema).toContain("Discovered from existing pages");
    // Original taxonomy tags should still be present
    expect(schema).toContain("- oil");
    expect(schema).toContain("- commodity");
  });

  it("--domain flag overrides old domain when both provided", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), `# Vault Schema\n\n## Domain\nOld domain text\n`);
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "New domain override", taxonomy: undefined, lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("New domain override");
    expect(schema).not.toContain("Old domain text");
  });
```

- [ ] **Step 2: Run the failing tests**

Run: `npm run -w packages/cli test -- --testPathPattern init`
Expected: FAIL — no domain migration, no auto-discovery, `discovered_tags` field missing.

- [ ] **Step 3: Add `discovered_tags` to InitOutput**

In `packages/cli/src/commands/init.ts`, update `InitOutput`:

```typescript
export interface InitOutput {
  vault: string;
  domain: string;
  taxonomy: string[];
  lang: string;
  created: string[];
  preserved: string[];
  env_written: string;
  env_skipped: boolean;
  imported_from_hermes: boolean;
  discovered_tags: number;
}
```

- [ ] **Step 4: Add helpers for SCHEMA migration**

Add these imports at the top of `init.ts` (after existing imports):

```typescript
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { readPage } from "../utils/vault.js";
```

Add a helper function to extract domain from old SCHEMA.md (before `runInit`):

```typescript
function extractDomainFromSchema(text: string): string {
  const m = text.match(/^##\s+Domain\s*\n+([\s\S]*?)(?=\n##\s|\n$)/m);
  return m ? m[1].trim() : "";
}
```

Add a helper to discover tags from existing pages:

```typescript
async function discoverTagsFromPages(target: string, knownSlugs: string[]): Promise<string[]> {
  const knownSet = new Set(knownSlugs);
  const discovered = new Set<string>();
  for (const dir of ["entities", "concepts", "comparisons", "queries"]) {
    let entries: string[];
    try { entries = (await readdir(join(target, dir), { withFileTypes: true }))
      .filter(e => e.isFile() && e.name.endsWith(".md"))
      .map(e => e.name); } catch { continue; }
    for (const file of entries) {
      try {
        const text = await readFile(join(target, dir, file), "utf8");
        const fm = extractFrontmatter(text);
        if (!fm.ok || !fm.data.tags || !Array.isArray(fm.data.tags)) continue;
        for (const t of fm.data.tags) {
          if (typeof t === "string" && !knownSet.has(t)) discovered.add(t);
        }
      } catch { /* skip unreadable files */ }
    }
  }
  return [...discovered].sort();
}
```

Add `readdir` to the fs import:

```typescript
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
```

- [ ] **Step 5: Replace the SCHEMA.md render block with migration-aware logic**

Replace lines 83-97 of `init.ts` with:

```typescript
  const today = new Date().toISOString().slice(0, 10);
  let taxonomy = input.taxonomy && input.taxonomy.length > 0 ? input.taxonomy : DEFAULT_TAXONOMY;
  let domain = input.domain;

  // Fix 3: SCHEMA.md migration — read old domain and taxonomy from existing SCHEMA.md
  let oldTaxonomy: string[] = [];
  if (hasSchema) {
    try {
      const oldSchema = await readFile(join(target, "SCHEMA.md"), "utf8");
      if (!domain) {
        const oldDomain = extractDomainFromSchema(oldSchema);
        if (oldDomain) domain = oldDomain;
      }
      const oldTax = extractTaxonomy(oldSchema);
      if (oldTax.ok) oldTaxonomy = oldTax.data;
    } catch { /* ignore read errors */ }
  }

  // Merge old taxonomy into new
  const taxonomySet = new Set(taxonomy);
  for (const t of oldTaxonomy) {
    if (!taxonomySet.has(t)) { taxonomy.push(t); taxonomySet.add(t); }
  }

  // Fix 7: Taxonomy auto-discovery from existing pages
  const discovered = await discoverTagsFromPages(target, taxonomy);
  const taxonomyWithDiscovered = [...taxonomy, ...discovered];

  const taxonomyYaml = taxonomyWithDiscovered.map(t => `  - ${t}`).join("\n");
  // Insert discovered marker if there are discovered tags
  const fullTaxonomyYaml = discovered.length > 0
    ? taxonomyWithDiscovered.map(t =>
        discovered.includes(t) && taxonomyWithDiscovered.indexOf(t) === taxonomy.length
          ? `  # --- Discovered from existing pages ---\n  - ${t}`
          : `  - ${t}`
      ).join("\n")
    : taxonomyYaml;

  const discovered_tags = discovered.length;

  try {
    const schemaTpl = await readFile(join(input.templates, "SCHEMA.md"), "utf8");
    const schema = schemaTpl
      .replace("{{DOMAIN}}", domain)
      .replace("{{WIKI_LANG}}", canonicalLang)
      .replace("{{TAXONOMY_YAML}}", fullTaxonomyYaml);
    await writeFile(join(target, "SCHEMA.md"), schema, "utf8");
    created.push("SCHEMA.md");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "SCHEMA.md", message: String(e) }) };
  }
```

- [ ] **Step 6: Fix the discovered marker insertion**

The naive `indexOf` approach above won't work correctly. Replace the `fullTaxonomyYaml` computation with:

```typescript
  const fullTaxonomyYaml = discovered.length > 0
    ? taxonomy.map(t => `  - ${t}`).join("\n")
      + "\n  # --- Discovered from existing pages ---\n"
      + discovered.map(t => `  - ${t}`).join("\n")
    : taxonomy.map(t => `  - ${t}`).join("\n");
```

Remove the old `taxonomyYaml` assignment and the intermediate `taxonomyWithDiscovered`.

- [ ] **Step 7: Update the return object**

In the return block, add `discovered_tags` and update `domain`:

```typescript
      domain,
```

Add to the return object:

```typescript
      discovered_tags,
```

- [ ] **Step 8: Run all tests**

Run: `npm run -w packages/cli test`
Expected: ALL PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run -w packages/cli typecheck
npm run -w packages/cli test
git add packages/cli/src/commands/init.ts packages/cli/test/commands/init.test.ts
git commit -m "feat(init): SCHEMA.md migration and taxonomy auto-discovery on --force"
```

---

## Task 8: Full integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm run -w packages/cli test`
Run: `npm run -w packages/shared test`
Expected: ALL PASS.

- [ ] **Step 2: Typecheck both packages**

Run: `npm run -w packages/cli typecheck`
Run: `npm run -w packages/shared typecheck`
Expected: 0 errors.

- [ ] **Step 3: Build**

Run: `npm run -w packages/cli build`
Expected: success.

- [ ] **Step 4: E2E smoke test against sg01 wiki**

Deploy to sg01 and run:

```bash
skillwiki init --force --domain "" --no-env
skillwiki lint --human
```

Expected: `skillwiki init` preserves index.md and log.md, migrates SCHEMA.md, auto-discovers ~20 missing tags. `skillwiki lint` shows 0 errors, 2 warnings (oversized pages).

---

## Phase Map

| Task | Fixes | Dependencies |
|------|-------|-------------|
| 1 | #4 taxonomy error | none |
| 2 | #5 case-insensitive links | none |
| 3 | #5 case-insensitive index-check | none |
| 4 | #6 env safety + --no-env | none |
| 5 | #1 writeDotenv | done in Task 4 |
| 6 | #2 content preservation | Task 4 |
| 7 | #3 SCHEMA migration + #7 auto-discovery | Task 6 |
| 8 | verification | all |
