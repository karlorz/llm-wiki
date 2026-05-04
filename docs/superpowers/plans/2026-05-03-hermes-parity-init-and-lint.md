# Hermes-Parity for `wiki-init` and `wiki-lint` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two parity gaps with Hermes `llm-wiki` v2.1.0 by adding a domain-aware `skillwiki init` (with Hermes-import reconciliation, taxonomy seeding, and `WIKI_LANG` configuration) and seven new lint subcommands (`links`, `tag-audit`, `index-check`, `stale`, `pagesize`, `log-rotate`, plus an umbrella `lint`), while preserving N1–N18 and the v1 exit-code line.

**Architecture:** All deterministic logic lives in the existing `packages/cli/` workspace. New work threads through one shared resolver utility (`utils/wiki-path.ts`); skill prompts call `skillwiki path`/`skillwiki lang` once at orientation and `skillwiki <command>` for the actual work. Templates gain three substitution slots (`{{DOMAIN}}`, `{{TAXONOMY_YAML}}`, `{{WIKI_LANG}}`). New exit codes 15–25 are appended to `packages/shared/src/exit-codes.ts` without reassigning 0–14.

**Tech Stack:** TypeScript (Node ≥20, ESM), Commander 12, Zod 3, js-yaml 4, Vitest 2. Tests live under `packages/cli/test/{commands,utils,parsers}/*.test.ts` (NOT `src/.../__tests__/` as the spec inventory suggests — we follow the established convention).

**Spec:** `docs/superpowers/specs/2026-05-03-hermes-parity-init-and-lint-design.md`

---

## Phase 0 — Conventions for every task

- After every code change, run `npm run -w packages/cli typecheck` (or `npm run -w packages/shared typecheck` for shared changes) before committing. Fix type errors before moving on.
- Run `npm run -w packages/cli test` (and `npm run -w packages/shared test` when shared was touched) at the end of each task and confirm green.
- Commit at the end of every task. Use Conventional Commits (`feat:`, `test:`, `refactor:`, `docs:`, `chore:`).
- Never reassign existing exit codes 0–14. Never modify files under `raw/` (N9). Never add LLM API calls in CLI code (N5).
- All `runX` functions return `{ exitCode: number; result: Result<T> }`. `--human` MUST NOT change exit codes (N2).

---

## Phase 1 — Exit codes (foundation)

### Task 1: Append exit codes 15–25

**Files:**
- Modify: `packages/shared/src/exit-codes.ts`
- Modify: `packages/shared/src/exit-codes.test.ts`

- [ ] **Step 1: Add the new code assertions to the existing test FIRST**

Open `packages/shared/src/exit-codes.test.ts` and add these assertions inside the existing `it("declares every code from the spec Command Contracts table", ...)` block, right after the `ATOMIC_COPY_FAILED` line:

```typescript
    expect(ExitCode.INIT_TARGET_NOT_EMPTY).toBe(15);
    expect(ExitCode.BROKEN_WIKILINKS).toBe(16);
    expect(ExitCode.TAG_NOT_IN_TAXONOMY).toBe(17);
    expect(ExitCode.INDEX_INCOMPLETE).toBe(18);
    expect(ExitCode.STALE_PAGE).toBe(19);
    expect(ExitCode.PAGE_TOO_LARGE).toBe(20);
    expect(ExitCode.LOG_ROTATE_NEEDED).toBe(21);
    expect(ExitCode.LINT_HAS_WARNINGS).toBe(22);
    expect(ExitCode.LINT_HAS_ERRORS).toBe(23);
    expect(ExitCode.ENV_WRITE_CONFLICT).toBe(24);
    expect(ExitCode.NO_VAULT_CONFIGURED).toBe(25);
```

- [ ] **Step 2: Run the failing test**

Run: `npm run -w packages/shared test`
Expected: FAIL — "Property 'INIT_TARGET_NOT_EMPTY' does not exist on type ..." (TS) or assertion failures.

- [ ] **Step 3: Append the new entries to `ExitCode` and `NAMES`**

In `packages/shared/src/exit-codes.ts`, add lines inside the `ExitCode` object (after `ATOMIC_COPY_FAILED: 14`):

```typescript
  INIT_TARGET_NOT_EMPTY: 15,
  BROKEN_WIKILINKS: 16,
  TAG_NOT_IN_TAXONOMY: 17,
  INDEX_INCOMPLETE: 18,
  STALE_PAGE: 19,
  PAGE_TOO_LARGE: 20,
  LOG_ROTATE_NEEDED: 21,
  LINT_HAS_WARNINGS: 22,
  LINT_HAS_ERRORS: 23,
  ENV_WRITE_CONFLICT: 24,
  NO_VAULT_CONFIGURED: 25
```

And add the matching entries inside the `NAMES` map (after `14: "ATOMIC_COPY_FAILED"`):

```typescript
  15: "INIT_TARGET_NOT_EMPTY",
  16: "BROKEN_WIKILINKS",
  17: "TAG_NOT_IN_TAXONOMY",
  18: "INDEX_INCOMPLETE",
  19: "STALE_PAGE",
  20: "PAGE_TOO_LARGE",
  21: "LOG_ROTATE_NEEDED",
  22: "LINT_HAS_WARNINGS",
  23: "LINT_HAS_ERRORS",
  24: "ENV_WRITE_CONFLICT",
  25: "NO_VAULT_CONFIGURED"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run -w packages/shared test`
Expected: PASS, including the existing uniqueness assertion (`new Set(names).size === names.length`).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/exit-codes.ts packages/shared/src/exit-codes.test.ts
git commit -m "feat(shared): add exit codes 15–25 for init and lint subcommands"
```

---

## Phase 2 — Foundation utilities

### Task 2: `utils/dotenv.ts` — minimal dotenv parser

**Files:**
- Create: `packages/cli/src/utils/dotenv.ts`
- Test: `packages/cli/test/utils/dotenv.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/utils/dotenv.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenvFile } from "../../src/utils/dotenv.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "dotenv-")); }

describe("parseDotenvFile", () => {
  it("returns empty map when file is missing", async () => {
    const r = await parseDotenvFile(join(tmp(), "missing.env"));
    expect(r).toEqual({});
  });

  it("parses WIKI_PATH and WIKI_LANG", async () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "WIKI_PATH=/abs/path\nWIKI_LANG=zh-Hant\n");
    expect(await parseDotenvFile(p)).toEqual({ WIKI_PATH: "/abs/path", WIKI_LANG: "zh-Hant" });
  });

  it("ignores blanks and comment lines", async () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "\n# comment\nWIKI_PATH=/x\n\n# another\n");
    expect(await parseDotenvFile(p)).toEqual({ WIKI_PATH: "/x" });
  });

  it("drops keys not in the whitelist", async () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "WIKI_PATH=/x\nFOO=bar\nBAZ=qux\n");
    expect(await parseDotenvFile(p)).toEqual({ WIKI_PATH: "/x" });
  });

  it("does not throw on malformed lines (silently skips)", async () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "no-equals-here\nWIKI_PATH=/x\n=missing-key\n");
    expect(await parseDotenvFile(p)).toEqual({ WIKI_PATH: "/x" });
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/utils/dotenv.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `utils/dotenv.ts`**

Create `packages/cli/src/utils/dotenv.ts`:

```typescript
import { readFile } from "node:fs/promises";

const WHITELIST = new Set(["WIKI_PATH", "WIKI_LANG"]);

export type DotenvMap = Partial<Record<"WIKI_PATH" | "WIKI_LANG", string>>;

export async function parseDotenvFile(path: string): Promise<DotenvMap> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { return {}; }
  const out: DotenvMap = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!WHITELIST.has(key)) continue;
    if (value.length === 0) continue;
    (out as Record<string, string>)[key] = value;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/utils/dotenv.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/utils/dotenv.ts packages/cli/test/utils/dotenv.test.ts
git commit -m "feat(cli): add minimal dotenv parser for WIKI_PATH and WIKI_LANG"
```

---

### Task 3: `utils/lang.ts` — language alias normalization + resolution chain

**Files:**
- Create: `packages/cli/src/utils/lang.ts`
- Test: `packages/cli/test/utils/lang.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/utils/lang.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLang, resolveLang } from "../../src/utils/lang.js";

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, ".skillwiki"), { recursive: true });
  return home;
}

describe("normalizeLang", () => {
  it("returns 'en' for english/en (any case)", () => {
    expect(normalizeLang("english")).toBe("en");
    expect(normalizeLang("EN")).toBe("en");
    expect(normalizeLang("  en  ")).toBe("en");
  });
  it("normalizes Traditional Chinese aliases to zh-Hant", () => {
    for (const a of ["chinese-traditional", "ZH-HANT", "zh-tw", "Chinese-Traditional"]) {
      expect(normalizeLang(a)).toBe("zh-Hant");
    }
  });
  it("normalizes Simplified Chinese aliases to zh-Hans", () => {
    for (const a of ["chinese-simplified", "ZH-HANS", "zh-cn"]) {
      expect(normalizeLang(a)).toBe("zh-Hans");
    }
  });
  it("passes unknown tags through verbatim (trimmed)", () => {
    expect(normalizeLang("  fr-CA  ")).toBe("fr-CA");
  });
});

describe("resolveLang", () => {
  it("flag beats env beats dotenv beats default", async () => {
    const home = tmpHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_LANG=zh-Hant\n");

    expect(await resolveLang({ flag: "ja", envValue: "fr", home })).toEqual({
      value: "ja", source: "flag", canonical: "ja"
    });
    expect(await resolveLang({ flag: undefined, envValue: "fr", home })).toEqual({
      value: "fr", source: "env", canonical: "fr"
    });
    expect(await resolveLang({ flag: undefined, envValue: undefined, home })).toEqual({
      value: "zh-Hant", source: "skillwiki-dotenv", canonical: "zh-Hant"
    });
  });

  it("falls back to 'en' default when no source supplies a value", async () => {
    const home = tmpHome();
    expect(await resolveLang({ flag: undefined, envValue: undefined, home })).toEqual({
      value: "en", source: "default", canonical: "en"
    });
  });

  it("normalizes the chosen value (chinese-traditional → zh-Hant)", async () => {
    const home = tmpHome();
    expect(await resolveLang({ flag: "chinese-traditional", envValue: undefined, home })).toEqual({
      value: "chinese-traditional", source: "flag", canonical: "zh-Hant"
    });
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/utils/lang.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `utils/lang.ts`**

Create `packages/cli/src/utils/lang.ts`:

```typescript
import { join } from "node:path";
import { parseDotenvFile } from "./dotenv.js";

export type LangSource = "flag" | "env" | "skillwiki-dotenv" | "default";

export interface LangResolution {
  value: string;       // raw input that was selected
  source: LangSource;
  canonical: string;   // normalized BCP 47-ish tag
}

const ALIASES: Record<string, string> = {
  english: "en",
  en: "en",
  "chinese-traditional": "zh-Hant",
  "zh-hant": "zh-Hant",
  "zh-tw": "zh-Hant",
  "chinese-simplified": "zh-Hans",
  "zh-hans": "zh-Hans",
  "zh-cn": "zh-Hans"
};

export function normalizeLang(input: string): string {
  const trimmed = input.trim();
  const key = trimmed.toLowerCase();
  return ALIASES[key] ?? trimmed;
}

export interface ResolveLangInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
}

export async function resolveLang(input: ResolveLangInput): Promise<LangResolution> {
  if (input.flag !== undefined && input.flag.length > 0) {
    return { value: input.flag, source: "flag", canonical: normalizeLang(input.flag) };
  }
  if (input.envValue !== undefined && input.envValue.length > 0) {
    return { value: input.envValue, source: "env", canonical: normalizeLang(input.envValue) };
  }
  const dotenv = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
  if (dotenv.WIKI_LANG !== undefined) {
    return { value: dotenv.WIKI_LANG, source: "skillwiki-dotenv", canonical: normalizeLang(dotenv.WIKI_LANG) };
  }
  return { value: "en", source: "default", canonical: "en" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/utils/lang.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/utils/lang.ts packages/cli/test/utils/lang.test.ts
git commit -m "feat(cli): add WIKI_LANG resolver with alias normalization"
```

---

### Task 4: `utils/wiki-path.ts` — init-time and runtime path resolution

**Files:**
- Create: `packages/cli/src/utils/wiki-path.ts`
- Test: `packages/cli/test/utils/wiki-path.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/utils/wiki-path.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInitTimePath, resolveRuntimePath } from "../../src/utils/wiki-path.js";

function newHome(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".hermes"), { recursive: true });
  return h;
}

describe("resolveInitTimePath", () => {
  it("priority: --target > env > skillwiki dotenv > hermes dotenv > $HOME/wiki", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    writeFileSync(join(home, ".hermes", ".env"), "WIKI_PATH=/hermes/y\n");

    expect((await resolveInitTimePath({ flag: "/explicit", envValue: "/env", home })).path).toBe("/explicit");
    expect((await resolveInitTimePath({ flag: undefined, envValue: "/env", home })).path).toBe("/env");
    expect((await resolveInitTimePath({ flag: undefined, envValue: undefined, home })).path).toBe("/sw/x");
  });

  it("falls through to hermes dotenv when skillwiki dotenv is absent", async () => {
    const home = newHome();
    writeFileSync(join(home, ".hermes", ".env"), "WIKI_PATH=/hermes/y\n");
    const r = await resolveInitTimePath({ flag: undefined, envValue: undefined, home });
    expect(r.path).toBe("/hermes/y");
    expect(r.source).toBe("hermes-dotenv");
  });

  it("falls back to $HOME/wiki when no source supplies a value", async () => {
    const home = newHome();
    const r = await resolveInitTimePath({ flag: undefined, envValue: undefined, home });
    expect(r.path).toBe(join(home, "wiki"));
    expect(r.source).toBe("default");
  });

  it("source labels reflect the level that matched", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    expect((await resolveInitTimePath({ flag: "/x", envValue: undefined, home })).source).toBe("flag");
    expect((await resolveInitTimePath({ flag: undefined, envValue: "/y", home })).source).toBe("env");
    expect((await resolveInitTimePath({ flag: undefined, envValue: undefined, home })).source).toBe("skillwiki-dotenv");
  });
});

describe("resolveRuntimePath", () => {
  it("priority: --vault > env > skillwiki dotenv (NO hermes fallback)", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    writeFileSync(join(home, ".hermes", ".env"), "WIKI_PATH=/hermes/y\n");

    expect((await resolveRuntimePath({ flag: "/v", envValue: "/e", home })).ok).toBe(true);
    const r1 = await resolveRuntimePath({ flag: undefined, envValue: undefined, home });
    expect(r1.ok && r1.data.path).toBe("/sw/x");
    expect(r1.ok && r1.data.source).toBe("skillwiki-dotenv");
  });

  it("returns NO_VAULT_CONFIGURED error when chain misses (hermes is ignored at runtime)", async () => {
    const home = newHome();
    writeFileSync(join(home, ".hermes", ".env"), "WIKI_PATH=/hermes/y\n");
    const r = await resolveRuntimePath({ flag: undefined, envValue: undefined, home });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("NO_VAULT_CONFIGURED");
  });

  it("--explain returns the chain", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    const r = await resolveRuntimePath({ flag: undefined, envValue: undefined, home, explain: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.isArray(r.data.chain)).toBe(true);
      expect(r.data.chain!.map(c => c.source)).toEqual(["flag", "env", "skillwiki-dotenv"]);
    }
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/utils/wiki-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `utils/wiki-path.ts`**

Create `packages/cli/src/utils/wiki-path.ts`:

```typescript
import { join } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";
import { parseDotenvFile } from "./dotenv.js";

export type InitTimeSource = "flag" | "env" | "skillwiki-dotenv" | "hermes-dotenv" | "default";
export type RuntimeSource = "flag" | "env" | "skillwiki-dotenv";

export interface ChainEntry { source: InitTimeSource; matched: boolean; value?: string }

export interface InitTimePathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  explain?: boolean;
}
export interface InitTimePathResult {
  path: string;
  source: InitTimeSource;
  chain?: ChainEntry[];
}

export async function resolveInitTimePath(input: InitTimePathInput): Promise<InitTimePathResult> {
  const chain: ChainEntry[] = [];
  if (input.flag !== undefined && input.flag.length > 0) {
    if (input.explain) chain.push({ source: "flag", matched: true, value: input.flag });
    return { path: input.flag, source: "flag", ...(input.explain ? { chain } : {}) };
  }
  if (input.explain) chain.push({ source: "flag", matched: false });

  if (input.envValue !== undefined && input.envValue.length > 0) {
    if (input.explain) chain.push({ source: "env", matched: true, value: input.envValue });
    return { path: input.envValue, source: "env", ...(input.explain ? { chain } : {}) };
  }
  if (input.explain) chain.push({ source: "env", matched: false });

  const sw = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
  if (sw.WIKI_PATH !== undefined) {
    if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: true, value: sw.WIKI_PATH });
    return { path: sw.WIKI_PATH, source: "skillwiki-dotenv", ...(input.explain ? { chain } : {}) };
  }
  if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: false });

  const hermes = await parseDotenvFile(join(input.home, ".hermes", ".env"));
  if (hermes.WIKI_PATH !== undefined) {
    if (input.explain) chain.push({ source: "hermes-dotenv", matched: true, value: hermes.WIKI_PATH });
    return { path: hermes.WIKI_PATH, source: "hermes-dotenv", ...(input.explain ? { chain } : {}) };
  }
  if (input.explain) chain.push({ source: "hermes-dotenv", matched: false });

  const fallback = join(input.home, "wiki");
  if (input.explain) chain.push({ source: "default", matched: true, value: fallback });
  return { path: fallback, source: "default", ...(input.explain ? { chain } : {}) };
}

export interface RuntimePathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  explain?: boolean;
}
export interface RuntimePathOk {
  path: string;
  source: RuntimeSource;
  chain?: Array<{ source: RuntimeSource; matched: boolean; value?: string }>;
}

export async function resolveRuntimePath(input: RuntimePathInput): Promise<Result<RuntimePathOk>> {
  const chain: Array<{ source: RuntimeSource; matched: boolean; value?: string }> = [];

  if (input.flag !== undefined && input.flag.length > 0) {
    if (input.explain) chain.push({ source: "flag", matched: true, value: input.flag });
    return ok({ path: input.flag, source: "flag", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "flag", matched: false });

  if (input.envValue !== undefined && input.envValue.length > 0) {
    if (input.explain) chain.push({ source: "env", matched: true, value: input.envValue });
    return ok({ path: input.envValue, source: "env", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "env", matched: false });

  const sw = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
  if (sw.WIKI_PATH !== undefined) {
    if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: true, value: sw.WIKI_PATH });
    return ok({ path: sw.WIKI_PATH, source: "skillwiki-dotenv", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: false });

  return err("NO_VAULT_CONFIGURED", {
    message: "No vault configured. Run `skillwiki init` to bootstrap one, or pass `--vault <dir>`."
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/utils/wiki-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/utils/wiki-path.ts packages/cli/test/utils/wiki-path.test.ts
git commit -m "feat(cli): add init-time and runtime WIKI_PATH resolvers"
```

---

### Task 5: `parsers/taxonomy.ts` — extract fenced YAML taxonomy from SCHEMA.md

**Files:**
- Create: `packages/cli/src/parsers/taxonomy.ts`
- Test: `packages/cli/test/parsers/taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/parsers/taxonomy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractTaxonomy } from "../../src/parsers/taxonomy.js";

const VALID = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - research
  - timeline
  - person
\`\`\`

## Page Thresholds
`;

const MISSING = `# Vault Schema

## Layers

- raw/ — immutable
`;

const MALFORMED = `## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - [unbalanced
\`\`\`
`;

describe("extractTaxonomy", () => {
  it("returns the list when the fenced YAML block is present", () => {
    const r = extractTaxonomy(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(["research", "timeline", "person"]);
  });

  it("returns ok with [] when the block is absent (caller decides if fatal)", () => {
    const r = extractTaxonomy(MISSING);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });

  it("returns INVALID_FRONTMATTER on malformed YAML", () => {
    const r = extractTaxonomy(MALFORMED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_FRONTMATTER");
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/parsers/taxonomy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parsers/taxonomy.ts`**

Create `packages/cli/src/parsers/taxonomy.ts`:

```typescript
import yaml from "js-yaml";
import { ok, err, type Result } from "@skillwiki/shared";

const FENCE_RE = /^##\s+Tag Taxonomy\s*$[\s\S]*?```yaml\s*\n([\s\S]*?)\n```/m;

export function extractTaxonomy(schemaText: string): Result<string[]> {
  const m = schemaText.match(FENCE_RE);
  if (!m) return ok([]);
  let parsed: unknown;
  try { parsed = yaml.load(m[1], { schema: yaml.JSON_SCHEMA }); }
  catch (e) { return err("INVALID_FRONTMATTER", { message: (e as Error).message }); }
  if (parsed === null || typeof parsed !== "object") {
    return err("INVALID_FRONTMATTER", { message: "taxonomy block is not an object" });
  }
  const tax = (parsed as Record<string, unknown>).taxonomy;
  if (!Array.isArray(tax)) {
    return err("INVALID_FRONTMATTER", { message: "taxonomy key missing or not an array" });
  }
  if (!tax.every(x => typeof x === "string")) {
    return err("INVALID_FRONTMATTER", { message: "taxonomy must be a list of strings" });
  }
  return ok(tax as string[]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/parsers/taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parsers/taxonomy.ts packages/cli/test/parsers/taxonomy.test.ts
git commit -m "feat(cli): add SCHEMA.md taxonomy block parser"
```

---

## Phase 3 — Templates

### Task 6: Rewrite `templates/SCHEMA.md` with substitution slots

**Files:**
- Modify: `packages/cli/templates/SCHEMA.md`

- [ ] **Step 1: Replace the file contents**

Overwrite `packages/cli/templates/SCHEMA.md` with:

````markdown
# Vault Schema

## Domain

{{DOMAIN}}

## Output Language

{{WIKI_LANG}}

This sets the language of generated page prose. Frontmatter keys, schema section headers, file names, and log/index structural lines remain English (parser and Hermes wire-compat invariant).

## Layers

- `raw/` — immutable source material (never modify after ingest).
- `entities/`, `concepts/`, `comparisons/`, `queries/` — typed knowledge unified across origin via `provenance:`.
- `meta/` — cross-project synthesis (notes naming ≥2 projects).
- `projects/{slug}/` — per-project lifecycle workspace.

## Frontmatter

Four shapes: typed-knowledge, raw, work-item, compound. See spec for full Zod schemas.

## Tag Taxonomy

```yaml
taxonomy:
{{TAXONOMY_YAML}}
```

Rule: every tag on every page MUST appear in this taxonomy. Add new tags here first, then use them.

## Page Thresholds

- Create a page when an entity/concept appears in 2+ sources OR is central to one source.
- Add to an existing page when overlap with covered material.
- DO NOT create a page for passing mentions.
- Split a page when it exceeds ~200 lines.
- Archive a page when fully superseded — move to `_archive/`, remove from `index.md`.

## Update Policy

- Newer sources generally supersede older ones (compare dates).
- Genuine contradictions: note both positions with dates and sources.
- Mark in frontmatter: `contested: true` and `contradictions: [other-page]`.
- Flag for user review during lint.

## Conventions

- File names: lowercase-hyphenated, no spaces.
- Wikilinks in YAML: quoted, `"[[name]]"`. Body wikilinks: unquoted `[[name]]`.
- Citations in body: `^[raw/...]` markers; every entry in `sources:` MUST appear in body.
- sha256 in `raw/` frontmatter is computed by `skillwiki hash` over body bytes after closing `---`.
````

- [ ] **Step 2: Commit**

```bash
git add packages/cli/templates/SCHEMA.md
git commit -m "feat(cli): rewrite SCHEMA.md template with DOMAIN/TAXONOMY/WIKI_LANG slots"
```

---

### Task 7: Extend `templates/index.md` with header line

**Files:**
- Modify: `packages/cli/templates/index.md`

- [ ] **Step 1: Replace the file contents**

Overwrite `packages/cli/templates/index.md` with:

```markdown
# Vault Index

> Last updated: {{INIT_DATE}} | Total pages: 0

## Entities
<!-- entities listed here -->

## Concepts
<!-- concepts listed here -->

## Comparisons
<!-- comparisons listed here -->

## Queries
<!-- queries listed here -->

## Projects
<!-- registered projects listed here -->

## Meta
<!-- cross-project synthesis listed here -->
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/templates/index.md
git commit -m "feat(cli): add Last updated/Total pages header to index.md template"
```

---

### Task 8: Extend `templates/log.md` with structured init entry

**Files:**
- Modify: `packages/cli/templates/log.md`

- [ ] **Step 1: Replace the file contents**

Overwrite `packages/cli/templates/log.md` with:

```markdown
# Vault Log

Chronological action log. Newest entries last. Skill writes append entries; lint may rotate.

## [{{INIT_DATE}}] create | Wiki initialized

- Domain: {{DOMAIN}}
- Output language: {{WIKI_LANG}}
- Structure created with SCHEMA.md, index.md, log.md
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/templates/log.md
git commit -m "feat(cli): add structured init entry placeholder to log.md template"
```

---

## Phase 4 — `path` and `lang` query subcommands

### Task 9: `commands/path.ts` — implement `skillwiki path`

**Files:**
- Create: `packages/cli/src/commands/path.ts`
- Test: `packages/cli/test/commands/path.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/path.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPath } from "../../src/commands/path.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".hermes"), { recursive: true });
  return h;
}

describe("runPath", () => {
  it("runtime mode: returns path + source from skillwiki dotenv", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    const r = await runPath({ flag: undefined, envValue: undefined, home: h, initTime: false });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.path).toBe("/sw/x");
      expect(r.result.data.source).toBe("skillwiki-dotenv");
    }
  });

  it("runtime mode: returns NO_VAULT_CONFIGURED (exit 25) when chain misses", async () => {
    const h = home();
    const r = await runPath({ flag: undefined, envValue: undefined, home: h, initTime: false });
    expect(r.exitCode).toBe(25);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe("NO_VAULT_CONFIGURED");
  });

  it("init-time mode: always succeeds with default fallback", async () => {
    const h = home();
    const r = await runPath({ flag: undefined, envValue: undefined, home: h, initTime: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.path).toBe(join(h, "wiki"));
      expect(r.result.data.source).toBe("default");
    }
  });

  it("--explain returns a chain array", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    const r = await runPath({ flag: undefined, envValue: undefined, home: h, initTime: false, explain: true });
    if (r.result.ok) {
      expect(Array.isArray(r.result.data.chain)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/path.ts`**

Create `packages/cli/src/commands/path.ts`:

```typescript
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { resolveInitTimePath, resolveRuntimePath } from "../utils/wiki-path.js";

export interface PathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  initTime: boolean;
  explain?: boolean;
}
export interface PathOutput {
  path: string;
  source: string;
  chain?: Array<{ source: string; matched: boolean; value?: string }>;
}

export async function runPath(input: PathInput): Promise<{ exitCode: number; result: Result<PathOutput> }> {
  if (input.initTime) {
    const r = await resolveInitTimePath({
      flag: input.flag, envValue: input.envValue, home: input.home, explain: input.explain
    });
    return { exitCode: ExitCode.OK, result: ok({ path: r.path, source: r.source, ...(r.chain ? { chain: r.chain } : {}) }) };
  }
  const r = await resolveRuntimePath({
    flag: input.flag, envValue: input.envValue, home: input.home, explain: input.explain
  });
  if (!r.ok) return { exitCode: ExitCode.NO_VAULT_CONFIGURED, result: r };
  return { exitCode: ExitCode.OK, result: ok({ path: r.data.path, source: r.data.source, ...(r.data.chain ? { chain: r.data.chain } : {}) }) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/path.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/path.ts packages/cli/test/commands/path.test.ts
git commit -m "feat(cli): add skillwiki path subcommand"
```

---

### Task 10: `commands/lang.ts` — implement `skillwiki lang`

**Files:**
- Create: `packages/cli/src/commands/lang.ts`
- Test: `packages/cli/test/commands/lang.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/lang.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLang } from "../../src/commands/lang.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("runLang", () => {
  it("returns default 'en' with source=default when nothing supplies a value", async () => {
    const h = home();
    const r = await runLang({ flag: undefined, envValue: undefined, home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.canonical).toBe("en");
      expect(r.result.data.source).toBe("default");
    }
  });

  it("normalizes alias from skillwiki dotenv (chinese-traditional → zh-Hant)", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_LANG=chinese-traditional\n");
    const r = await runLang({ flag: undefined, envValue: undefined, home: h });
    if (r.result.ok) {
      expect(r.result.data.canonical).toBe("zh-Hant");
      expect(r.result.data.source).toBe("skillwiki-dotenv");
    }
  });

  it("--explain returns the chain", async () => {
    const h = home();
    const r = await runLang({ flag: "ja", envValue: undefined, home: h, explain: true });
    if (r.result.ok) {
      expect(Array.isArray(r.result.data.chain)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/lang.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/lang.ts`**

Create `packages/cli/src/commands/lang.ts`:

```typescript
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { resolveLang } from "../utils/lang.js";
import { parseDotenvFile } from "../utils/dotenv.js";
import { join } from "node:path";

export interface LangInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  explain?: boolean;
}
export interface LangOutput {
  value: string;
  source: "flag" | "env" | "skillwiki-dotenv" | "default";
  canonical: string;
  chain?: Array<{ source: string; matched: boolean; value?: string }>;
}

export async function runLang(input: LangInput): Promise<{ exitCode: number; result: Result<LangOutput> }> {
  const resolved = await resolveLang({ flag: input.flag, envValue: input.envValue, home: input.home });
  let chain: Array<{ source: string; matched: boolean; value?: string }> | undefined;
  if (input.explain) {
    chain = [
      { source: "flag", matched: input.flag !== undefined && input.flag.length > 0, value: input.flag },
      { source: "env", matched: input.envValue !== undefined && input.envValue.length > 0, value: input.envValue }
    ];
    const sw = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
    chain.push({ source: "skillwiki-dotenv", matched: sw.WIKI_LANG !== undefined, value: sw.WIKI_LANG });
    chain.push({ source: "default", matched: resolved.source === "default", value: "en" });
  }
  return {
    exitCode: ExitCode.OK,
    result: ok({
      value: resolved.value,
      source: resolved.source,
      canonical: resolved.canonical,
      ...(chain ? { chain } : {})
    })
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/lang.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/lang.ts packages/cli/test/commands/lang.test.ts
git commit -m "feat(cli): add skillwiki lang subcommand"
```

---

### Task 11: Wire `path` and `lang` into the CLI entry point

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Add imports**

In `packages/cli/src/cli.ts`, add these imports near the existing command imports:

```typescript
import { runPath } from "./commands/path.js";
import { runLang } from "./commands/lang.js";
```

- [ ] **Step 2: Register the subcommands**

After the existing `program.command("install")...` block (and before `program.parseAsync`), append:

```typescript
program
  .command("path")
  .option("--vault <dir>", "explicit vault override (runtime)")
  .option("--target <dir>", "explicit target override (init-time)")
  .option("--init-time", "use init-time chain instead of runtime", false)
  .option("--explain", "include resolution chain in output", false)
  .action(async (opts) => {
    const initTime = !!opts.initTime;
    const flag = initTime ? opts.target : opts.vault;
    emit(await runPath({
      flag,
      envValue: process.env.WIKI_PATH,
      home: process.env.HOME ?? "",
      initTime,
      explain: !!opts.explain
    }));
  });

program
  .command("lang")
  .option("--lang <code>", "explicit language override")
  .option("--explain", "include resolution chain in output", false)
  .action(async (opts) => {
    emit(await runLang({
      flag: opts.lang,
      envValue: process.env.WIKI_LANG,
      home: process.env.HOME ?? "",
      explain: !!opts.explain
    }));
  });
```

- [ ] **Step 3: Smoke test the build**

Run: `npm run -w packages/cli build && node packages/cli/dist/cli.js path --init-time`
Expected: JSON envelope `{"ok":true,"data":{"path":"/<your-home>/wiki","source":"default"}}`.

Then: `node packages/cli/dist/cli.js lang`
Expected: JSON envelope `{"ok":true,"data":{"value":"en","source":"default","canonical":"en"}}`.

- [ ] **Step 4: Run the full CLI test suite**

Run: `npm run -w packages/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): register path and lang subcommands"
```

---

## Phase 5 — `skillwiki init`

### Task 12: `commands/init.ts` — scaffolding, template render, env reconciliation

**Files:**
- Create: `packages/cli/src/commands/init.ts`
- Test: `packages/cli/test/commands/init.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/init.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";

const TEMPLATES = join(__dirname, "..", "..", "templates");

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".hermes"), { recursive: true });
  return h;
}

function tmp(): string { return mkdtempSync(join(tmpdir(), "init-")); }

describe("runInit", () => {
  it("creates the vault tree, SCHEMA.md, index.md, log.md and writes both env keys", async () => {
    const h = home();
    const target = tmp();
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "AI safety", taxonomy: undefined, lang: undefined, force: false
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.vault).toBe(target);
      expect(r.result.data.lang).toBe("en");
      expect(r.result.data.imported_from_hermes).toBe(false);
    }
    for (const dir of ["raw/articles", "raw/papers", "raw/transcripts", "raw/assets",
                        "entities", "concepts", "comparisons", "queries", "meta", "projects"]) {
      expect(statSync(join(target, dir)).isDirectory()).toBe(true);
    }
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("AI safety");
    expect(schema).toContain("- research");
    expect(schema).toContain("- model");
    expect(schema).not.toContain("{{DOMAIN}}");
    expect(schema).not.toContain("{{TAXONOMY_YAML}}");
    expect(schema).not.toContain("{{WIKI_LANG}}");
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain(`WIKI_PATH=${target}`);
    expect(env).toContain("WIKI_LANG=en");
  });

  it("fails INIT_TARGET_NOT_EMPTY (15) when target already has SCHEMA.md", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), "existing");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    expect(r.exitCode).toBe(15);
    if (!r.result.ok) expect(r.result.error).toBe("INIT_TARGET_NOT_EMPTY");
  });

  it("--force overrides INIT_TARGET_NOT_EMPTY and re-renders", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), "old");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: true
    });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(target, "SCHEMA.md"), "utf8")).toContain("# Vault Schema");
  });

  it("normalizes --lang chinese-traditional → zh-Hant in dotenv and JSON", async () => {
    const h = home();
    const target = tmp();
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: "chinese-traditional", force: false
    });
    if (r.result.ok) expect(r.result.data.lang).toBe("zh-Hant");
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain("WIKI_LANG=zh-Hant");
  });

  it("custom --taxonomy renders YAML body lines", async () => {
    const h = home();
    const target = tmp();
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: ["model", "architecture", "benchmark"], lang: undefined, force: false
    });
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("  - model");
    expect(schema).toContain("  - architecture");
    expect(schema).toContain("  - benchmark");
    expect(schema).not.toContain("- research");
  });

  it("Hermes-import path: target resolved from ~/.hermes/.env, imported_from_hermes=true", async () => {
    const h = home();
    const hermesTarget = tmp();
    writeFileSync(join(h, ".hermes", ".env"), `WIKI_PATH=${hermesTarget}\n`);
    const r = await runInit({
      flag: undefined, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Imported", taxonomy: undefined, lang: undefined, force: false
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.vault).toBe(hermesTarget);
      expect(r.result.data.imported_from_hermes).toBe(true);
    }
  });

  it("Hermes-import is false when ~/.skillwiki/.env already has WIKI_PATH", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${target}\nWIKI_LANG=en\n`);
    const r = await runInit({
      flag: undefined, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    if (r.result.ok) expect(r.result.data.imported_from_hermes).toBe(false);
  });

  it("ENV_WRITE_CONFLICT (24) when ~/.skillwiki/.env already binds a different WIKI_PATH", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/different/path\n");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    expect(r.exitCode).toBe(24);
    if (!r.result.ok) expect(r.result.error).toBe("ENV_WRITE_CONFLICT");
  });

  it("ENV_WRITE_CONFLICT (24) when ~/.skillwiki/.env already binds a different WIKI_LANG", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${target}\nWIKI_LANG=zh-Hant\n`);
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: "ja", force: false
    });
    expect(r.exitCode).toBe(24);
  });

  it("--force overrides ENV_WRITE_CONFLICT and rewrites both keys", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/different/path\nWIKI_LANG=zh-Hant\n");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: "ja", force: true
    });
    expect(r.exitCode).toBe(0);
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain(`WIKI_PATH=${target}`);
    expect(env).toContain("WIKI_LANG=ja");
    expect(env).not.toContain("WIKI_PATH=/different/path");
    expect(env).not.toContain("WIKI_LANG=zh-Hant");
  });

  it("idempotent on identical values (no error, no diff)", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${target}\nWIKI_LANG=en\n`);
    // Pre-create SCHEMA.md so we'd hit INIT_TARGET_NOT_EMPTY without --force.
    // Instead test idempotency by running into an empty target with matching env.
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: "en", force: false
    });
    expect(r.exitCode).toBe(0);
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain(`WIKI_PATH=${target}`);
    expect(env).toContain("WIKI_LANG=en");
  });

  it("templates/log.md substitutes INIT_DATE, DOMAIN, WIKI_LANG", async () => {
    const h = home();
    const target = tmp();
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Quantum", taxonomy: undefined, lang: undefined, force: false
    });
    const log = readFileSync(join(target, "log.md"), "utf8");
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] create \| Wiki initialized/m);
    expect(log).toContain("- Domain: Quantum");
    expect(log).toContain("- Output language: en");
  });

  it("templates/index.md substitutes INIT_DATE", async () => {
    const h = home();
    const target = tmp();
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    const idx = readFileSync(join(target, "index.md"), "utf8");
    expect(idx).toMatch(/^> Last updated: \d{4}-\d{2}-\d{2} \| Total pages: 0/m);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/init.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/init.ts`**

Create `packages/cli/src/commands/init.ts`:

```typescript
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { resolveInitTimePath } from "../utils/wiki-path.js";
import { resolveLang, normalizeLang } from "../utils/lang.js";
import { parseDotenvFile } from "../utils/dotenv.js";

const DEFAULT_TAXONOMY = [
  "research", "comparison", "timeline", "summary", "person",
  "organization", "concept", "technique", "tool", "model"
];

const VAULT_DIRS = [
  "raw/articles", "raw/papers", "raw/transcripts", "raw/assets",
  "entities", "concepts", "comparisons", "queries", "meta", "projects"
];

export interface InitInput {
  flag: string | undefined;       // --target
  envValue: string | undefined;   // process.env.WIKI_PATH
  home: string;
  templates: string;              // absolute path to packages/cli/templates
  domain: string;
  taxonomy: string[] | undefined;
  lang: string | undefined;
  force: boolean;
}
export interface InitOutput {
  vault: string;
  domain: string;
  taxonomy: string[];
  lang: string;
  created: string[];
  env_written: string;
  imported_from_hermes: boolean;
}

export async function runInit(input: InitInput): Promise<{ exitCode: number; result: Result<InitOutput> }> {
  const pathRes = await resolveInitTimePath({ flag: input.flag, envValue: input.envValue, home: input.home });
  const target = pathRes.path;

  const langRes = await resolveLang({ flag: input.lang, envValue: undefined, home: input.home });
  const canonicalLang = langRes.canonical;

  // Step 3: emptiness check.
  let hasSchema = false;
  try { await stat(join(target, "SCHEMA.md")); hasSchema = true; } catch { /* good */ }
  if (hasSchema && !input.force) {
    return {
      exitCode: ExitCode.INIT_TARGET_NOT_EMPTY,
      result: err("INIT_TARGET_NOT_EMPTY", { target })
    };
  }

  // Step 8 (env reconciliation) — fail FAST before mutating disk.
  const envPath = join(input.home, ".skillwiki", ".env");
  const existingEnv = await parseDotenvFile(envPath);
  const swDotenvHadPath = existingEnv.WIKI_PATH !== undefined;
  if (existingEnv.WIKI_PATH !== undefined && existingEnv.WIKI_PATH !== target && !input.force) {
    return {
      exitCode: ExitCode.ENV_WRITE_CONFLICT,
      result: err("ENV_WRITE_CONFLICT", { key: "WIKI_PATH", existing: existingEnv.WIKI_PATH, attempted: target })
    };
  }
  if (existingEnv.WIKI_LANG !== undefined && existingEnv.WIKI_LANG !== canonicalLang && !input.force) {
    return {
      exitCode: ExitCode.ENV_WRITE_CONFLICT,
      result: err("ENV_WRITE_CONFLICT", { key: "WIKI_LANG", existing: existingEnv.WIKI_LANG, attempted: canonicalLang })
    };
  }

  const created: string[] = [];

  // Step 4: create directory tree.
  try {
    await mkdir(target, { recursive: true });
    for (const d of VAULT_DIRS) {
      await mkdir(join(target, d), { recursive: true });
      created.push(d + "/");
    }
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { message: String(e) }) };
  }

  const today = new Date().toISOString().slice(0, 10);
  const taxonomy = input.taxonomy && input.taxonomy.length > 0 ? input.taxonomy : DEFAULT_TAXONOMY;
  const taxonomyYaml = taxonomy.map(t => `  - ${t}`).join("\n");

  // Step 5: render SCHEMA.md.
  try {
    const schemaTpl = await readFile(join(input.templates, "SCHEMA.md"), "utf8");
    const schema = schemaTpl
      .replace("{{DOMAIN}}", input.domain)
      .replace("{{WIKI_LANG}}", canonicalLang)
      .replace("{{TAXONOMY_YAML}}", taxonomyYaml);
    await writeFile(join(target, "SCHEMA.md"), schema, "utf8");
    created.push("SCHEMA.md");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "SCHEMA.md", message: String(e) }) };
  }

  // Step 6: render index.md.
  try {
    const idxTpl = await readFile(join(input.templates, "index.md"), "utf8");
    const idx = idxTpl.replace("{{INIT_DATE}}", today);
    await writeFile(join(target, "index.md"), idx, "utf8");
    created.push("index.md");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "index.md", message: String(e) }) };
  }

  // Step 7: render log.md.
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

  // Step 8: write ~/.skillwiki/.env atomically (write both keys, single file).
  try {
    await mkdir(dirname(envPath), { recursive: true });
    const envBody = `WIKI_PATH=${target}\nWIKI_LANG=${canonicalLang}\n`;
    await writeFile(envPath, envBody, "utf8");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: envPath, message: String(e) }) };
  }

  const importedFromHermes = pathRes.source === "hermes-dotenv" && !swDotenvHadPath;

  return {
    exitCode: ExitCode.OK,
    result: ok({
      vault: target,
      domain: input.domain,
      taxonomy,
      lang: canonicalLang,
      created,
      env_written: envPath,
      imported_from_hermes: importedFromHermes
    })
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/init.test.ts`
Expected: PASS (all 11 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/test/commands/init.test.ts
git commit -m "feat(cli): add skillwiki init with Hermes-import and lang reconciliation"
```

---

### Task 13: Wire `init` into the CLI entry point

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Add the import**

Near the existing command imports in `packages/cli/src/cli.ts`:

```typescript
import { runInit } from "./commands/init.js";
```

- [ ] **Step 2: Register the subcommand**

Append after the `lang` registration block (and before `program.parseAsync`):

```typescript
program
  .command("init")
  .option("--target <dir>", "explicit target directory")
  .requiredOption("--domain <text>", "knowledge domain seed")
  .option("--taxonomy <csv>", "comma-separated tag list")
  .option("--lang <code>", "output language (BCP 47 or alias)")
  .option("--force", "override existing target / env conflict", false)
  .action(async (opts) => {
    const templates = new URL("../../templates/", import.meta.url).pathname;
    const taxonomy = typeof opts.taxonomy === "string"
      ? opts.taxonomy.split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0)
      : undefined;
    emit(await runInit({
      flag: opts.target,
      envValue: process.env.WIKI_PATH,
      home: process.env.HOME ?? "",
      templates,
      domain: opts.domain,
      taxonomy,
      lang: opts.lang,
      force: !!opts.force
    }));
  });
```

- [ ] **Step 3: Smoke test the build**

```bash
npm run -w packages/cli build
TMP_VAULT=$(mktemp -d)
node packages/cli/dist/cli.js init --target "$TMP_VAULT" --domain "Smoke test" --lang en
ls "$TMP_VAULT"
```

Expected: JSON envelope with `imported_from_hermes` and a vault tree containing SCHEMA.md, index.md, log.md, and the directory layout.

- [ ] **Step 4: Run the full CLI test suite**

Run: `npm run -w packages/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): register init subcommand"
```

---

## Phase 6 — Lint subcommand: `links`

### Task 14: `commands/links.ts` — broken wikilink detection

**Files:**
- Create: `packages/cli/src/commands/links.ts`
- Test: `packages/cli/test/commands/links.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/links.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinks } from "../../src/commands/links.js";

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Vault Schema\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

const FM = `---
title: page
type: concept
tags: [model]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

describe("runLinks", () => {
  it("clean vault exits 0", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM + "See [[beta]].\n");
    writeFileSync(join(v, "concepts", "beta.md"), FM + "Refers to [[alpha]].\n");
    const r = await runLinks({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.broken).toEqual([]);
  });

  it("broken wikilink → BROKEN_WIKILINKS exit 16", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM + "See [[ghost]].\n");
    const r = await runLinks({ vault: v });
    expect(r.exitCode).toBe(16);
    if (r.result.ok) {
      expect(r.result.data.broken.length).toBe(1);
      expect(r.result.data.broken[0].slug).toBe("ghost");
    }
  });

  it("self-reference resolves (own slug counts as a target)", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM + "Self [[alpha]].\n");
    const r = await runLinks({ vault: v });
    expect(r.exitCode).toBe(0);
  });

  it("VAULT_PATH_INVALID (9) when vault has no SCHEMA.md", async () => {
    const v = mkdtempSync(join(tmpdir(), "novault-"));
    const r = await runLinks({ vault: v });
    expect(r.exitCode).toBe(9);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/links.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/links.ts`**

Create `packages/cli/src/commands/links.ts`:

```typescript
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface LinksInput { vault: string }
export interface LinksOutput {
  broken: Array<{ page: string; slug: string; line: number }>;
}

export async function runLinks(input: LinksInput): Promise<{ exitCode: number; result: Result<LinksOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const slugs = new Set<string>();
  for (const p of scan.data.typedKnowledge) {
    slugs.add(p.relPath.replace(/\.md$/, "").split("/").pop()!);
  }

  const broken: LinksOutput["broken"] = [];
  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const lines = body.split("\n");
    for (const slug of extractBodyWikilinks(body)) {
      const tail = slug.split("/").pop()!;
      if (!slugs.has(tail)) {
        const line = lines.findIndex(l => l.includes(`[[${slug}`));
        broken.push({ page: p.relPath, slug, line: line >= 0 ? line + 1 : 0 });
      }
    }
  }
  if (broken.length > 0) {
    return { exitCode: ExitCode.BROKEN_WIKILINKS, result: ok({ broken }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ broken }) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/links.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/links.ts packages/cli/test/commands/links.test.ts
git commit -m "feat(cli): add skillwiki links broken-wikilink check"
```

---

## Phase 7 — Lint subcommand: `tag-audit`

### Task 15: `commands/tag-audit.ts` — tags must appear in taxonomy

**Files:**
- Create: `packages/cli/src/commands/tag-audit.ts`
- Test: `packages/cli/test/commands/tag-audit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/tag-audit.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTagAudit } from "../../src/commands/tag-audit.js";

const SCHEMA_OK = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
  - person
\`\`\`
`;

function v(schema = SCHEMA_OK): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), schema);
  for (const d of ["entities", "concepts", "comparisons", "queries"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

const FM = (tags: string[]) => `---
title: t
type: concept
tags: [${tags.join(", ")}]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

body
`;

describe("runTagAudit", () => {
  it("clean → exit 0", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "a.md"), FM(["model"]));
    const r = await runTagAudit({ vault: dir });
    expect(r.exitCode).toBe(0);
  });

  it("tag not in taxonomy → exit 17", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "a.md"), FM(["model", "rogue"]));
    const r = await runTagAudit({ vault: dir });
    expect(r.exitCode).toBe(17);
    if (r.result.ok) {
      expect(r.result.data.violations.some(v => v.tag === "rogue")).toBe(true);
    }
  });

  it("missing taxonomy block → INVALID_FRONTMATTER (7) is acceptable; here we treat empty taxonomy as 'no tags allowed'", async () => {
    const dir = v("# Vault Schema\n");
    writeFileSync(join(dir, "concepts", "a.md"), FM(["model"]));
    const r = await runTagAudit({ vault: dir });
    expect(r.exitCode).toBe(17);
    if (r.result.ok) expect(r.result.data.taxonomy).toEqual([]);
  });

  it("malformed taxonomy YAML → exit 7 (INVALID_FRONTMATTER)", async () => {
    const dir = v("## Tag Taxonomy\n\n```yaml\ntaxonomy:\n  - [unbalanced\n```\n");
    const r = await runTagAudit({ vault: dir });
    expect(r.exitCode).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/tag-audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/tag-audit.ts`**

Create `packages/cli/src/commands/tag-audit.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { extractTaxonomy } from "../parsers/taxonomy.js";

export interface TagAuditInput { vault: string }
export interface TagAuditOutput {
  violations: Array<{ page: string; tag: string }>;
  taxonomy: string[];
}

export async function runTagAudit(input: TagAuditInput): Promise<{ exitCode: number; result: Result<TagAuditOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const schemaText = await readFile(join(input.vault, "SCHEMA.md"), "utf8");
  const tax = extractTaxonomy(schemaText);
  if (!tax.ok) return { exitCode: ExitCode.INVALID_FRONTMATTER, result: tax };

  const allowed = new Set(tax.data);
  const violations: TagAuditOutput["violations"] = [];

  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const fm = extractFrontmatter(text);
    if (!fm.ok) return { exitCode: ExitCode.INVALID_FRONTMATTER, result: fm };
    const tags = fm.data.tags;
    if (!Array.isArray(tags)) continue;
    for (const t of tags) {
      if (typeof t === "string" && !allowed.has(t)) {
        violations.push({ page: p.relPath, tag: t });
      }
    }
  }

  if (violations.length > 0) {
    return { exitCode: ExitCode.TAG_NOT_IN_TAXONOMY, result: ok({ violations, taxonomy: tax.data }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ violations, taxonomy: tax.data }) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/tag-audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/tag-audit.ts packages/cli/test/commands/tag-audit.test.ts
git commit -m "feat(cli): add skillwiki tag-audit"
```

---

## Phase 8 — Lint subcommand: `index-check`

### Task 16: `commands/index-check.ts` — index.md ↔ filesystem reconciliation

**Files:**
- Create: `packages/cli/src/commands/index-check.ts`
- Test: `packages/cli/test/commands/index-check.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/index-check.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexCheck } from "../../src/commands/index-check.js";

function v(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  for (const d of ["entities", "concepts", "comparisons", "queries"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

const FM = `---
title: t
type: concept
tags: []
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

describe("runIndexCheck", () => {
  it("clean: every file is in the index, every index entry resolves", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "index.md"), `# Index\n\n## Concepts\n- [[alpha]]\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
  });

  it("missing from index → exit 18", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "index.md"), `# Index\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(18);
    if (r.result.ok) {
      expect(r.result.data.missing_from_index).toContain("concepts/alpha.md");
    }
  });

  it("ghost entry (index points to nonexistent slug) → exit 18", async () => {
    const dir = v();
    writeFileSync(join(dir, "index.md"), `# Index\n\n## Concepts\n- [[ghost]]\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(18);
    if (r.result.ok) {
      expect(r.result.data.ghost_entries).toContain("ghost");
    }
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/index-check.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/index-check.ts`**

Create `packages/cli/src/commands/index-check.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";

export interface IndexCheckInput { vault: string }
export interface IndexCheckOutput {
  missing_from_index: string[];
  ghost_entries: string[];
}

export async function runIndexCheck(input: IndexCheckInput): Promise<{ exitCode: number; result: Result<IndexCheckOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  let indexText = "";
  try { indexText = await readFile(join(input.vault, "index.md"), "utf8"); } catch { /* empty */ }

  const indexSlugs = new Set(extractBodyWikilinks(indexText).map(s => s.split("/").pop()!));
  const fileSlugs = new Map<string, string>(); // slug -> relPath
  for (const p of scan.data.typedKnowledge) {
    const slug = p.relPath.replace(/\.md$/, "").split("/").pop()!;
    fileSlugs.set(slug, p.relPath);
  }

  const missing_from_index: string[] = [];
  for (const [slug, relPath] of fileSlugs.entries()) {
    if (!indexSlugs.has(slug)) missing_from_index.push(relPath);
  }
  const ghost_entries: string[] = [];
  for (const slug of indexSlugs) {
    if (!fileSlugs.has(slug)) ghost_entries.push(slug);
  }

  if (missing_from_index.length > 0 || ghost_entries.length > 0) {
    return { exitCode: ExitCode.INDEX_INCOMPLETE, result: ok({ missing_from_index, ghost_entries }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ missing_from_index, ghost_entries }) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/index-check.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/index-check.ts packages/cli/test/commands/index-check.test.ts
git commit -m "feat(cli): add skillwiki index-check"
```

---

## Phase 9 — Lint subcommand: `stale`

### Task 17: `commands/stale.ts` — page outdated relative to its sources

**Files:**
- Create: `packages/cli/src/commands/stale.ts`
- Test: `packages/cli/test/commands/stale.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/stale.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStale } from "../../src/commands/stale.js";

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Vault Schema\n");
  for (const d of ["concepts", "raw/articles"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

function pageFM(updated: string, sources: string[]): string {
  return `---
title: t
type: concept
tags: []
sources:
${sources.map(s => `  - ${s}`).join("\n")}
provenance: research
created: ${updated}
updated: ${updated}
---

body
`;
}

function rawFM(ingested: string): string {
  return `---
title: raw
url: https://example.com/x
type: raw
ingested: ${ingested}
sha256: 0000000000000000000000000000000000000000000000000000000000000000
---

raw body
`;
}

describe("runStale", () => {
  it("clean when gap ≤ threshold", async () => {
    const v = vault();
    writeFileSync(join(v, "raw", "articles", "src.md"), rawFM("2026-04-01"));
    writeFileSync(join(v, "concepts", "p.md"), pageFM("2026-03-15", ["raw/articles/src.md"]));
    const r = await runStale({ vault: v, days: 90 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.stale).toEqual([]);
  });

  it("flags pages whose updated lags newest source ingested by > days", async () => {
    const v = vault();
    writeFileSync(join(v, "raw", "articles", "src.md"), rawFM("2026-05-01"));
    writeFileSync(join(v, "concepts", "p.md"), pageFM("2025-12-01", ["raw/articles/src.md"]));
    const r = await runStale({ vault: v, days: 30 });
    expect(r.exitCode).toBe(19);
    if (r.result.ok) {
      expect(r.result.data.stale.length).toBe(1);
      expect(r.result.data.stale[0].page).toBe("concepts/p.md");
    }
  });

  it("page with no sources is clean", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "p.md"), pageFM("2020-01-01", []));
    const r = await runStale({ vault: v, days: 30 });
    expect(r.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/stale.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/stale.ts`**

Create `packages/cli/src/commands/stale.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface StaleInput { vault: string; days: number }
export interface StaleOutput {
  stale: Array<{ page: string; page_updated: string; newest_source_ingested: string; gap_days: number }>;
}

function dayDiff(a: string, b: string): number {
  const da = Date.parse(a);
  const db = Date.parse(b);
  return Math.round((db - da) / 86400000);
}

export async function runStale(input: StaleInput): Promise<{ exitCode: number; result: Result<StaleOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const stale: StaleOutput["stale"] = [];

  for (const p of scan.data.typedKnowledge) {
    const fm = extractFrontmatter(await readPage(p));
    if (!fm.ok) continue;
    const updated = typeof fm.data.updated === "string" ? fm.data.updated : undefined;
    const sources = Array.isArray(fm.data.sources) ? fm.data.sources.filter((s): s is string => typeof s === "string") : [];
    if (!updated || sources.length === 0) continue;

    let newest: string | undefined;
    for (const rel of sources) {
      let raw: string;
      try { raw = await readFile(join(input.vault, rel), "utf8"); } catch { continue; }
      const rfm = extractFrontmatter(raw);
      if (!rfm.ok) continue;
      const ing = typeof rfm.data.ingested === "string" ? rfm.data.ingested : undefined;
      if (ing && (!newest || Date.parse(ing) > Date.parse(newest))) newest = ing;
    }
    if (!newest) continue;
    const gap = dayDiff(updated, newest);
    if (gap > input.days) {
      stale.push({ page: p.relPath, page_updated: updated, newest_source_ingested: newest, gap_days: gap });
    }
  }

  if (stale.length > 0) return { exitCode: ExitCode.STALE_PAGE, result: ok({ stale }) };
  return { exitCode: ExitCode.OK, result: ok({ stale }) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/stale.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/stale.ts packages/cli/test/commands/stale.test.ts
git commit -m "feat(cli): add skillwiki stale check"
```

---

## Phase 10 — Lint subcommand: `pagesize`

### Task 18: `commands/pagesize.ts` — flag oversized typed-knowledge pages

**Files:**
- Create: `packages/cli/src/commands/pagesize.ts`
- Test: `packages/cli/test/commands/pagesize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/pagesize.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPagesize } from "../../src/commands/pagesize.js";

const FM = `---
title: t
type: concept
tags: []
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

function v(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "concepts"), { recursive: true });
  return dir;
}

describe("runPagesize", () => {
  it("under threshold → exit 0", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "small.md"), FM + "line\n".repeat(50));
    const r = await runPagesize({ vault: dir, lines: 200 });
    expect(r.exitCode).toBe(0);
  });

  it("over threshold → exit 20 with body line count", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "big.md"), FM + "line\n".repeat(250));
    const r = await runPagesize({ vault: dir, lines: 200 });
    expect(r.exitCode).toBe(20);
    if (r.result.ok) {
      expect(r.result.data.oversized.length).toBe(1);
      expect(r.result.data.oversized[0].lines).toBeGreaterThan(200);
    }
  });

  it("custom --lines threshold respected", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "p.md"), FM + "line\n".repeat(80));
    const r = await runPagesize({ vault: dir, lines: 50 });
    expect(r.exitCode).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/pagesize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/pagesize.ts`**

Create `packages/cli/src/commands/pagesize.ts`:

```typescript
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface PagesizeInput { vault: string; lines: number }
export interface PagesizeOutput {
  oversized: Array<{ page: string; lines: number }>;
}

export async function runPagesize(input: PagesizeInput): Promise<{ exitCode: number; result: Result<PagesizeOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const oversized: PagesizeOutput["oversized"] = [];
  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const count = body.split("\n").length;
    if (count > input.lines) oversized.push({ page: p.relPath, lines: count });
  }
  if (oversized.length > 0) return { exitCode: ExitCode.PAGE_TOO_LARGE, result: ok({ oversized }) };
  return { exitCode: ExitCode.OK, result: ok({ oversized }) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/pagesize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/pagesize.ts packages/cli/test/commands/pagesize.test.ts
git commit -m "feat(cli): add skillwiki pagesize check"
```

---

## Phase 11 — Lint subcommand: `log-rotate`

### Task 19: `commands/log-rotate.ts` — warn-only by default, `--apply` rotates

**Files:**
- Create: `packages/cli/src/commands/log-rotate.ts`
- Test: `packages/cli/test/commands/log-rotate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/log-rotate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogRotate } from "../../src/commands/log-rotate.js";

function v(entries: number, year = "2026"): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  let log = "# Vault Log\n\n";
  for (let i = 0; i < entries; i++) {
    log += `## [${year}-01-01] action | entry ${i}\n\n- detail\n\n`;
  }
  writeFileSync(join(dir, "log.md"), log);
  return dir;
}

describe("runLogRotate", () => {
  it("under threshold → exit 0, rotated false", async () => {
    const dir = v(50);
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.rotated).toBe(false);
  });

  it("over threshold without --apply → exit 21, no file change", async () => {
    const dir = v(600);
    const before = readFileSync(join(dir, "log.md"), "utf8");
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: false });
    expect(r.exitCode).toBe(21);
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe(before);
  });

  it("over threshold with --apply → exit 0, log.md replaced and log-YYYY.md created", async () => {
    const dir = v(600, "2025");
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: true });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dir, "log-2025.md"))).toBe(true);
    const fresh = readFileSync(join(dir, "log.md"), "utf8");
    expect(fresh).toContain("# Vault Log");
    expect(fresh).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] rotate \| Log rotated from 600 entries/m);
  });

  it("second --apply on freshly rotated log is a no-op (entry count below threshold)", async () => {
    const dir = v(600, "2025");
    await runLogRotate({ vault: dir, threshold: 500, apply: true });
    const r2 = await runLogRotate({ vault: dir, threshold: 500, apply: true });
    expect(r2.exitCode).toBe(0);
    if (r2.result.ok) expect(r2.result.data.rotated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/log-rotate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/log-rotate.ts`**

Create `packages/cli/src/commands/log-rotate.ts`:

```typescript
import { readFile, rename, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";

const ENTRY_RE = /^## \[(\d{4})-\d{2}-\d{2}\]/gm;

export interface LogRotateInput { vault: string; threshold: number; apply: boolean }
export interface LogRotateOutput {
  entries: number;
  threshold: number;
  rotated: boolean;
  rotated_to?: string;
}

export async function runLogRotate(input: LogRotateInput): Promise<{ exitCode: number; result: Result<LogRotateOutput> }> {
  try { await stat(join(input.vault, "SCHEMA.md")); }
  catch { return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { vault: input.vault }) }; }

  const logPath = join(input.vault, "log.md");
  let logText: string;
  try { logText = await readFile(logPath, "utf8"); }
  catch { return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: logPath }) }; }

  const matches = [...logText.matchAll(ENTRY_RE)];
  const entries = matches.length;

  if (entries < input.threshold) {
    return { exitCode: ExitCode.OK, result: ok({ entries, threshold: input.threshold, rotated: false }) };
  }

  if (!input.apply) {
    return {
      exitCode: ExitCode.LOG_ROTATE_NEEDED,
      result: ok({ entries, threshold: input.threshold, rotated: false })
    };
  }

  // Find the year of the most recent entry (last regex match group).
  const newestYear = matches[matches.length - 1][1];
  const rotatedName = `log-${newestYear}.md`;
  const rotatedPath = join(input.vault, rotatedName);

  try {
    await rename(logPath, rotatedPath);
    const today = new Date().toISOString().slice(0, 10);
    const fresh = `# Vault Log\n\nChronological action log. Newest entries last. Skill writes append entries; lint may rotate.\n\n## [${today}] rotate | Log rotated from ${entries} entries\n\n- Previous log moved to ${rotatedName}\n`;
    await writeFile(logPath, fresh, "utf8");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { message: String(e) }) };
  }

  return { exitCode: ExitCode.OK, result: ok({ entries, threshold: input.threshold, rotated: true, rotated_to: rotatedName }) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/log-rotate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/log-rotate.ts packages/cli/test/commands/log-rotate.test.ts
git commit -m "feat(cli): add skillwiki log-rotate"
```

---

## Phase 12 — `orphans` becomes vault-optional

### Task 20: Make `orphans` consume the runtime resolver

**Files:**
- Modify: `packages/cli/src/commands/orphans.ts`
- Modify: `packages/cli/test/commands/orphans.test.ts`
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Add a regression test for the new optional-vault contract**

Append to `packages/cli/test/commands/orphans.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

function home(): string {
  const h = mkdtempSync(join(__dirname, "..", "tmp-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("orphans (vault-optional)", () => {
  it("uses --vault when provided", async () => {
    const r = await runOrphans({ vault: VAULT });
    expect(r.exitCode).toBe(0);
  });

  it("returns NO_VAULT_CONFIGURED (25) when neither --vault nor env nor dotenv supply a vault", async () => {
    const h = mkdtempSync(join(tmpdir(), "no-vault-"));
    mkdirSync(join(h, ".skillwiki"), { recursive: true });
    const r = await runOrphans({ vault: undefined, envValue: undefined, home: h });
    expect(r.exitCode).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/orphans.test.ts`
Expected: FAIL — `runOrphans` does not accept `envValue`/`home` and does not return `NO_VAULT_CONFIGURED`.

- [ ] **Step 3: Update `runOrphans` to accept the resolver inputs**

Replace the signature/top of `packages/cli/src/commands/orphans.ts`:

```typescript
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { resolveRuntimePath } from "../utils/wiki-path.js";

export interface OrphansInput {
  vault: string | undefined;
  envValue?: string | undefined;
  home?: string;
}
export interface OrphansOutput {
  orphans: string[];
  bridges: Array<{ path: string; connects: string[] }>;
}

export async function runOrphans(input: OrphansInput): Promise<{ exitCode: number; result: Result<OrphansOutput> }> {
  let vaultPath = input.vault;
  if (!vaultPath) {
    const r = await resolveRuntimePath({
      flag: undefined,
      envValue: input.envValue,
      home: input.home ?? ""
    });
    if (!r.ok) return { exitCode: ExitCode.NO_VAULT_CONFIGURED, result: r };
    vaultPath = r.data.path;
  }
  const scan = await scanVault(vaultPath);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  // ...rest of existing implementation, using `scan` exactly as before
```

Keep the existing body of the function (slug map, adjacency, DFS, bridge calculation, return) unchanged below this point — just renamed the local `vaultPath` is not used past `scan`.

- [ ] **Step 4: Update the CLI registration to make `<vault>` optional**

In `packages/cli/src/cli.ts`, replace the existing line:

```typescript
program.command("orphans <vault>").action(async (vault) => emit(await runOrphans({ vault })));
```

With:

```typescript
program
  .command("orphans [vault]")
  .action(async (vault) => emit(await runOrphans({
    vault,
    envValue: process.env.WIKI_PATH,
    home: process.env.HOME ?? ""
  })));
```

- [ ] **Step 5: Run the full CLI test suite**

Run: `npm run -w packages/cli test`
Expected: PASS (existing tests still green; the two new orphans assertions pass).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/orphans.ts packages/cli/test/commands/orphans.test.ts packages/cli/src/cli.ts
git commit -m "refactor(cli): make orphans vault arg optional via runtime resolver"
```

---

## Phase 13 — Wire `links`, `tag-audit`, `index-check`, `stale`, `pagesize`, `log-rotate` into the CLI

### Task 21: Register the six small lint subcommands

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Add imports**

```typescript
import { runLinks } from "./commands/links.js";
import { runTagAudit } from "./commands/tag-audit.js";
import { runIndexCheck } from "./commands/index-check.js";
import { runStale } from "./commands/stale.js";
import { runPagesize } from "./commands/pagesize.js";
import { runLogRotate } from "./commands/log-rotate.js";
```

- [ ] **Step 2: Add a small helper to resolve a vault arg with the runtime chain**

Above the command registrations (but after `function emit`):

```typescript
import { resolveRuntimePath } from "./utils/wiki-path.js";

async function resolveVaultArg(arg: string | undefined): Promise<{ ok: true; vault: string } | { ok: false; exitCode: number; payload: any }> {
  if (arg) return { ok: true, vault: arg };
  const r = await resolveRuntimePath({
    flag: undefined,
    envValue: process.env.WIKI_PATH,
    home: process.env.HOME ?? ""
  });
  if (!r.ok) return { ok: false, exitCode: 25, payload: r };
  return { ok: true, vault: r.data.path };
}
```

- [ ] **Step 3: Register the six subcommands**

Append before `program.parseAsync`:

```typescript
program.command("links [vault]").action(async (vault) => {
  const v = await resolveVaultArg(vault);
  if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
  else emit(await runLinks({ vault: v.vault }));
});

program.command("tag-audit [vault]").action(async (vault) => {
  const v = await resolveVaultArg(vault);
  if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
  else emit(await runTagAudit({ vault: v.vault }));
});

program.command("index-check [vault]").action(async (vault) => {
  const v = await resolveVaultArg(vault);
  if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
  else emit(await runIndexCheck({ vault: v.vault }));
});

program
  .command("stale [vault]")
  .option("--days <n>", "staleness threshold in days", (s) => parseInt(s, 10), 90)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runStale({ vault: v.vault, days: opts.days }));
  });

program
  .command("pagesize [vault]")
  .option("--lines <n>", "max body lines", (s) => parseInt(s, 10), 200)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runPagesize({ vault: v.vault, lines: opts.lines }));
  });

program
  .command("log-rotate [vault]")
  .option("--threshold <n>", "entry count threshold", (s) => parseInt(s, 10), 500)
  .option("--apply", "actually rotate", false)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runLogRotate({ vault: v.vault, threshold: opts.threshold, apply: !!opts.apply }));
  });
```

- [ ] **Step 4: Smoke test the build**

```bash
npm run -w packages/cli build
node packages/cli/dist/cli.js links --help
```
Expected: Commander help output mentioning the new subcommands.

- [ ] **Step 5: Run the full CLI test suite**

Run: `npm run -w packages/cli test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): register links, tag-audit, index-check, stale, pagesize, log-rotate"
```

---

## Phase 14 — Lint umbrella

### Task 22: `commands/lint.ts` — single vault scan, severity-grouped report

**Files:**
- Create: `packages/cli/src/commands/lint.ts`
- Test: `packages/cli/test/commands/lint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands/lint.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../../src/commands/lint.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

const FM = (tags: string[], updated = "2026-05-03") => `---
title: t
type: concept
tags: [${tags.join(", ")}]
sources: []
provenance: research
created: ${updated}
updated: ${updated}
---

`;

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

describe("runLint", () => {
  it("clean fixture exits 0", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.summary.errors).toBe(0);
      expect(r.result.data.summary.warnings).toBe(0);
    }
  });

  it("warning-only fixture exits 22 (LINT_HAS_WARNINGS)", async () => {
    const v = vault();
    // Page is in filesystem but missing from index → warning.
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      expect(r.result.data.summary.warnings).toBeGreaterThan(0);
      expect(r.result.data.summary.errors).toBe(0);
    }
  });

  it("error fixture exits 23 (LINT_HAS_ERRORS)", async () => {
    const v = vault();
    // Tag not in taxonomy → error.
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["rogue"]) + "Body [[alpha]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(23);
    if (r.result.ok) {
      expect(r.result.data.summary.errors).toBeGreaterThan(0);
      const kinds = r.result.data.by_severity.error.map(e => e.kind);
      expect(kinds).toContain("tag_not_in_taxonomy");
    }
  });

  it("returns vault path + source in the envelope", async () => {
    const v = vault();
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      expect(r.result.data.vault.path).toBe(v);
      expect(r.result.data.vault.source).toBe("flag");
    }
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

Run: `npm run -w packages/cli test -- test/commands/lint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands/lint.ts`**

Create `packages/cli/src/commands/lint.ts`:

```typescript
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { runLinks } from "./links.js";
import { runTagAudit } from "./tag-audit.js";
import { runIndexCheck } from "./index-check.js";
import { runStale } from "./stale.js";
import { runPagesize } from "./pagesize.js";
import { runLogRotate } from "./log-rotate.js";
import { runOrphans } from "./orphans.js";

export interface LintInput {
  vault: string;
  source?: string;
  days: number;
  lines: number;
  logThreshold: number;
}

interface Bucket { kind: string; items: unknown[] }
export interface LintOutput {
  vault: { path: string; source: string };
  summary: { errors: number; warnings: number; info: number };
  by_severity: { error: Bucket[]; warning: Bucket[]; info: Bucket[] };
}

const ERROR_ORDER = ["broken_wikilinks", "invalid_frontmatter", "raw_drift", "tag_not_in_taxonomy"] as const;
const WARNING_ORDER = ["index_incomplete", "stale_page", "page_too_large", "log_rotate_needed", "contested", "orphans"] as const;
const INFO_ORDER = ["bridges", "low_confidence_single_source"] as const;

export async function runLint(input: LintInput): Promise<{ exitCode: number; result: Result<LintOutput> }> {
  const buckets: Record<string, unknown[]> = {};

  const links = await runLinks({ vault: input.vault });
  if (links.result.ok && links.result.data.broken.length > 0) buckets.broken_wikilinks = links.result.data.broken;
  if (!links.result.ok && links.result.error === "INVALID_FRONTMATTER") {
    buckets.invalid_frontmatter = [links.result.detail ?? {}];
  }

  const tags = await runTagAudit({ vault: input.vault });
  if (tags.result.ok && tags.result.data.violations.length > 0) buckets.tag_not_in_taxonomy = tags.result.data.violations;
  if (!tags.result.ok && tags.result.error === "INVALID_FRONTMATTER") {
    buckets.invalid_frontmatter = [...(buckets.invalid_frontmatter ?? []), tags.result.detail ?? {}];
  }

  const idx = await runIndexCheck({ vault: input.vault });
  if (idx.result.ok && (idx.result.data.missing_from_index.length > 0 || idx.result.data.ghost_entries.length > 0)) {
    buckets.index_incomplete = [{
      missing_from_index: idx.result.data.missing_from_index,
      ghost_entries: idx.result.data.ghost_entries
    }];
  }

  const stale = await runStale({ vault: input.vault, days: input.days });
  if (stale.result.ok && stale.result.data.stale.length > 0) buckets.stale_page = stale.result.data.stale;

  const pagesize = await runPagesize({ vault: input.vault, lines: input.lines });
  if (pagesize.result.ok && pagesize.result.data.oversized.length > 0) buckets.page_too_large = pagesize.result.data.oversized;

  const rotate = await runLogRotate({ vault: input.vault, threshold: input.logThreshold, apply: false });
  if (rotate.result.ok && rotate.exitCode === ExitCode.LOG_ROTATE_NEEDED) {
    buckets.log_rotate_needed = [{ entries: rotate.result.data.entries, threshold: rotate.result.data.threshold }];
  }

  const orphans = await runOrphans({ vault: input.vault });
  if (orphans.result.ok) {
    if (orphans.result.data.orphans.length > 0) buckets.orphans = orphans.result.data.orphans;
    if (orphans.result.data.bridges.length > 0) buckets.bridges = orphans.result.data.bridges;
  }

  const errorOut: Bucket[] = ERROR_ORDER.flatMap(k => buckets[k] ? [{ kind: k, items: buckets[k]! }] : []);
  const warningOut: Bucket[] = WARNING_ORDER.flatMap(k => buckets[k] ? [{ kind: k, items: buckets[k]! }] : []);
  const infoOut: Bucket[] = INFO_ORDER.flatMap(k => buckets[k] ? [{ kind: k, items: buckets[k]! }] : []);

  const summary = {
    errors: errorOut.reduce((n, b) => n + b.items.length, 0),
    warnings: warningOut.reduce((n, b) => n + b.items.length, 0),
    info: infoOut.reduce((n, b) => n + b.items.length, 0)
  };

  let exitCode: number = ExitCode.OK;
  if (summary.errors > 0) exitCode = ExitCode.LINT_HAS_ERRORS;
  else if (summary.warnings > 0 || summary.info > 0) exitCode = ExitCode.LINT_HAS_WARNINGS;

  return {
    exitCode,
    result: ok({
      vault: { path: input.vault, source: input.source ?? "flag" },
      summary,
      by_severity: { error: errorOut, warning: warningOut, info: infoOut }
    })
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/lint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/lint.ts packages/cli/test/commands/lint.test.ts
git commit -m "feat(cli): add skillwiki lint umbrella with severity grouping"
```

---

### Task 23: Wire `lint` into the CLI entry point

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Import and register**

In `packages/cli/src/cli.ts`, add:

```typescript
import { runLint } from "./commands/lint.js";
```

Append before `program.parseAsync`:

```typescript
program
  .command("lint [vault]")
  .option("--days <n>", "stale threshold", (s) => parseInt(s, 10), 90)
  .option("--lines <n>", "pagesize threshold", (s) => parseInt(s, 10), 200)
  .option("--log-threshold <n>", "log rotation threshold", (s) => parseInt(s, 10), 500)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runLint({
      vault: v.vault,
      source: vault ? "flag" : undefined,
      days: opts.days,
      lines: opts.lines,
      logThreshold: opts.logThreshold
    }));
  });
```

- [ ] **Step 2: Smoke test the build**

```bash
npm run -w packages/cli build
node packages/cli/dist/cli.js lint --help
```
Expected: help output mentioning `--days`, `--lines`, `--log-threshold`.

- [ ] **Step 3: Run the full CLI test suite**

Run: `npm run -w packages/cli test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): register skillwiki lint umbrella"
```

---

## Phase 15 — Hermes wire-compat smoke test

### Task 24: `wire-compat.test.ts` — Hermes-style assertions on the rendered vault

**Files:**
- Create: `packages/cli/test/commands/wire-compat.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/cli/test/commands/wire-compat.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";

const TEMPLATES = join(__dirname, "..", "..", "templates");

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("Hermes wire-compat (rendered vault)", () => {
  it("SCHEMA.md retains the section headers Hermes v2.1.0 references", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "wc-"));
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Hermes wire compat", taxonomy: undefined, lang: "en", force: false
    });
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    for (const header of ["## Domain", "## Tag Taxonomy", "## Page Thresholds", "## Update Policy", "## Conventions", "## Layers", "## Frontmatter"]) {
      expect(schema).toContain(header);
    }
    // Output Language section is additive (Hermes parsers ignore unknown sections — N13).
    expect(schema).toContain("## Output Language");
  });

  it("index.md retains the structural section names Hermes prompts expect", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "wc-"));
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    const idx = readFileSync(join(target, "index.md"), "utf8");
    for (const section of ["## Entities", "## Concepts", "## Comparisons", "## Queries", "## Projects", "## Meta"]) {
      expect(idx).toContain(section);
    }
  });

  it("log.md emits the structured `## [YYYY-MM-DD] action |` line shape", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "wc-"));
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    const log = readFileSync(join(target, "log.md"), "utf8");
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] create \| Wiki initialized$/m);
  });

  it("structural elements remain English even with WIKI_LANG=zh-Hant", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "wc-"));
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "中文 domain", taxonomy: undefined, lang: "chinese-traditional", force: false
    });
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("## Domain");
    expect(schema).toContain("## Tag Taxonomy");
    const idx = readFileSync(join(target, "index.md"), "utf8");
    expect(idx).toContain("## Entities");
    const log = readFileSync(join(target, "log.md"), "utf8");
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] create \| Wiki initialized$/m);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm run -w packages/cli test -- test/commands/wire-compat.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/commands/wire-compat.test.ts
git commit -m "test(cli): add Hermes wire-compat smoke test"
```

---

## Phase 16 — SKILL.md updates

### Task 25: Rewrite `wiki-init/SKILL.md`

**Files:**
- Modify: `packages/skills/wiki-init/SKILL.md`

- [ ] **Step 1: Replace the file contents**

Overwrite `packages/skills/wiki-init/SKILL.md` with:

```markdown
---
name: wiki-init
description: Bootstrap a CodeWiki vault — domain-aware SCHEMA.md, index.md, log.md, and ~/.skillwiki/.env binding. Use when starting a fresh vault.
---

# wiki-init

## When This Skill Activates

- User asks to create, build, or start a vault, wiki, or knowledge base.
- The resolved vault path (see step 0) does not yet contain SCHEMA.md.

## Pre-orientation reads

None for the first run.

## Steps

0. **Resolve target.** Run `skillwiki path --init-time` to see what target the CLI will pick. Confirm with the user, or override with `--target <dir>`.
1. Verify target is empty or has no SCHEMA.md.
2. Ask the domain question: "What knowledge domain will this vault cover? Be specific."
3. Propose a 10–15 tag taxonomy tailored to the domain. Confirm or accept the user's revision.
4. Ask the language question: "What language should generated page prose use? Default is `en`. Aliases like `chinese-traditional` or `zh-Hant` are accepted."
5. Run `skillwiki init --target <dir> --domain "<answer>" --taxonomy "<comma list>" --lang "<lang>"`.
6. **Suggest first sources.** Propose 3–5 initial sources (URLs, papers, articles) appropriate to the domain. Prompt the user to provide the first one to ingest, then hand off to wiki-ingest.

## Stop conditions

- Target non-empty and `--force` not consented.
- `~/.skillwiki/.env` already binds a different vault or language and `--force` not consented.

## Forbidden

- Modifying anything outside the target directory or `~/.skillwiki/.env`.
- Writing to `~/.hermes/.env` (read-only fallback).
- Running any LLM-driven content generation in this skill.
```

- [ ] **Step 2: Commit**

```bash
git add packages/skills/wiki-init/SKILL.md
git commit -m "docs(skills): rewrite wiki-init SKILL.md per Hermes-parity spec"
```

---

### Task 26: Rewrite `wiki-lint/SKILL.md`

**Files:**
- Modify: `packages/skills/wiki-lint/SKILL.md`

- [ ] **Step 1: Replace the file contents**

Overwrite `packages/skills/wiki-lint/SKILL.md` with:

```markdown
---
name: wiki-lint
description: Vault health check via the umbrella `skillwiki lint` subcommand. Read-only by default; rotation requires explicit user consent.
---

# wiki-lint

## When This Skill Activates

- User asks for a vault health report, lint, or audit.
- Periodic maintenance.

## Pre-orientation reads

Standard four reads.

## Steps

0. Resolve vault: `skillwiki path` (record source for context).
1. Run `skillwiki lint <vault>`. Read the JSON.
2. Reason over findings; present grouped by severity with concrete suggested actions per kind.
3. If `log_rotate_needed` is present and the user consents, run `skillwiki log-rotate <vault> --apply`. Otherwise leave alone.
4. Append one `log.md` entry summarizing the lint counts (errors/warnings/info).

## Stop conditions

None — lint reports all findings even on per-page errors.

## Forbidden

- Auto-rotating logs.
- Auto-updating sha256 fields.
- Modifying any page beyond the lint summary entry in `log.md`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/skills/wiki-lint/SKILL.md
git commit -m "docs(skills): collapse wiki-lint SKILL.md to umbrella call"
```

---

### Task 27: Add trigger list, step-0 resolution, and language preamble to `wiki-ingest/SKILL.md`

**Files:**
- Modify: `packages/skills/wiki-ingest/SKILL.md`

- [ ] **Step 1: Edit the file**

In `packages/skills/wiki-ingest/SKILL.md`, replace the existing `## When to invoke` section with:

```markdown
## When This Skill Activates

- User shares a URL, paste, or local file to capture in the vault.
- The output target is `entities/`, `concepts/`, `comparisons/`, or `queries/`.
- A vault is resolvable (see step 0).

## Output language

Run `skillwiki lang` at the start. Generate page-body prose, narrative sections, and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
```

Then in the `## Steps (in order — N6, N7, N8)` block, prepend a step 0:

```markdown
0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`. Use the resolved vault path for all writes; use the canonical language for all generated prose.
```

- [ ] **Step 2: Commit**

```bash
git add packages/skills/wiki-ingest/SKILL.md
git commit -m "docs(skills): add trigger list, step-0, and language preamble to wiki-ingest"
```

---

### Task 28: Same updates for `wiki-query/SKILL.md`

**Files:**
- Modify: `packages/skills/wiki-query/SKILL.md`

- [ ] **Step 1: Edit the file**

Apply the same three changes as Task 27, but with the trigger phrased as:

```markdown
## When This Skill Activates

- User asks a question that should be answered from vault contents.
- A vault is resolvable (see step 0).

## Output language

Run `skillwiki lang` at the start. Generate query-result prose and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
```

Prepend the same step 0:

```markdown
0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/skills/wiki-query/SKILL.md
git commit -m "docs(skills): add trigger list, step-0, and language preamble to wiki-query"
```

---

### Task 29: Same updates for `wiki-audit/SKILL.md`

**Files:**
- Modify: `packages/skills/wiki-audit/SKILL.md`

- [ ] **Step 1: Edit the file**

Apply the same shape, but with the trigger:

```markdown
## When This Skill Activates

- User asks for a per-page audit or invokes a pre-merge gate.
- A vault is resolvable (see step 0).

## Output language

Run `skillwiki lang` at the start. Generate audit narrative and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
```

Prepend the same step 0.

- [ ] **Step 2: Commit**

```bash
git add packages/skills/wiki-audit/SKILL.md
git commit -m "docs(skills): add trigger list, step-0, and language preamble to wiki-audit"
```

---

### Task 30: Same updates for `wiki-crystallize/SKILL.md`

**Files:**
- Modify: `packages/skills/wiki-crystallize/SKILL.md`

- [ ] **Step 1: Edit the file**

Trigger phrasing:

```markdown
## When This Skill Activates

- User asks to crystallize, consolidate, or promote draft material into typed-knowledge pages.
- A vault is resolvable (see step 0).

## Output language

Run `skillwiki lang` at the start. Generate consolidated page prose and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
```

Prepend the same step 0.

- [ ] **Step 2: Commit**

```bash
git add packages/skills/wiki-crystallize/SKILL.md
git commit -m "docs(skills): add trigger list, step-0, and language preamble to wiki-crystallize"
```

---

## Phase 17 — Final verification

### Task 31: Run the full test matrix and a release smoke check

**Files:**
- (none — verification only)

- [ ] **Step 1: Typecheck both workspaces**

```bash
npm run -w packages/shared typecheck
npm run -w packages/cli typecheck
```
Expected: zero errors.

- [ ] **Step 2: Run all tests**

```bash
npm run -w packages/shared test
npm run -w packages/cli test
```
Expected: every test green, including the wire-compat smoke and all 12 new test files.

- [ ] **Step 3: End-to-end CLI smoke**

```bash
npm run -w packages/cli build
TMP_VAULT=$(mktemp -d)
node packages/cli/dist/cli.js init --target "$TMP_VAULT" --domain "E2E" --lang chinese-traditional
node packages/cli/dist/cli.js path --init-time
node packages/cli/dist/cli.js lang --explain
node packages/cli/dist/cli.js lint "$TMP_VAULT"
```
Expected:
- `init` JSON shows `"lang":"zh-Hant"`, `"imported_from_hermes":false`, `created` includes `SCHEMA.md`, `index.md`, `log.md`, and the directory layout.
- `path --init-time` returns the same path (now from `skillwiki-dotenv`).
- `lang --explain` JSON shows the full chain ending at `skillwiki-dotenv`.
- `lint` exits 0 with empty severity buckets on the freshly initialized vault.

- [ ] **Step 4: Definition of Done re-check (manual)**

Open `docs/superpowers/specs/2026-05-03-hermes-parity-init-and-lint-design.md` and walk every checkbox in the "Definition of Done" section. For each, point at the task that satisfied it and note any gaps. Fix gaps inline (no separate task), commit, and re-run Steps 2 and 3.

- [ ] **Step 5: Final commit (only if any gap fix touched code)**

```bash
git status
# If clean, skip the commit. Otherwise:
git add -A
git commit -m "chore: address Definition of Done gap fixes"
```

---

## Spec coverage map (self-review)

| Spec section | Task |
|---|---|
| Decision 1 (init + lint full parity) | Tasks 12, 22 |
| Decision 2 (`skillwiki init` subcommand) | Tasks 12, 13 |
| Decision 3 (taxonomy in fenced YAML) | Tasks 5, 6 |
| Decision 4 (small subcommands + umbrella) | Tasks 14–19, 22 |
| Decision 5 (`log-rotate` warn-only / `--apply`) | Task 19 |
| Decision 6 (no Hermes runtime fallback; `NO_VAULT_CONFIGURED`) | Tasks 4, 9, 20 |
| Decision 7 (process env beats dotenv) | Tasks 3, 4 |
| Decision 8 (`ENV_WRITE_CONFLICT`) | Task 12 |
| Decision 9 (`init` always writes env) | Task 12 |
| Decision 10 (`WIKI_LANG` axis) | Tasks 3, 6, 7, 8, 10, 11, 12, 13, 27–30 |
| Wiki path resolution (init-time) | Task 4 |
| Wiki path resolution (runtime) | Task 4 |
| `skillwiki path` subcommand | Tasks 9, 11 |
| `skillwiki lang` subcommand | Tasks 10, 11 |
| `skillwiki init` flow | Tasks 12, 13 |
| Templates (SCHEMA, index, log) | Tasks 6, 7, 8 |
| `wiki-init` SKILL.md rewrite | Task 25 |
| Lint subcommand `links` | Task 14 |
| Lint subcommand `tag-audit` | Task 15 |
| Lint subcommand `index-check` | Task 16 |
| Lint subcommand `stale` | Task 17 |
| Lint subcommand `pagesize` | Task 18 |
| Lint subcommand `log-rotate` | Task 19 |
| `skillwiki lint` umbrella | Tasks 22, 23 |
| `wiki-lint` SKILL.md rewrite | Task 26 |
| Other `wiki-*` SKILL updates | Tasks 27–30 |
| Exit codes 15–25 | Task 1 |
| `orphans` vault-optional | Task 20 |
| Hermes wire-compat smoke | Task 24 |
| Definition of Done | Task 31 |
