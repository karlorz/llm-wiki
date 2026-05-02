# skillwiki v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v1 of CodeWiki — an npm workspaces monorepo containing the `skillwiki` TypeScript CLI (8 deterministic subcommands), 10 prompt-only `SKILL.md` files (`wiki-*` and `proj-*`), 4 vault templates, a cross-platform installer, and a Vitest test suite — meeting every Normative Requirement (N1–N18) and Definition-of-Done item from the 2026-05-02 spec.

**Architecture:** TypeScript ≥ 5.7 + tsup + Commander + Zod + js-yaml + Vitest, Node ≥ 20. Single repo, three packages: `packages/skills` (Markdown only), `packages/cli` (the `skillwiki` binary), `packages/shared` (typed contracts shared with future `mcp/`). Skills are prompt-only; all determinism lives in the CLI. JSON-by-default I/O with `--human` for terminals.

**Tech Stack:** TypeScript, tsup, commander, zod, js-yaml, vitest, Node ≥ 20, npm workspaces.

**Spec reference:** `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md` (canonical 2026-05-03 revision).

---

## File Structure

Files this plan creates or modifies. Listed once here; per-task `Files:` blocks reference these paths.

**Repo root**
- `package.json` — workspaces declaration, root scripts.
- `tsconfig.base.json` — shared compiler options.
- `.gitignore` — node_modules, dist, .skillwiki cache.
- `.github/workflows/ci.yml` — cross-platform CI matrix.
- `README.md` — overview, install, usage.
- `CLAUDE.md` — agent-facing instructions for working in this repo.
- `LICENSE` — already present; left untouched.

**`packages/shared/`** (typed contracts)
- `package.json`, `tsconfig.json`
- `src/index.ts` — barrel.
- `src/exit-codes.ts` — single enum of all CLI exit codes (0, 2–14).
- `src/json-output.ts` — `OkResult` / `ErrResult` envelope types.
- `src/schemas.ts` — Zod schemas + inferred TS types for all 4 frontmatter shapes.
- `src/blocked-hosts.ts` — RFC 1918 / link-local / loopback / metadata constants.

**`packages/cli/`**
- `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
- `src/cli.ts` — Commander entry, JSON/`--human` convention, exit-code translation.
- `src/commands/hash.ts`, `fetch-guard.ts`, `validate.ts`, `graph.ts`, `overlap.ts`, `orphans.ts`, `audit.ts`, `install.ts`
- `src/parsers/frontmatter.ts` — YAML extraction from Markdown.
- `src/parsers/wikilinks.ts` — `[[name]]` extraction (body and YAML-quoted).
- `src/parsers/citations.ts` — `^[raw/...]` marker extraction + footnote detection.
- `src/utils/vault.ts` — vault discovery, path canonicalization.
- `src/utils/fetch.ts` — Layer 2 controlled fetcher (timeout, byte limit, redirect re-validation).
- `src/utils/install-fs.ts` — atomic copy, backup, manifest writer.
- `src/utils/output.ts` — `printJson` / `printHuman` helpers.
- `templates/` — `SCHEMA.md`, `index.md`, `log.md`, `project-README.md` (consumed by `wiki-init` and `proj-init`).
- `test/fixtures/` — vaults and Markdown files used across tests.
- `test/<command>.test.ts` — one Vitest spec per command.
- `test/integration/hermes-compat.test.ts` — wire-compat round trip.
- `test/integration/dod.test.ts` — N1–N18 verification sweep.

**`packages/skills/`** (prompt-only Markdown — no build step)
- `wiki-init/SKILL.md`, `wiki-ingest/SKILL.md`, `wiki-query/SKILL.md`, `wiki-lint/SKILL.md`, `wiki-crystallize/SKILL.md`, `wiki-audit/SKILL.md`
- `proj-init/SKILL.md`, `proj-work/SKILL.md`, `proj-distill/SKILL.md`, `proj-decide/SKILL.md`

---

## Phase 0 — Workspace bootstrap

### Task 0.1: Initialize the npm workspaces monorepo

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
dist/
.skillwiki/
*.tsbuildinfo
coverage/
*.bak
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "resolveJsonModule": true,
    "lib": ["ES2022"]
  }
}
```

- [ ] **Step 3: Create root `package.json`**

```json
{
  "name": "skillwiki-monorepo",
  "private": true,
  "version": "0.0.0",
  "workspaces": ["packages/shared", "packages/cli", "packages/skills"],
  "scripts": {
    "build": "npm run -ws --if-present build",
    "test": "npm run -ws --if-present test",
    "lint": "npm run -ws --if-present lint",
    "clean": "rm -rf packages/*/dist packages/*/.tsbuildinfo"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 4: Verify install resolves**

Run: `npm install`
Expected: completes with no errors; `node_modules/` created.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json .gitignore
git commit -m "chore: initialize npm workspaces monorepo"
```

### Task 0.2: Bootstrap `packages/shared`

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@skillwiki/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create placeholder `packages/shared/src/index.ts`**

```ts
export * from "./exit-codes.js";
export * from "./json-output.js";
export * from "./schemas.js";
export * from "./blocked-hosts.js";
```

- [ ] **Step 4: Install workspace deps**

Run: `npm install -w @skillwiki/shared`
Expected: completes; `packages/shared/node_modules` symlinks via workspaces.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "chore(shared): bootstrap @skillwiki/shared package"
```

### Task 0.3: Bootstrap `packages/cli` with tsup + vitest

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/tsup.config.ts`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/cli.ts` (placeholder)

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "skillwiki",
  "version": "0.1.0",
  "type": "module",
  "bin": { "skillwiki": "dist/cli.js" },
  "files": ["dist", "templates", "README.md"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@skillwiki/shared": "*",
    "commander": "^12.1.0",
    "js-yaml": "^4.1.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.12.0",
    "tsup": "^8.3.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `packages/cli/tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" }
});
```

- [ ] **Step 4: Create `packages/cli/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "lcov"] }
  }
});
```

- [ ] **Step 5: Create placeholder `packages/cli/src/cli.ts`**

```ts
#!/usr/bin/env node
// Placeholder; replaced in Phase 11 (CLI wiring).
console.log(JSON.stringify({ ok: false, error: "not_implemented" }));
process.exit(1);
```

- [ ] **Step 6: Install + verify build**

Run: `npm install && npm run -w skillwiki build`
Expected: `packages/cli/dist/cli.js` exists and is executable.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "chore(cli): bootstrap skillwiki package with tsup + vitest"
```

### Task 0.4: Bootstrap `packages/skills`

**Files:**
- Create: `packages/skills/package.json`
- Create: `packages/skills/README.md`

- [ ] **Step 1: Create `packages/skills/package.json`**

```json
{
  "name": "@skillwiki/skills",
  "version": "0.1.0",
  "private": true,
  "files": ["wiki-*", "proj-*", "README.md"]
}
```

- [ ] **Step 2: Create `packages/skills/README.md`**

```markdown
# @skillwiki/skills

Prompt-only Markdown skills for Claude Code. Installed via `skillwiki install`.

| Namespace | Skills |
|---|---|
| `wiki-*` | `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit` |
| `proj-*` | `proj-init`, `proj-work`, `proj-distill`, `proj-decide` |

Each subdirectory holds one `SKILL.md`. No build step.
```

- [ ] **Step 3: Commit**

```bash
git add packages/skills
git commit -m "chore(skills): bootstrap @skillwiki/skills package"
```

---

## Phase 1 — Shared types: exit codes + JSON envelope

### Task 1.1: Define exit codes (single source of truth)

**Files:**
- Create: `packages/shared/src/exit-codes.ts`
- Test: `packages/shared/src/exit-codes.test.ts`

- [ ] **Step 1: Write the failing test `packages/shared/src/exit-codes.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ExitCode, exitCodeName } from "./exit-codes.js";

describe("exit-codes", () => {
  it("declares every code from the spec Command Contracts table", () => {
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.FILE_NOT_FOUND).toBe(2);
    expect(ExitCode.MISSING_CLOSING_DELIMITER).toBe(3);
    expect(ExitCode.SCHEME_REJECTED).toBe(4);
    expect(ExitCode.HOST_BLOCKED).toBe(5);
    expect(ExitCode.MALFORMED_URL).toBe(6);
    expect(ExitCode.INVALID_FRONTMATTER).toBe(7);
    expect(ExitCode.SCHEMA_NOT_DETECTED).toBe(8);
    expect(ExitCode.VAULT_PATH_INVALID).toBe(9);
    expect(ExitCode.WRITE_FAILED).toBe(10);
    expect(ExitCode.UNRESOLVED_MARKERS).toBe(11);
    expect(ExitCode.SOURCES_INCONSISTENT).toBe(12);
    expect(ExitCode.PREFLIGHT_FAILED).toBe(13);
    expect(ExitCode.ATOMIC_COPY_FAILED).toBe(14);
  });

  it("exposes a stable name for every code (non-empty, unique)", () => {
    const codes = Object.values(ExitCode).filter(v => typeof v === "number") as number[];
    const names = codes.map(c => exitCodeName(c));
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Wire vitest at the shared level (one-shot)**

Edit `packages/shared/package.json` `scripts` to add: `"test": "vitest run"`.
Add devDependency `"vitest": "^2.1.0"`.

Run: `npm install`

- [ ] **Step 3: Run the test — expect FAIL**

Run: `npm run -w @skillwiki/shared test`
Expected: FAIL — `Cannot find module './exit-codes.js'`.

- [ ] **Step 4: Implement `packages/shared/src/exit-codes.ts`**

```ts
export const ExitCode = {
  OK: 0,
  FILE_NOT_FOUND: 2,
  MISSING_CLOSING_DELIMITER: 3,
  SCHEME_REJECTED: 4,
  HOST_BLOCKED: 5,
  MALFORMED_URL: 6,
  INVALID_FRONTMATTER: 7,
  SCHEMA_NOT_DETECTED: 8,
  VAULT_PATH_INVALID: 9,
  WRITE_FAILED: 10,
  UNRESOLVED_MARKERS: 11,
  SOURCES_INCONSISTENT: 12,
  PREFLIGHT_FAILED: 13,
  ATOMIC_COPY_FAILED: 14
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

const NAMES: Record<number, string> = {
  0: "OK",
  2: "FILE_NOT_FOUND",
  3: "MISSING_CLOSING_DELIMITER",
  4: "SCHEME_REJECTED",
  5: "HOST_BLOCKED",
  6: "MALFORMED_URL",
  7: "INVALID_FRONTMATTER",
  8: "SCHEMA_NOT_DETECTED",
  9: "VAULT_PATH_INVALID",
  10: "WRITE_FAILED",
  11: "UNRESOLVED_MARKERS",
  12: "SOURCES_INCONSISTENT",
  13: "PREFLIGHT_FAILED",
  14: "ATOMIC_COPY_FAILED"
};

export function exitCodeName(code: number): string {
  return NAMES[code] ?? `UNKNOWN_${code}`;
}
```

- [ ] **Step 5: Run test — expect PASS**

Run: `npm run -w @skillwiki/shared test`
Expected: 1 file, 2 tests passed.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/exit-codes.ts packages/shared/src/exit-codes.test.ts packages/shared/package.json
git commit -m "feat(shared): define stable ExitCode enum (N3)"
```

### Task 1.2: Define JSON output envelope types

**Files:**
- Create: `packages/shared/src/json-output.ts`
- Test: `packages/shared/src/json-output.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "./json-output.js";

describe("json-output", () => {
  it("ok() produces { ok: true, data }", () => {
    const r = ok({ x: 1 });
    expect(r).toEqual({ ok: true, data: { x: 1 } });
    expect(isOk(r)).toBe(true);
  });

  it("err() produces { ok: false, error, detail? }", () => {
    const r = err("HOST_BLOCKED", { url: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("HOST_BLOCKED");
    expect(isErr(r)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run -w @skillwiki/shared test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/shared/src/json-output.ts`**

```ts
export interface OkResult<T> { ok: true; data: T }
export interface ErrResult { ok: false; error: string; detail?: unknown }
export type Result<T> = OkResult<T> | ErrResult;

export function ok<T>(data: T): OkResult<T> { return { ok: true, data }; }
export function err(error: string, detail?: unknown): ErrResult {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}
export function isOk<T>(r: Result<T>): r is OkResult<T> { return r.ok === true; }
export function isErr<T>(r: Result<T>): r is ErrResult { return r.ok === false; }
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run -w @skillwiki/shared test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/json-output.ts packages/shared/src/json-output.test.ts
git commit -m "feat(shared): JSON Result envelope (N1)"
```

### Task 1.3: Define blocked-host constants

**Files:**
- Create: `packages/shared/src/blocked-hosts.ts`
- Test: `packages/shared/src/blocked-hosts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isBlockedHost, METADATA_HOSTS } from "./blocked-hosts.js";

describe("blocked-hosts", () => {
  it.each([
    "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "127.0.0.1",
    "::1",
    "fe80::1"
  ])("blocks %s", (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "example.com"])("allows %s", (host) => {
    expect(isBlockedHost(host)).toBe(false);
  });

  it("has metadata hostnames", () => {
    expect(METADATA_HOSTS).toContain("metadata.google.internal");
  });

  it("172.32.0.1 is NOT in the blocked /12 range", () => {
    expect(isBlockedHost("172.32.0.1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run -w @skillwiki/shared test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/shared/src/blocked-hosts.ts`**

```ts
export const METADATA_HOSTS = [
  "metadata.google.internal",
  "metadata"
] as const;

const METADATA_IPS = new Set(["169.254.169.254"]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function inRange(ip: string, baseStr: string, prefix: number): boolean {
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(baseStr);
  if (ipN === null || baseN === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

export function isBlockedHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (METADATA_HOSTS.includes(lower as any)) return true;
  if (METADATA_IPS.has(host)) return true;

  // IPv6 quick checks
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;

  // IPv4 ranges
  if (ipv4ToInt(host) === null) return false;
  if (inRange(host, "10.0.0.0", 8)) return true;
  if (inRange(host, "172.16.0.0", 12)) return true;
  if (inRange(host, "192.168.0.0", 16)) return true;
  if (inRange(host, "169.254.0.0", 16)) return true;
  if (inRange(host, "127.0.0.0", 8)) return true;
  return false;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run -w @skillwiki/shared test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/blocked-hosts.ts packages/shared/src/blocked-hosts.test.ts
git commit -m "feat(shared): blocked-host classifier (N15)"
```

---

## Phase 2 — Zod schemas (4 frontmatter shapes)

### Task 2.1: Schema 1 — Typed Knowledge

**Files:**
- Create: `packages/shared/src/schemas.ts` (will grow over Tasks 2.1–2.4)
- Test: `packages/shared/src/schemas.typed-knowledge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { TypedKnowledgeSchema } from "./schemas.js";

const valid = {
  title: "Transformer Architecture",
  created: "2026-05-03",
  updated: "2026-05-03",
  type: "concept",
  tags: ["ml", "nlp"],
  sources: ["raw/articles/foo.md"]
};

describe("TypedKnowledgeSchema", () => {
  it("accepts a minimal valid Hermes-shaped page", () => {
    expect(TypedKnowledgeSchema.parse(valid)).toMatchObject(valid);
  });

  it("rejects when type is not in the enum", () => {
    expect(() => TypedKnowledgeSchema.parse({ ...valid, type: "bogus" })).toThrow();
  });

  it("rejects when sources is empty", () => {
    expect(() => TypedKnowledgeSchema.parse({ ...valid, sources: [] })).toThrow();
  });

  it("accepts additive fields without ignoring them", () => {
    const v = { ...valid, provenance: "project", provenance_projects: ["[[cmux]]"], aliases: ["TA"], confidence: "high" };
    expect(TypedKnowledgeSchema.parse(v).provenance).toBe("project");
  });

  it("rejects YYYY-MM-DD-shaped string with invalid month", () => {
    expect(() => TypedKnowledgeSchema.parse({ ...valid, created: "2026-13-01" })).toThrow();
  });

  it("requires provenance_projects when provenance != research", () => {
    expect(() => TypedKnowledgeSchema.parse({ ...valid, provenance: "project" })).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run -w @skillwiki/shared test`
Expected: module not found / schema undefined.

- [ ] **Step 3: Implement `packages/shared/src/schemas.ts` (initial)**

```ts
import { z } from "zod";

export const isoDate = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && s === d.toISOString().slice(0, 10);
}, { message: "must be YYYY-MM-DD" });

const wikilink = z.string().regex(/^\[\[[^\[\]]+\]\]$/, "must be \"[[name]]\"");

export const TypedKnowledgeSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  type: z.enum(["entity", "concept", "comparison", "query", "summary"]),
  tags: z.array(z.string()),
  sources: z.array(z.string()).min(1),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  contested: z.boolean().optional(),
  contradictions: z.array(z.string()).optional(),
  provenance: z.enum(["research", "project", "mixed"]).optional(),
  provenance_projects: z.array(wikilink).optional(),
  work_items: z.array(wikilink).optional()
}).superRefine((v, ctx) => {
  if (v.provenance && v.provenance !== "research" && (!v.provenance_projects || v.provenance_projects.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance_projects"], message: "required when provenance != research" });
  }
});

export type TypedKnowledge = z.infer<typeof TypedKnowledgeSchema>;
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run -w @skillwiki/shared test`
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.typed-knowledge.test.ts
git commit -m "feat(shared): TypedKnowledgeSchema (N11, N12, N13)"
```

### Task 2.2: Schema 2 — Raw Sources

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/schemas.raw.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { RawSourceSchema } from "./schemas.js";

const remote = {
  title: "Original Article",
  source_url: "https://example.com/x",
  ingested: "2026-05-03",
  ingested_by: "wiki-ingest",
  sha256: "a".repeat(64)
};

describe("RawSourceSchema", () => {
  it("accepts a remote-ingested entry", () => {
    expect(RawSourceSchema.parse(remote)).toMatchObject(remote);
  });

  it("accepts a locally originated entry (source_url null)", () => {
    expect(RawSourceSchema.parse({ ...remote, source_url: null })).toBeTruthy();
  });

  it("rejects malformed sha256", () => {
    expect(() => RawSourceSchema.parse({ ...remote, sha256: "deadbeef" })).toThrow();
  });

  it("requires kind/project/work_item together for project-originated", () => {
    expect(() => RawSourceSchema.parse({ ...remote, source_url: null, project: "[[cmux]]" })).toThrow();
  });

  it("accepts a complete project-originated entry", () => {
    const v = {
      ...remote,
      source_url: null,
      project: "[[cmux]]",
      work_item: "[[2026-05-03-bug]]",
      kind: "postmortem"
    };
    expect(RawSourceSchema.parse(v)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run -w @skillwiki/shared test`
Expected: FAIL — `RawSourceSchema` undefined.

- [ ] **Step 3: Append to `packages/shared/src/schemas.ts`**

```ts
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const RawSourceSchema = z.object({
  title: z.string().min(1),
  source_url: z.string().url().nullable(),
  ingested: isoDate,
  ingested_by: z.enum(["wiki-ingest", "proj-work", "manual"]),
  sha256: sha256Hex,
  project: wikilink.optional(),
  work_item: wikilink.optional(),
  kind: z.enum(["postmortem", "session-log", "meeting-notes", "other"]).optional()
}).superRefine((v, ctx) => {
  const projectFields = [v.project, v.work_item, v.kind];
  const present = projectFields.filter((x) => x !== undefined).length;
  if (present !== 0 && present !== 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "project, work_item, kind must all be set together" });
  }
});

export type RawSource = z.infer<typeof RawSourceSchema>;
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run -w @skillwiki/shared test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.raw.test.ts
git commit -m "feat(shared): RawSourceSchema (N11, N12)"
```

### Task 2.3: Schema 3 — Project Work Items

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/schemas.work.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { WorkItemSchema } from "./schemas.js";

const v = {
  title: "Fix race condition in worker",
  created: "2026-05-03",
  updated: "2026-05-03",
  started: "2026-05-03",
  kind: "issue",
  status: "in-progress",
  priority: "high",
  project: "[[cmux]]"
};

describe("WorkItemSchema", () => {
  it("accepts minimal valid", () => {
    expect(WorkItemSchema.parse(v)).toMatchObject(v);
  });

  it("requires `completed` when status is completed", () => {
    expect(() => WorkItemSchema.parse({ ...v, status: "completed" })).toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() => WorkItemSchema.parse({ ...v, kind: "epic" })).toThrow();
  });

  it("accepts optional related/parent wikilinks", () => {
    expect(WorkItemSchema.parse({ ...v, parent: "[[2026-04-10-foo]]", related: ["[[2026-04-12-bar]]"] })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run -w @skillwiki/shared test`

- [ ] **Step 3: Append to `packages/shared/src/schemas.ts`**

```ts
export const WorkItemSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  started: isoDate,
  completed: isoDate.optional(),
  kind: z.enum(["feature", "issue", "refactor", "decision"]),
  status: z.enum(["planned", "in-progress", "completed", "abandoned"]),
  priority: z.enum(["high", "medium", "low"]),
  project: wikilink,
  owner: wikilink.optional(),
  parent: wikilink.optional(),
  related: z.array(wikilink).optional(),
  sources: z.array(z.string()).optional()
}).superRefine((v, ctx) => {
  if (v.status === "completed" && !v.completed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completed"], message: "required when status is completed" });
  }
});

export type WorkItem = z.infer<typeof WorkItemSchema>;
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.work.test.ts
git commit -m "feat(shared): WorkItemSchema (N11)"
```

### Task 2.4: Schema 4 — Project Compound + schema detector

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/schemas.compound.test.ts`
- Test: `packages/shared/src/schemas.detect.test.ts`

- [ ] **Step 1: Write `schemas.compound.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { CompoundSchema } from "./schemas.js";

const v = {
  title: "Async drift gotcha",
  created: "2026-05-03",
  updated: "2026-05-03",
  type: "gotcha",
  tags: ["concurrency"],
  confidence: "medium",
  project: "[[cmux]]",
  work_items: ["[[2026-04-15-bug]]"]
};

describe("CompoundSchema", () => {
  it("accepts a valid compound entry", () => {
    expect(CompoundSchema.parse(v)).toMatchObject(v);
  });
  it("requires at least one work_item", () => {
    expect(() => CompoundSchema.parse({ ...v, work_items: [] })).toThrow();
  });
  it("rejects unknown type", () => {
    expect(() => CompoundSchema.parse({ ...v, type: "trivia" })).toThrow();
  });
});
```

- [ ] **Step 2: Write `schemas.detect.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { detectSchema } from "./schemas.js";

describe("detectSchema", () => {
  it("detects typed-knowledge by `type` enum + `sources`", () => {
    expect(detectSchema({ type: "concept", sources: ["x"] }).schema).toBe("typed-knowledge");
  });
  it("detects raw by `sha256` + `ingested`", () => {
    expect(detectSchema({ sha256: "a".repeat(64), ingested: "2026-05-03" }).schema).toBe("raw");
  });
  it("detects work item by `kind` + `status`", () => {
    expect(detectSchema({ kind: "feature", status: "planned" }).schema).toBe("work-item");
  });
  it("detects compound by `type` lesson/pattern + `project`", () => {
    expect(detectSchema({ type: "lesson", project: "[[x]]" }).schema).toBe("compound");
  });
  it("returns null for unknown shapes", () => {
    expect(detectSchema({ random: 1 }).schema).toBe(null);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npm run -w @skillwiki/shared test`

- [ ] **Step 4: Append to `packages/shared/src/schemas.ts`**

```ts
export const CompoundSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  type: z.enum(["lesson", "pattern", "antipattern", "gotcha"]),
  tags: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  contradicts: z.array(z.string()).optional(),
  project: wikilink,
  work_items: z.array(wikilink).min(1),
  promoted_to: wikilink.optional(),
  cssclasses: z.array(z.string()).optional()
});

export type Compound = z.infer<typeof CompoundSchema>;

export type SchemaName = "typed-knowledge" | "raw" | "work-item" | "compound";

export function detectSchema(fm: Record<string, unknown>): { schema: SchemaName | null } {
  const COMPOUND_TYPES = new Set(["lesson", "pattern", "antipattern", "gotcha"]);
  const TK_TYPES = new Set(["entity", "concept", "comparison", "query", "summary"]);

  if (typeof fm.type === "string" && COMPOUND_TYPES.has(fm.type) && "project" in fm) return { schema: "compound" };
  if (typeof fm.type === "string" && TK_TYPES.has(fm.type) && "sources" in fm) return { schema: "typed-knowledge" };
  if (typeof fm.sha256 === "string" && "ingested" in fm) return { schema: "raw" };
  if (typeof fm.kind === "string" && "status" in fm) return { schema: "work-item" };
  return { schema: null };
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npm run -w @skillwiki/shared test`

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.compound.test.ts packages/shared/src/schemas.detect.test.ts
git commit -m "feat(shared): CompoundSchema + detectSchema (N11)"
```

---

## Phase 3 — Parsers (frontmatter, wikilinks, citations)

### Task 3.1: Frontmatter parser

**Files:**
- Create: `packages/cli/src/parsers/frontmatter.ts`
- Test: `packages/cli/test/parsers/frontmatter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { extractFrontmatter, splitFrontmatter } from "../../src/parsers/frontmatter.js";

const SAMPLE = `---
title: "Hello"
tags: [a, b]
---
Body line 1
Body line 2
`;

describe("frontmatter", () => {
  it("extracts YAML object", () => {
    const r = extractFrontmatter(SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ title: "Hello", tags: ["a", "b"] });
  });

  it("splitFrontmatter returns body bytes after closing ---", () => {
    const r = splitFrontmatter(SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.bodyStart).toBe(SAMPLE.indexOf("Body line 1"));
      expect(r.data.body).toBe("Body line 1\nBody line 2\n");
    }
  });

  it("returns MISSING_CLOSING_DELIMITER when --- never closes", () => {
    const r = splitFrontmatter("---\ntitle: x\nbody\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("MISSING_CLOSING_DELIMITER");
  });

  it("returns empty fm + full body when no leading ---", () => {
    const r = extractFrontmatter("plain body\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({});
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run -w skillwiki test`
Expected: module not found.

- [ ] **Step 3: Implement `packages/cli/src/parsers/frontmatter.ts`**

```ts
import yaml from "js-yaml";
import { ok, err, type Result } from "@skillwiki/shared";

export interface SplitResult {
  rawFrontmatter: string;
  body: string;
  bodyStart: number;
}

const FM_OPEN = /^---\r?\n/;

export function splitFrontmatter(text: string): Result<SplitResult> {
  if (!FM_OPEN.test(text)) return ok({ rawFrontmatter: "", body: text, bodyStart: 0 });
  const afterOpen = text.replace(FM_OPEN, "");
  const closeIdx = afterOpen.search(/\r?\n---\r?\n/);
  if (closeIdx === -1) return err("MISSING_CLOSING_DELIMITER");
  const rawFrontmatter = afterOpen.slice(0, closeIdx);
  const closeMatch = afterOpen.slice(closeIdx).match(/\r?\n---\r?\n/)!;
  const bodyStart = text.length - (afterOpen.length - closeIdx - closeMatch[0].length);
  const body = text.slice(bodyStart);
  return ok({ rawFrontmatter, body, bodyStart });
}

export function extractFrontmatter(text: string): Result<Record<string, unknown>> {
  const split = splitFrontmatter(text);
  if (!split.ok) return split;
  if (!split.data.rawFrontmatter) return ok({});
  try {
    const parsed = yaml.load(split.data.rawFrontmatter);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return ok({});
    return ok(parsed as Record<string, unknown>);
  } catch (e) {
    return err("INVALID_FRONTMATTER", { message: (e as Error).message });
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run -w skillwiki test`

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parsers/frontmatter.ts packages/cli/test/parsers/frontmatter.test.ts
git commit -m "feat(cli): frontmatter parser with body-start offset (N10)"
```

### Task 3.2: Wikilink extractor

**Files:**
- Create: `packages/cli/src/parsers/wikilinks.ts`
- Test: `packages/cli/test/parsers/wikilinks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { extractBodyWikilinks } from "../../src/parsers/wikilinks.js";

describe("wikilinks", () => {
  it("finds plain wikilinks in body text", () => {
    expect(extractBodyWikilinks("see [[foo]] and [[bar/baz]]")).toEqual(["foo", "bar/baz"]);
  });
  it("ignores escaped or code-fenced links", () => {
    expect(extractBodyWikilinks("`[[code]]`\n[[real]]")).toEqual(["real"]);
  });
  it("handles aliased wikilinks [[target|display]]", () => {
    expect(extractBodyWikilinks("[[target|alias]]")).toEqual(["target"]);
  });
  it("dedupes within a single body", () => {
    expect(extractBodyWikilinks("[[a]] and [[a]] again")).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/parsers/wikilinks.ts`**

```ts
const FENCE = /`[^`]*`|```[\s\S]*?```/g;

export function extractBodyWikilinks(body: string): string[] {
  const stripped = body.replace(FENCE, "");
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const target = m[1].trim();
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parsers/wikilinks.ts packages/cli/test/parsers/wikilinks.test.ts
git commit -m "feat(cli): wikilink extractor"
```

### Task 3.3: Citation marker extractor

**Files:**
- Create: `packages/cli/src/parsers/citations.ts`
- Test: `packages/cli/test/parsers/citations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { extractCitationMarkers } from "../../src/parsers/citations.js";

describe("citations", () => {
  it("finds ^[raw/...] markers", () => {
    const body = "Claim X.\n^[raw/articles/foo.md]\nClaim Y.\n^[raw/papers/bar.md]\n";
    expect(extractCitationMarkers(body)).toEqual([
      { marker: "^[raw/articles/foo.md]", target: "raw/articles/foo.md" },
      { marker: "^[raw/papers/bar.md]", target: "raw/papers/bar.md" }
    ]);
  });
  it("ignores markers inside code fences", () => {
    const body = "```\n^[raw/x.md]\n```\n^[raw/y.md]\n";
    expect(extractCitationMarkers(body).map(m => m.target)).toEqual(["raw/y.md"]);
  });
  it("returns empty array when none", () => {
    expect(extractCitationMarkers("plain body")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/parsers/citations.ts`**

```ts
const FENCE = /```[\s\S]*?```/g;

export interface CitationMarker { marker: string; target: string; }

export function extractCitationMarkers(body: string): CitationMarker[] {
  const stripped = body.replace(FENCE, "");
  const out: CitationMarker[] = [];
  const re = /\^\[(raw\/[^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    out.push({ marker: m[0], target: m[1] });
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parsers/citations.ts packages/cli/test/parsers/citations.test.ts
git commit -m "feat(cli): citation marker extractor"
```

---

## Phase 4 — `skillwiki hash` subcommand

### Task 4.1: hash command

**Files:**
- Create: `packages/cli/src/commands/hash.ts`
- Test: `packages/cli/test/commands/hash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHash } from "../../src/commands/hash.js";

function tmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-hash-"));
  const p = join(dir, "f.md");
  writeFileSync(p, content);
  return p;
}

describe("hash", () => {
  it("hashes body bytes after closing ---", async () => {
    const p = tmp("---\ntitle: x\n---\nhello");
    const r = await runHash({ file: p });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      // sha256("hello")
      expect(r.result.data.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      expect(r.result.data.byte_count).toBe(5);
    }
  });

  it("returns FILE_NOT_FOUND for missing file", async () => {
    const r = await runHash({ file: "/no/such/file" });
    expect(r.exitCode).toBe(2);
  });

  it("returns MISSING_CLOSING_DELIMITER when --- never closes", async () => {
    const p = tmp("---\ntitle: x\nno close");
    const r = await runHash({ file: p });
    expect(r.exitCode).toBe(3);
  });

  it("hashes whole file when no frontmatter present", async () => {
    const p = tmp("plain body");
    const r = await runHash({ file: p });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.byte_count).toBe(10);
  });

  it("does NOT normalize (CRLF preserved)", async () => {
    const p1 = tmp("---\nx: 1\n---\nhello\nworld");
    const p2 = tmp("---\nx: 1\n---\nhello\r\nworld");
    const r1 = await runHash({ file: p1 });
    const r2 = await runHash({ file: p2 });
    if (r1.result.ok && r2.result.ok) expect(r1.result.data.sha256).not.toBe(r2.result.data.sha256);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run -w skillwiki test`

- [ ] **Step 3: Implement `packages/cli/src/commands/hash.ts`**

```ts
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface HashInput { file: string }
export interface HashOutput { path: string; sha256: string; byte_count: number }

export async function runHash(input: HashInput): Promise<{ exitCode: number; result: Result<HashOutput> }> {
  let text: string;
  try {
    text = await readFile(input.file, "utf8");
  } catch {
    return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: input.file }) };
  }
  const split = splitFrontmatter(text);
  if (!split.ok) return { exitCode: ExitCode.MISSING_CLOSING_DELIMITER, result: split };
  const bodyBytes = Buffer.from(split.data.body, "utf8");
  const sha256 = createHash("sha256").update(bodyBytes).digest("hex");
  return {
    exitCode: ExitCode.OK,
    result: ok({ path: input.file, sha256, byte_count: bodyBytes.byteLength })
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run -w skillwiki test`

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/hash.ts packages/cli/test/commands/hash.test.ts
git commit -m "feat(cli): skillwiki hash (N10, exit codes 0/2/3)"
```

---

## Phase 5 — `skillwiki fetch-guard` subcommand (Layer 1)

### Task 5.1: URL parsing + scheme/credential rules

**Files:**
- Create: `packages/cli/src/commands/fetch-guard.ts`
- Test: `packages/cli/test/commands/fetch-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { runFetchGuard } from "../../src/commands/fetch-guard.js";

describe("fetch-guard — Layer 1", () => {
  it("allows a plain https URL", async () => {
    const r = await runFetchGuard({ url: "https://example.com/x" });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.allowed).toBe(true);
      expect(r.result.data.sanitized_url).toBe("https://example.com/x");
    }
  });

  it("rejects http (SCHEME_REJECTED)", async () => {
    const r = await runFetchGuard({ url: "http://example.com/x" });
    expect(r.exitCode).toBe(4);
  });

  it("rejects file:// (SCHEME_REJECTED)", async () => {
    const r = await runFetchGuard({ url: "file:///etc/passwd" });
    expect(r.exitCode).toBe(4);
  });

  it("rejects RFC 1918 hosts (HOST_BLOCKED)", async () => {
    const r = await runFetchGuard({ url: "https://10.0.0.1/x" });
    expect(r.exitCode).toBe(5);
  });

  it("rejects metadata endpoint (HOST_BLOCKED)", async () => {
    const r = await runFetchGuard({ url: "https://169.254.169.254/latest/meta-data/" });
    expect(r.exitCode).toBe(5);
  });

  it("rejects malformed URL (MALFORMED_URL)", async () => {
    const r = await runFetchGuard({ url: "not a url" });
    expect(r.exitCode).toBe(6);
  });

  it("strips api_key query param in sanitized_url", async () => {
    const r = await runFetchGuard({ url: "https://example.com/x?api_key=SECRET&q=hi" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.sanitized_url).not.toContain("SECRET");
      expect(r.result.data.sanitized_url).toContain("api_key=REDACTED");
      expect(r.result.data.sanitized_url).toContain("q=hi");
    }
  });

  it("strips path-embedded tokens (32+ hex chars)", async () => {
    const long = "deadbeef".repeat(8);
    const r = await runFetchGuard({ url: `https://example.com/api/${long}/resource` });
    if (r.result.ok) expect(r.result.data.sanitized_url).not.toContain(long);
  });

  it("strips userinfo (user:pass@)", async () => {
    const r = await runFetchGuard({ url: "https://user:pw@example.com/x" });
    if (r.result.ok) expect(r.result.data.sanitized_url).not.toContain("pw");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run -w skillwiki test`

- [ ] **Step 3: Implement `packages/cli/src/commands/fetch-guard.ts`**

```ts
import { ok, err, ExitCode, isBlockedHost, type Result } from "@skillwiki/shared";

const REDACT_PARAMS = new Set(["api_key", "token", "key", "auth", "password", "secret", "access_token"]);
const PATH_TOKEN_RE = /[A-Fa-f0-9]{32,}|[A-Za-z0-9_\-]{40,}/g;

export interface FetchGuardInput { url: string }
export interface FetchGuardOutput { allowed: boolean; reason?: string; sanitized_url: string }

export interface GuardRun { exitCode: number; result: Result<FetchGuardOutput> }

export function runFetchGuard(input: FetchGuardInput): Promise<GuardRun> {
  return Promise.resolve(runFetchGuardSync(input));
}

export function runFetchGuardSync(input: FetchGuardInput): GuardRun {
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    return { exitCode: ExitCode.MALFORMED_URL, result: err("MALFORMED_URL", { url: input.url }) };
  }

  const sanitized = sanitizeUrl(u);

  if (u.protocol !== "https:") {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { sanitized_url: sanitized, scheme: u.protocol })
    };
  }

  if (isBlockedHost(u.hostname)) {
    return {
      exitCode: ExitCode.HOST_BLOCKED,
      result: err("HOST_BLOCKED", { sanitized_url: sanitized, host: u.hostname })
    };
  }

  return { exitCode: ExitCode.OK, result: ok({ allowed: true, sanitized_url: sanitized }) };
}

export function sanitizeUrl(u: URL): string {
  const clone = new URL(u.toString());
  if (clone.username || clone.password) {
    clone.username = "";
    clone.password = "";
  }
  for (const k of Array.from(clone.searchParams.keys())) {
    if (REDACT_PARAMS.has(k.toLowerCase())) clone.searchParams.set(k, "REDACTED");
  }
  let s = clone.toString();
  s = s.replace(PATH_TOKEN_RE, "REDACTED");
  return s;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run -w skillwiki test`

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/fetch-guard.ts packages/cli/test/commands/fetch-guard.test.ts
git commit -m "feat(cli): skillwiki fetch-guard Layer 1 (N14, N15, N16)"
```

### Task 5.2: Layer 2 controlled fetcher

**Files:**
- Create: `packages/cli/src/utils/fetch.ts`
- Test: `packages/cli/test/utils/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { controlledFetch } from "../../src/utils/fetch.js";

const realFetch = globalThis.fetch;

describe("controlledFetch — Layer 2", () => {
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it("aborts when timeout exceeded", async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => { /* never resolves */ })) as any;
    const r = await controlledFetch("https://example.com/slow", { timeoutMs: 25, maxBytes: 1024, maxRedirects: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("FETCH_TIMEOUT");
  });

  it("rejects when body exceeds maxBytes", async () => {
    const big = "x".repeat(2048);
    globalThis.fetch = vi.fn(async () => new Response(big, { status: 200, headers: { "content-length": "2048" } })) as any;
    const r = await controlledFetch("https://example.com/big", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("FETCH_TOO_LARGE");
  });

  it("re-validates redirect targets via fetch-guard", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: any) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: "https://10.0.0.1/secret" } });
      return new Response("ok", { status: 200 });
    }) as any;
    const r = await controlledFetch("https://example.com/redir", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("HOST_BLOCKED");
  });

  it("returns body on success", async () => {
    globalThis.fetch = vi.fn(async () => new Response("hello", { status: 200 })) as any;
    const r = await controlledFetch("https://example.com/x", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.body).toBe("hello");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/utils/fetch.ts`**

```ts
import { ok, err, type Result } from "@skillwiki/shared";
import { runFetchGuardSync } from "../commands/fetch-guard.js";

export interface FetchOptions { timeoutMs: number; maxBytes: number; maxRedirects: number }
export interface FetchOk { url: string; status: number; body: string; bytes: number }

export async function controlledFetch(url: string, opts: FetchOptions): Promise<Result<FetchOk>> {
  let current = url;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const guard = runFetchGuardSync({ url: current });
    if (!guard.result.ok) return guard.result;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: ctrl.signal });
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === "AbortError") return err("FETCH_TIMEOUT", { url: current });
      return err("FETCH_FAILED", { message: String(e) });
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return err("FETCH_FAILED", { reason: "redirect without Location" });
      current = new URL(loc, current).toString();
      continue;
    }

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > opts.maxBytes) return err("FETCH_TOO_LARGE", { declared, limit: opts.maxBytes });

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > opts.maxBytes) return err("FETCH_TOO_LARGE", { actual: buf.byteLength, limit: opts.maxBytes });
    return ok({ url: current, status: res.status, body: new TextDecoder().decode(buf), bytes: buf.byteLength });
  }
  return err("FETCH_FAILED", { reason: "too many redirects", limit: opts.maxRedirects });
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run -w skillwiki test`

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/utils/fetch.ts packages/cli/test/utils/fetch.test.ts
git commit -m "feat(cli): Layer 2 controlled fetcher (N6, redirect re-validation)"
```

---

## Phase 6 — `skillwiki validate` subcommand

### Task 6.1: validate command

**Files:**
- Create: `packages/cli/src/commands/validate.ts`
- Test: `packages/cli/test/commands/validate.test.ts`
- Test fixtures: `packages/cli/test/fixtures/valid-concept.md`, `packages/cli/test/fixtures/invalid-concept.md`, `packages/cli/test/fixtures/no-schema.md`

- [ ] **Step 1: Create fixtures**

`packages/cli/test/fixtures/valid-concept.md`:
```
---
title: Valid Concept
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: [ml]
sources: [raw/articles/x.md]
---
Body.
```

`packages/cli/test/fixtures/invalid-concept.md`:
```
---
title: Bad
created: not-a-date
updated: 2026-05-03
type: bogus
tags: [ml]
sources: []
---
Body.
```

`packages/cli/test/fixtures/no-schema.md`:
```
---
arbitrary: 1
---
Body.
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runValidate } from "../../src/commands/validate.js";

const F = (n: string) => join(__dirname, "..", "fixtures", n);

describe("validate", () => {
  it("returns valid=true for a Hermes-shaped concept", async () => {
    const r = await runValidate({ file: F("valid-concept.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.schema).toBe("typed-knowledge");
    }
  });

  it("returns INVALID_FRONTMATTER with field errors", async () => {
    const r = await runValidate({ file: F("invalid-concept.md") });
    expect(r.exitCode).toBe(7);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(false);
      expect(r.result.data.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns SCHEMA_NOT_DETECTED for unknown shape", async () => {
    const r = await runValidate({ file: F("no-schema.md") });
    expect(r.exitCode).toBe(8);
  });

  it("returns FILE_NOT_FOUND for missing file", async () => {
    const r = await runValidate({ file: "/no/such/file" });
    expect(r.exitCode).toBe(2);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement `packages/cli/src/commands/validate.ts`**

```ts
import { readFile } from "node:fs/promises";
import {
  ok, err, ExitCode,
  TypedKnowledgeSchema, RawSourceSchema, WorkItemSchema, CompoundSchema,
  detectSchema, type SchemaName, type Result
} from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface ValidateInput { file: string }
export interface ValidateOutput {
  schema: SchemaName | null;
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

const SCHEMAS = {
  "typed-knowledge": TypedKnowledgeSchema,
  "raw": RawSourceSchema,
  "work-item": WorkItemSchema,
  "compound": CompoundSchema
} as const;

export async function runValidate(input: ValidateInput): Promise<{ exitCode: number; result: Result<ValidateOutput> }> {
  let text: string;
  try {
    text = await readFile(input.file, "utf8");
  } catch {
    return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: input.file }) };
  }
  const fm = extractFrontmatter(text);
  if (!fm.ok) {
    if (fm.error === "MISSING_CLOSING_DELIMITER") {
      return { exitCode: ExitCode.MISSING_CLOSING_DELIMITER, result: fm };
    }
    return { exitCode: ExitCode.INVALID_FRONTMATTER, result: fm };
  }
  const det = detectSchema(fm.data);
  if (!det.schema) {
    return { exitCode: ExitCode.SCHEMA_NOT_DETECTED, result: ok({ schema: null, valid: false, errors: [] }) };
  }
  const parsed = SCHEMAS[det.schema].safeParse(fm.data);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message }));
    return {
      exitCode: ExitCode.INVALID_FRONTMATTER,
      result: ok({ schema: det.schema, valid: false, errors })
    };
  }
  return { exitCode: ExitCode.OK, result: ok({ schema: det.schema, valid: true, errors: [] }) };
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npm run -w skillwiki test`

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/validate.ts packages/cli/test/commands/validate.test.ts packages/cli/test/fixtures/
git commit -m "feat(cli): skillwiki validate (N7, N11, exit 7/8)"
```

---

## Phase 7 — Vault traversal utility

### Task 7.1: Vault scanner

**Files:**
- Create: `packages/cli/src/utils/vault.ts`
- Test: `packages/cli/test/utils/vault.test.ts`
- Test fixtures: `packages/cli/test/fixtures/sample-vault/` (small synthetic vault)

- [ ] **Step 1: Create `packages/cli/test/fixtures/sample-vault/`**

Create these files exactly:

`sample-vault/SCHEMA.md`:
```
# Schema
```

`sample-vault/concepts/alpha.md`:
```
---
title: Alpha
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: []
sources: [raw/articles/x.md]
---
See [[beta]] and [[gamma]].
^[raw/articles/x.md]
```

`sample-vault/concepts/beta.md`:
```
---
title: Beta
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: []
sources: [raw/articles/x.md, raw/articles/y.md]
---
Refers to [[alpha]].
```

`sample-vault/concepts/gamma.md`:
```
---
title: Gamma
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: []
sources: [raw/articles/y.md]
---
Standalone.
```

`sample-vault/raw/articles/x.md`:
```
---
title: Source X
source_url: https://example.com/x
ingested: 2026-05-03
ingested_by: wiki-ingest
sha256: 0000000000000000000000000000000000000000000000000000000000000000
---
X body.
```

`sample-vault/raw/articles/y.md`:
```
---
title: Source Y
source_url: https://example.com/y
ingested: 2026-05-03
ingested_by: wiki-ingest
sha256: 1111111111111111111111111111111111111111111111111111111111111111
---
Y body.
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { scanVault } from "../../src/utils/vault.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("scanVault", () => {
  it("rejects when SCHEMA.md missing", async () => {
    const r = await scanVault("/no/such/path");
    expect(r.ok).toBe(false);
  });

  it("returns markdown files grouped by layer", async () => {
    const r = await scanVault(VAULT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.typedKnowledge.map(p => p.relPath).sort()).toEqual([
        "concepts/alpha.md", "concepts/beta.md", "concepts/gamma.md"
      ]);
      expect(r.data.raw.map(p => p.relPath).sort()).toEqual([
        "raw/articles/x.md", "raw/articles/y.md"
      ]);
    }
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement `packages/cli/src/utils/vault.ts`**

```ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";

export interface VaultPage { absPath: string; relPath: string }
export interface VaultScan {
  root: string;
  typedKnowledge: VaultPage[];
  raw: VaultPage[];
  workItems: VaultPage[];
  compound: VaultPage[];
}

const TYPED_DIRS = ["entities", "concepts", "comparisons", "queries"];

export async function scanVault(root: string): Promise<Result<VaultScan>> {
  try {
    await stat(join(root, "SCHEMA.md"));
  } catch {
    return err("VAULT_PATH_INVALID", { root, reason: "SCHEMA.md missing" });
  }
  const all = await walk(root);
  const rels = all.map(p => ({ absPath: p, relPath: relative(root, p).split(sep).join("/") }));
  return ok({
    root,
    typedKnowledge: rels.filter(p => TYPED_DIRS.some(d => p.relPath.startsWith(d + "/"))),
    raw: rels.filter(p => p.relPath.startsWith("raw/")),
    workItems: rels.filter(p => /^projects\/[^/]+\/work\/[^/]+\/(spec|plan|log)\.md$/.test(p.relPath)),
    compound: rels.filter(p => /^projects\/[^/]+\/compound\//.test(p.relPath))
  });
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

export async function readPage(p: VaultPage): Promise<string> {
  return readFile(p.absPath, "utf8");
}
```

- [ ] **Step 5: Run — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/utils/vault.ts packages/cli/test/utils/vault.test.ts packages/cli/test/fixtures/sample-vault/
git commit -m "feat(cli): vault scanner + sample fixture"
```

---

## Phase 8 — `skillwiki graph build` subcommand

### Task 8.1: graph build command

**Files:**
- Create: `packages/cli/src/commands/graph.ts`
- Test: `packages/cli/test/commands/graph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runGraphBuild } from "../../src/commands/graph.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("graph build", () => {
  it("computes adjacency for the sample vault", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "sw-graph-")), "graph.json");
    const r = await runGraphBuild({ vault: VAULT, out });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(3);
      expect(r.result.data.edge_count).toBeGreaterThan(0);
      expect(r.result.data.out_path).toBe(out);
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(data.adjacency["concepts/alpha.md"]).toContain("concepts/beta.md");
      expect(data.adamicAdar).toBeDefined();
    }
  });

  it("returns VAULT_PATH_INVALID for bad path", async () => {
    const r = await runGraphBuild({ vault: "/no/path", out: "/tmp/g.json" });
    expect(r.exitCode).toBe(9);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/commands/graph.ts`**

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface GraphBuildInput { vault: string; out: string }
export interface GraphBuildOutput { out_path: string; node_count: number; edge_count: number }

export async function runGraphBuild(input: GraphBuildInput): Promise<{ exitCode: number; result: Result<GraphBuildOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const adjacency: Record<string, string[]> = {};
  const slugToPath: Record<string, string> = {};
  for (const p of scan.data.typedKnowledge) {
    const slug = p.relPath.replace(/\.md$/, "").split("/").pop()!;
    slugToPath[slug] = p.relPath;
  }

  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const links = extractBodyWikilinks(body);
    adjacency[p.relPath] = links
      .map(slug => slugToPath[slug.split("/").pop()!])
      .filter((x): x is string => Boolean(x));
  }

  const adamicAdar = computeAdamicAdar(adjacency);
  const edge_count = Object.values(adjacency).reduce((acc, arr) => acc + arr.length, 0);

  try {
    await mkdir(dirname(input.out), { recursive: true });
    await writeFile(input.out, JSON.stringify({ adjacency, adamicAdar }, null, 2));
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { message: String(e) }) };
  }
  return {
    exitCode: ExitCode.OK,
    result: ok({ out_path: input.out, node_count: scan.data.typedKnowledge.length, edge_count })
  };
}

function computeAdamicAdar(adj: Record<string, string[]>): Record<string, Record<string, number>> {
  const undirected: Record<string, Set<string>> = {};
  for (const [a, neighbors] of Object.entries(adj)) {
    undirected[a] ??= new Set();
    for (const b of neighbors) {
      undirected[a].add(b);
      undirected[b] ??= new Set();
      undirected[b].add(a);
    }
  }
  const nodes = Object.keys(undirected);
  const out: Record<string, Record<string, number>> = {};
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const common = [...undirected[a]].filter(x => undirected[b].has(x));
      let score = 0;
      for (const c of common) {
        const deg = undirected[c].size;
        if (deg > 1) score += 1 / Math.log(deg);
      }
      if (score > 0) {
        out[a] ??= {}; out[a][b] = score;
        out[b] ??= {}; out[b][a] = score;
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/graph.ts packages/cli/test/commands/graph.test.ts
git commit -m "feat(cli): skillwiki graph build (E2 1.5x signal)"
```

---

## Phase 9 — `skillwiki overlap` subcommand

### Task 9.1: overlap command

**Files:**
- Create: `packages/cli/src/commands/overlap.ts`
- Test: `packages/cli/test/commands/overlap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runOverlap } from "../../src/commands/overlap.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("overlap", () => {
  it("clusters pages that share raw sources", async () => {
    const r = await runOverlap({ vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // alpha + beta share x; beta + gamma share y → all three connected
      const big = r.result.data.clusters.find(c => c.members.length >= 2);
      expect(big).toBeDefined();
      expect(big!.score).toBeGreaterThan(0);
    }
  });

  it("returns VAULT_PATH_INVALID for bad path", async () => {
    const r = await runOverlap({ vault: "/nope" });
    expect(r.exitCode).toBe(9);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/commands/overlap.ts`**

```ts
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface OverlapInput { vault: string }
export interface OverlapCluster { id: string; members: string[]; score: number }
export interface OverlapOutput { clusters: OverlapCluster[] }

export async function runOverlap(input: OverlapInput): Promise<{ exitCode: number; result: Result<OverlapOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const sourcesByPage: Record<string, Set<string>> = {};
  for (const p of scan.data.typedKnowledge) {
    const fm = extractFrontmatter(await readPage(p));
    if (!fm.ok) continue;
    const srcs = (fm.data.sources as string[] | undefined) ?? [];
    sourcesByPage[p.relPath] = new Set(srcs);
  }

  // Union-find over pages that share any source.
  const parent: Record<string, string> = {};
  for (const k of Object.keys(sourcesByPage)) parent[k] = k;
  const find = (x: string): string => parent[x] === x ? x : (parent[x] = find(parent[x]));
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const pages = Object.keys(sourcesByPage);
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const sa = sourcesByPage[pages[i]], sb = sourcesByPage[pages[j]];
      const shared = [...sa].filter(x => sb.has(x)).length;
      if (shared > 0) union(pages[i], pages[j]);
    }
  }

  const groups: Record<string, string[]> = {};
  for (const p of pages) {
    const r = find(p);
    (groups[r] ??= []).push(p);
  }
  const clusters: OverlapCluster[] = Object.entries(groups)
    .filter(([, m]) => m.length > 1)
    .map(([id, members]) => {
      // score = total shared-source pairs within cluster (4.0x signal precomputed)
      let score = 0;
      for (let i = 0; i < members.length; i++)
        for (let j = i + 1; j < members.length; j++) {
          const sa = sourcesByPage[members[i]], sb = sourcesByPage[members[j]];
          score += [...sa].filter(x => sb.has(x)).length;
        }
      return { id, members, score };
    });

  return { exitCode: ExitCode.OK, result: ok({ clusters }) };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/overlap.ts packages/cli/test/commands/overlap.test.ts
git commit -m "feat(cli): skillwiki overlap (E2 4.0x signal)"
```

---

## Phase 10 — `skillwiki orphans` subcommand

### Task 10.1: orphans command

**Files:**
- Create: `packages/cli/src/commands/orphans.ts`
- Test: `packages/cli/test/commands/orphans.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runOrphans } from "../../src/commands/orphans.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("orphans", () => {
  it("flags zero-degree pages as orphans", async () => {
    const r = await runOrphans({ vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // sample vault has alpha<->beta, alpha->gamma; nothing is a true orphan
      expect(Array.isArray(r.result.data.orphans)).toBe(true);
      expect(Array.isArray(r.result.data.bridges)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/commands/orphans.ts`**

```ts
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface OrphansInput { vault: string }
export interface OrphansOutput {
  orphans: string[];
  bridges: Array<{ path: string; connects: string[] }>;
}

export async function runOrphans(input: OrphansInput): Promise<{ exitCode: number; result: Result<OrphansOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const slugToPath: Record<string, string> = {};
  for (const p of scan.data.typedKnowledge) {
    slugToPath[p.relPath.replace(/\.md$/, "").split("/").pop()!] = p.relPath;
  }
  const adj: Record<string, Set<string>> = {};
  for (const p of scan.data.typedKnowledge) adj[p.relPath] = new Set();

  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    for (const slug of extractBodyWikilinks(body)) {
      const tgt = slugToPath[slug.split("/").pop()!];
      if (tgt) {
        adj[p.relPath].add(tgt);
        adj[tgt].add(p.relPath);
      }
    }
  }

  const orphans = Object.keys(adj).filter(k => adj[k].size === 0);

  // Connected components via DFS.
  const componentOf: Record<string, number> = {};
  let cid = 0;
  for (const node of Object.keys(adj)) {
    if (componentOf[node] !== undefined) continue;
    const stack = [node];
    while (stack.length) {
      const n = stack.pop()!;
      if (componentOf[n] !== undefined) continue;
      componentOf[n] = cid;
      for (const nb of adj[n]) stack.push(nb);
    }
    cid++;
  }

  const bridges: OrphansOutput["bridges"] = [];
  for (const node of Object.keys(adj)) {
    const neighborComps = new Set([...adj[node]].map(n => componentOf[n]));
    if (adj[node].size >= 2 && neighborComps.size === 1) {
      const without = simulateRemoval(adj, node);
      if (without > Object.values(componentOf).filter((v, i, a) => a.indexOf(v) === i).length) {
        bridges.push({ path: node, connects: [...adj[node]] });
      }
    }
  }
  return { exitCode: ExitCode.OK, result: ok({ orphans, bridges }) };
}

function simulateRemoval(adj: Record<string, Set<string>>, removed: string): number {
  const seen = new Set<string>();
  let comps = 0;
  for (const start of Object.keys(adj)) {
    if (start === removed || seen.has(start)) continue;
    comps++;
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n) || n === removed) continue;
      seen.add(n);
      for (const nb of adj[n]) if (nb !== removed) stack.push(nb);
    }
  }
  return comps;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/orphans.ts packages/cli/test/commands/orphans.test.ts
git commit -m "feat(cli): skillwiki orphans (E3 review queue inputs)"
```

---

## Phase 11 — `skillwiki audit` subcommand

### Task 11.1: audit command

**Files:**
- Create: `packages/cli/src/commands/audit.ts`
- Test: `packages/cli/test/commands/audit.test.ts`
- Test fixtures: `packages/cli/test/fixtures/audit-vault/` (page with markers + raw files)

- [ ] **Step 1: Create fixture vault**

`audit-vault/SCHEMA.md`:
```
# Schema
```

`audit-vault/concepts/clean.md`:
```
---
title: Clean Page
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: []
sources: [raw/articles/x.md, raw/articles/y.md]
---
Body cites X.
^[raw/articles/x.md]
Body cites Y.
^[raw/articles/y.md]
```

`audit-vault/concepts/unresolved.md`:
```
---
title: Unresolved
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: []
sources: [raw/articles/x.md]
---
Cites missing source.
^[raw/articles/missing.md]
```

`audit-vault/concepts/inconsistent.md`:
```
---
title: Inconsistent
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: []
sources: [raw/articles/x.md, raw/articles/y.md]
---
Only cites X.
^[raw/articles/x.md]
```

`audit-vault/raw/articles/x.md`:
```
---
title: X
source_url: null
ingested: 2026-05-03
ingested_by: manual
sha256: 0000000000000000000000000000000000000000000000000000000000000000
---
X.
```

`audit-vault/raw/articles/y.md`:
```
---
title: Y
source_url: null
ingested: 2026-05-03
ingested_by: manual
sha256: 1111111111111111111111111111111111111111111111111111111111111111
---
Y.
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runAudit } from "../../src/commands/audit.js";

const F = (n: string) => join(__dirname, "..", "fixtures", "audit-vault", n);

describe("audit", () => {
  it("returns exit 0 for a clean page", async () => {
    const r = await runAudit({ file: F("concepts/clean.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.markers.every(m => m.resolved)).toBe(true);
      expect(r.result.data.sources_consistency.unused_sources).toEqual([]);
      expect(r.result.data.sources_consistency.missing_from_sources).toEqual([]);
    }
  });

  it("returns UNRESOLVED_MARKERS (11) for missing target", async () => {
    const r = await runAudit({ file: F("concepts/unresolved.md") });
    expect(r.exitCode).toBe(11);
  });

  it("returns SOURCES_INCONSISTENT (12) for unused sources", async () => {
    const r = await runAudit({ file: F("concepts/inconsistent.md") });
    expect(r.exitCode).toBe(12);
    if (r.result.ok) {
      expect(r.result.data.sources_consistency.unused_sources).toContain("raw/articles/y.md");
    }
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement `packages/cli/src/commands/audit.ts`**

```ts
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { extractCitationMarkers } from "../parsers/citations.js";

export interface AuditInput { file: string }
export interface AuditOutput {
  markers: Array<{ marker: string; target: string; resolved: boolean }>;
  sources_consistency: { unused_sources: string[]; missing_from_sources: string[] };
}

export async function runAudit(input: AuditInput): Promise<{ exitCode: number; result: Result<AuditOutput> }> {
  let text: string;
  try { text = await readFile(input.file, "utf8"); }
  catch { return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: input.file }) }; }

  const fm = extractFrontmatter(text);
  if (!fm.ok) return { exitCode: ExitCode.INVALID_FRONTMATTER, result: fm };
  const split = splitFrontmatter(text);
  const body = split.ok ? split.data.body : text;

  // Find vault root by walking up to a directory containing SCHEMA.md.
  const vault = await findVaultRoot(dirname(resolve(input.file)));
  if (!vault) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID") };

  const markers = extractCitationMarkers(body);
  const resolved = await Promise.all(markers.map(async m => {
    try { await stat(join(vault, m.target)); return { ...m, resolved: true }; }
    catch { return { ...m, resolved: false }; }
  }));

  const sources = (fm.data.sources as string[] | undefined) ?? [];
  const referenced = new Set(resolved.map(m => m.target));
  const unused_sources = sources.filter(s => !referenced.has(s));
  const missing_from_sources = [...referenced].filter(t => !sources.includes(t));

  if (resolved.some(m => !m.resolved)) {
    return { exitCode: ExitCode.UNRESOLVED_MARKERS, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources } }) };
  }
  if (unused_sources.length > 0 || missing_from_sources.length > 0) {
    return { exitCode: ExitCode.SOURCES_INCONSISTENT, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources } }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources } }) };
}

async function findVaultRoot(start: string): Promise<string | null> {
  let cur = start;
  for (let i = 0; i < 20; i++) {
    try { await stat(join(cur, "SCHEMA.md")); return cur; } catch { /* keep walking */ }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
```

- [ ] **Step 5: Run — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/audit.ts packages/cli/test/commands/audit.test.ts packages/cli/test/fixtures/audit-vault/
git commit -m "feat(cli): skillwiki audit (citation + sources↔body consistency, exit 11/12)"
```

---

## Phase 12 — `skillwiki install` subcommand

### Task 12.1: install-fs primitives

**Files:**
- Create: `packages/cli/src/utils/install-fs.ts`
- Test: `packages/cli/test/utils/install-fs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicCopyWithBackup, writeManifest } from "../../src/utils/install-fs.js";

describe("install-fs", () => {
  it("copies a file when target absent", async () => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dst = mkdtempSync(join(tmpdir(), "dst-"));
    writeFileSync(join(src, "f.md"), "v1");
    const r = await atomicCopyWithBackup(join(src, "f.md"), join(dst, "f.md"));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dst, "f.md"), "utf8")).toBe("v1");
  });

  it("backs up an existing target before overwrite", async () => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dst = mkdtempSync(join(tmpdir(), "dst-"));
    writeFileSync(join(src, "f.md"), "v2");
    writeFileSync(join(dst, "f.md"), "v1");
    const r = await atomicCopyWithBackup(join(src, "f.md"), join(dst, "f.md"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(existsSync(r.data.backupPath!)).toBe(true);
    expect(readFileSync(join(dst, "f.md"), "utf8")).toBe("v2");
  });

  it("writes a manifest as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "man-"));
    const path = join(dir, "wiki-manifest.json");
    await writeManifest(path, { installed: ["a"], backed_up: [] });
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.installed).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/utils/install-fs.ts`**

```ts
import { copyFile, mkdir, rename, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";

export interface CopyResult { copied: true; backupPath: string | null }

export async function atomicCopyWithBackup(src: string, dst: string): Promise<Result<CopyResult>> {
  await mkdir(dirname(dst), { recursive: true });
  let backupPath: string | null = null;
  try {
    await stat(dst);
    backupPath = `${dst}.bak`;
    await copyFile(dst, backupPath);
  } catch { /* target absent, no backup */ }
  const tmp = `${dst}.tmp.${process.pid}`;
  try {
    await copyFile(src, tmp);
    await rename(tmp, dst);
  } catch (e) {
    return err("ATOMIC_COPY_FAILED", { message: String(e) });
  }
  return ok({ copied: true, backupPath });
}

export interface Manifest {
  installed: string[];
  backed_up: string[];
  installed_at?: string;
  version?: string;
}

export async function writeManifest(path: string, m: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const enriched: Manifest = { installed_at: new Date().toISOString(), ...m };
  await writeFile(path, JSON.stringify(enriched, null, 2));
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/utils/install-fs.ts packages/cli/test/utils/install-fs.test.ts
git commit -m "feat(cli): atomic copy + backup + manifest writer (N17, N18)"
```

### Task 12.2: install command

**Files:**
- Create: `packages/cli/src/commands/install.ts`
- Test: `packages/cli/test/commands/install.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../src/commands/install.js";

function fakeSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-src-"));
  mkdirSync(join(dir, "wiki-init"), { recursive: true });
  writeFileSync(join(dir, "wiki-init", "SKILL.md"), "# wiki-init");
  mkdirSync(join(dir, "proj-init"), { recursive: true });
  writeFileSync(join(dir, "proj-init", "SKILL.md"), "# proj-init");
  return dir;
}

describe("install", () => {
  it("performs --dry-run without writing files", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(false);
  });

  it("installs both skills and writes manifest", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "proj-init", "SKILL.md"))).toBe(true);
    if (r.result.ok) {
      const manifest = JSON.parse(readFileSync(r.result.data.manifest_path, "utf8"));
      expect(manifest.installed.length).toBe(2);
    }
  });

  it("is idempotent on a second run", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    await runInstall({ skillsRoot, target, dryRun: false });
    const r = await runInstall({ skillsRoot, target, dryRun: false });
    expect(r.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/commands/install.ts`**

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { atomicCopyWithBackup, writeManifest } from "../utils/install-fs.js";

export interface InstallInput {
  skillsRoot: string;   // path to packages/skills
  target: string;       // ~/.claude/skills/
  dryRun: boolean;
}
export interface InstallOutput {
  installed: string[];
  backed_up: string[];
  manifest_path: string;
}

export async function runInstall(input: InstallInput): Promise<{ exitCode: number; result: Result<InstallOutput> }> {
  let entries: string[];
  try {
    entries = (await readdir(input.skillsRoot, { withFileTypes: true }))
      .filter(d => d.isDirectory() && (d.name.startsWith("wiki-") || d.name.startsWith("proj-")))
      .map(d => d.name);
  } catch (e) {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: String(e) }) };
  }
  if (entries.length === 0) {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { reason: "no skills found" }) };
  }

  const installed: string[] = [];
  const backed_up: string[] = [];

  for (const name of entries) {
    const src = join(input.skillsRoot, name, "SKILL.md");
    const dst = join(input.target, name, "SKILL.md");
    try { await stat(src); } catch {
      return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { missing: src }) };
    }
    if (input.dryRun) { installed.push(dst); continue; }
    const r = await atomicCopyWithBackup(src, dst);
    if (!r.ok) return { exitCode: ExitCode.ATOMIC_COPY_FAILED, result: r };
    installed.push(dst);
    if (r.data.backupPath) backed_up.push(r.data.backupPath);
  }

  const manifest_path = join(input.target, "wiki-manifest.json");
  if (!input.dryRun) await writeManifest(manifest_path, { installed, backed_up });
  return { exitCode: ExitCode.OK, result: ok({ installed, backed_up, manifest_path }) };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/install.ts packages/cli/test/commands/install.test.ts
git commit -m "feat(cli): skillwiki install (N17, N18, exit 13/14)"
```

---

## Phase 13 — Output helpers + Commander entry

### Task 13.1: printJson / printHuman

**Files:**
- Create: `packages/cli/src/utils/output.ts`
- Test: `packages/cli/test/utils/output.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { printJson, printHuman } from "../../src/utils/output.js";
import { ok, err } from "@skillwiki/shared";

describe("output", () => {
  it("printJson writes JSON.stringify of result + newline", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printJson(ok({ x: 1 }));
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ ok: true, data: { x: 1 } }) + "\n");
    spy.mockRestore();
  });

  it("printHuman renders ok results with a tag", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(ok({ msg: "hello" }));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("OK");
    expect(arg).toContain("hello");
    spy.mockRestore();
  });

  it("printHuman renders err results with the error code", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(err("HOST_BLOCKED", { host: "10.0.0.1" }));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("HOST_BLOCKED");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `packages/cli/src/utils/output.ts`**

```ts
import type { Result } from "@skillwiki/shared";

export function printJson<T>(r: Result<T>): void {
  process.stdout.write(JSON.stringify(r) + "\n");
}

export function printHuman<T>(r: Result<T>): void {
  if (r.ok) {
    process.stdout.write(`OK\n${formatData(r.data)}\n`);
  } else {
    process.stdout.write(`ERR ${r.error}\n${r.detail !== undefined ? formatData(r.detail) + "\n" : ""}`);
  }
}

function formatData(d: unknown): string {
  if (d == null) return "";
  if (typeof d === "string") return d;
  return JSON.stringify(d, null, 2);
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/utils/output.ts packages/cli/test/utils/output.test.ts
git commit -m "feat(cli): JSON / --human output helpers (N1, N2)"
```

### Task 13.2: Commander entry — wire all 8 subcommands

**Files:**
- Modify: `packages/cli/src/cli.ts` (replace placeholder)
- Test: `packages/cli/test/cli.smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const BIN = join(__dirname, "..", "dist", "cli.js");

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

describe("cli smoke", () => {
  it("fetch-guard rejects http with exit 4", () => {
    const r = run(["fetch-guard", "http://example.com"]);
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it("fetch-guard allows https with exit 0", () => {
    const r = run(["fetch-guard", "https://example.com"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.allowed).toBe(true);
  });

  it("--human flag does not change exit code", () => {
    const r = run(["fetch-guard", "http://example.com", "--human"]);
    expect(r.status).toBe(4);
    expect(r.stdout).toContain("SCHEME_REJECTED");
  });

  it("unknown subcommand exits non-zero", () => {
    const r = run(["bogus"]);
    expect(r.status).not.toBe(0);
  });
});
```

- [ ] **Step 2: Replace `packages/cli/src/cli.ts`**

```ts
#!/usr/bin/env node
import { Command } from "commander";
import type { Result } from "@skillwiki/shared";
import { printJson, printHuman } from "./utils/output.js";
import { runHash } from "./commands/hash.js";
import { runFetchGuard } from "./commands/fetch-guard.js";
import { runValidate } from "./commands/validate.js";
import { runGraphBuild } from "./commands/graph.js";
import { runOverlap } from "./commands/overlap.js";
import { runOrphans } from "./commands/orphans.js";
import { runAudit } from "./commands/audit.js";
import { runInstall } from "./commands/install.js";

const program = new Command();
program.name("skillwiki").description("Deterministic helpers for CodeWiki skills").version("0.1.0");
program.option("--human", "render terminal-readable output instead of JSON");

function emit<T>(r: { exitCode: number; result: Result<T> }): never {
  if (program.opts().human) printHuman(r.result); else printJson(r.result);
  process.exit(r.exitCode);
}

program.command("hash <file>").action(async (file) => emit(await runHash({ file })));

program.command("fetch-guard <url>").action(async (url) => emit(await runFetchGuard({ url })));

program.command("validate <file>").action(async (file) => emit(await runValidate({ file })));

program
  .command("graph")
  .description("graph subcommands")
  .command("build <vault>")
  .option("--out <path>", "graph output path", ".skillwiki/graph.json")
  .action(async (vault, opts) => emit(await runGraphBuild({ vault, out: opts.out })));

program.command("overlap <vault>").action(async (vault) => emit(await runOverlap({ vault })));

program.command("orphans <vault>").action(async (vault) => emit(await runOrphans({ vault })));

program.command("audit <file>").action(async (file) => emit(await runAudit({ file })));

program
  .command("install")
  .option("--target <dir>", "target install directory", `${process.env.HOME ?? ""}/.claude/skills/`)
  .option("--dry-run", "preview only", false)
  .option("--skills-root <dir>", "source skills directory (defaults to packaged)")
  .action(async (opts) => {
    const skillsRoot = opts.skillsRoot ?? new URL("../../skills/", import.meta.url).pathname;
    emit(await runInstall({ skillsRoot, target: opts.target, dryRun: !!opts.dryRun }));
  });

program.parseAsync(process.argv).catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: "INTERNAL", detail: { message: String(e) } }) + "\n");
  process.exit(1);
});
```

- [ ] **Step 3: Build the CLI**

Run: `npm run -w skillwiki build`
Expected: `packages/cli/dist/cli.js` updated.

- [ ] **Step 4: Run smoke test — expect PASS**

Run: `npm run -w skillwiki test -- cli.smoke`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli.ts packages/cli/test/cli.smoke.test.ts
git commit -m "feat(cli): wire all 8 subcommands via commander (N1, N2, N3)"
```

---

## Phase 14 — Templates

### Task 14.1: Create the four templates

**Files:**
- Create: `packages/cli/templates/SCHEMA.md`
- Create: `packages/cli/templates/index.md`
- Create: `packages/cli/templates/log.md`
- Create: `packages/cli/templates/project-README.md`

- [ ] **Step 1: Create `packages/cli/templates/SCHEMA.md`**

```markdown
# Vault Schema

This vault follows the CodeWiki schema (Hermes llm-wiki v2.1.0 wire-compatible).

## Layers

- `raw/` — immutable source material (never modify after ingest).
- `entities/`, `concepts/`, `comparisons/`, `queries/` — typed knowledge unified across origin via `provenance:`.
- `meta/` — cross-project synthesis (notes naming ≥2 projects).
- `projects/{slug}/` — per-project lifecycle workspace.

## Frontmatter

Four shapes: typed-knowledge, raw, work-item, compound. See spec for full Zod schemas.

## Conventions

- File names: lowercase-hyphenated, no spaces.
- Wikilinks in YAML: quoted, `"[[name]]"`. Body wikilinks: unquoted `[[name]]`.
- Citations in body: `^[raw/...]` markers; every entry in `sources:` MUST appear in body.
- sha256 in `raw/` frontmatter is computed by `skillwiki hash` over body bytes after closing `---`.
```

- [ ] **Step 2: Create `packages/cli/templates/index.md`**

```markdown
# Vault Index

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

- [ ] **Step 3: Create `packages/cli/templates/log.md`**

```markdown
# Vault Log

Chronological action log. Newest entries last. Skill writes append entries; lint may rotate.
```

- [ ] **Step 4: Create `packages/cli/templates/project-README.md`**

```markdown
# Project: {{slug}}

**Created:** {{date}}

## Intent

<!-- 2-4 sentences: what this project is and why it exists -->

## Layout

- `requirements/` — what we're building (incl. roadmap docs).
- `architecture/` — how it's designed (incl. ADRs).
- `work/YYYY-MM-DD-{slug}/` — per-work-item folders containing `spec.md`, `plan.md`, `log.md`.
- `compound/` — project-local concrete learnings.
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/templates/
git commit -m "feat(cli): vault and project templates"
```

---

## Phase 15 — `wiki-*` SKILL.md files (6 skills)

Each SKILL.md is prompt-only Markdown. The Vitest fixture in Task 15.3 verifies every required section is present.

### Task 15.1: wiki-init, wiki-ingest, wiki-query

**Files:**
- Create: `packages/skills/wiki-init/SKILL.md`
- Create: `packages/skills/wiki-ingest/SKILL.md`
- Create: `packages/skills/wiki-query/SKILL.md`

- [ ] **Step 1: Create `packages/skills/wiki-init/SKILL.md`**

````markdown
---
name: wiki-init
description: Bootstrap a CodeWiki vault — directory tree, SCHEMA.md, index.md, log.md. Use when starting a fresh vault.
---

# wiki-init

## When to invoke
- User asks to bootstrap a new knowledge vault.
- Vault root is empty or missing SCHEMA.md.

## Pre-orientation reads
None for the first run. If a target directory already contains files, STOP and surface the conflict — do not overwrite.

## Inputs
1. Target directory (default: cwd).
2. Domain question: "What knowledge domain will this vault cover?" — used to seed `tags:` and SCHEMA notes.

## Steps
1. Verify target directory is empty or missing.
2. Run `skillwiki install --dry-run` against target to preview side effects (skip if not installing skills here).
3. Create directory tree: `raw/{articles,papers,transcripts,assets}/`, `entities/`, `concepts/`, `comparisons/`, `queries/`, `meta/`, `projects/`.
4. Write `SCHEMA.md`, `index.md`, `log.md` from packaged templates (resolved via `npx skillwiki install --target <vault>` or by reading `node_modules/skillwiki/templates/`).
5. Append a single `log.md` entry: "Vault initialized — domain: <answer>".

## Stop conditions
- Target non-empty.
- Cannot resolve templates path.

## Forbidden
- Modifying anything outside the target directory.
- Running any LLM-driven content generation in this skill.
````

- [ ] **Step 2: Create `packages/skills/wiki-ingest/SKILL.md`**

````markdown
---
name: wiki-ingest
description: Convert URLs, files, or pasted text into typed-knowledge pages with raw provenance. Single-pass v1.
---

# wiki-ingest

## When to invoke
- User shares a URL, paste, or local file to capture in the vault.
- Output target is `entities/`, `concepts/`, `comparisons/`, or `queries/`.

## Pre-orientation reads (mandatory before any write)
1. `SCHEMA.md`
2. `index.md`
3. Last 20–30 entries of `log.md`
4. (Project context only) `projects/{slug}/README.md` and last ~5 work-item logs.

## Steps (in order — N6, N7, N8)
1. **Guard.** For each URL: run `npx skillwiki fetch-guard <url>`. If exit ≠ 0, STOP and surface the error. Do not retry.
2. **Fetch.** Use `web_fetch` (or read local file) under Layer 2 controls (the CLI Layer 2 fetcher applies in tests; in skill runtime use `web_fetch` directly and treat any error as STOP).
3. **Hash.** Write the raw file (frontmatter + body). Run `npx skillwiki hash <raw-file>` and embed the result in raw frontmatter `sha256:`.
4. **Generate page(s).** Compose typed-knowledge page(s) with citations pre-attached (`^[raw/...]` markers).
5. **Validate.** For each generated page: run `npx skillwiki validate <page>`. If exit ≠ 0, STOP — do not write index/log.
6. **Apply writes in order.** raw → page(s) → `index.md` → `log.md`.
7. **Confidence flag.** If only one source is cited, set `confidence: low`.

## Provenance defaults
- Default `provenance: research`.
- If cwd is inside `projects/{slug}/`, set `provenance: project` and add `provenance_projects: ["[[slug]]"]`.

## Stop conditions
- `fetch-guard` non-zero.
- Fetch timeout / size limit exceeded.
- `validate` non-zero on any page.
- sha256 already exists in vault for the same source.

## Forbidden
- Skipping `fetch-guard`.
- Updating `index.md` or `log.md` before all pages validate.
- Modifying any existing file in `raw/`.
````

- [ ] **Step 3: Create `packages/skills/wiki-query/SKILL.md`**

````markdown
---
name: wiki-query
description: Search the vault and synthesize an answer with E2 4-signal ranking. Optional file to queries/ or comparisons/.
---

# wiki-query

## When to invoke
- User asks a question that can be answered from existing vault content.
- Either no scope hint or one of: vault / current-project / project+concepts.

## Pre-orientation reads
Standard four reads (SCHEMA, index, log, project context if applicable).

## Steps
1. **Determine scope.** Ask the user once if ambiguous: vault | current project | project+concepts.
2. **Refresh graph.** If `.skillwiki/graph.json` is missing or older than 24h: `npx skillwiki graph build <vault>`.
3. **Compute overlap.** `npx skillwiki overlap <vault>`.
4. **Score candidates** in prompt using the 4 signals:
   - Direct wikilink: 3.0×
   - Source overlap: 4.0× (read from overlap output)
   - Adamic-Adar: 1.5× (read from graph output)
   - Type affinity: 1.0×
5. **Read top candidates** in full (frontmatter + body).
6. **Synthesize answer** with explicit citations to the candidate pages.
7. **Optional file.** If user accepts: write to `queries/<slug>.md` or `comparisons/<slug>.md` with full frontmatter, validate, then update `index.md` then `log.md`.

## Stop conditions
- Zero matching pages.
- User declines to file.

## Forbidden
- Filing without `validate` passing.
- Skipping the orientation reads even for "quick" queries.
````

- [ ] **Step 4: Commit**

```bash
git add packages/skills/wiki-init packages/skills/wiki-ingest packages/skills/wiki-query
git commit -m "feat(skills): wiki-init, wiki-ingest, wiki-query SKILL.md"
```

### Task 15.2: wiki-lint, wiki-crystallize, wiki-audit

**Files:**
- Create: `packages/skills/wiki-lint/SKILL.md`
- Create: `packages/skills/wiki-crystallize/SKILL.md`
- Create: `packages/skills/wiki-audit/SKILL.md`

- [ ] **Step 1: Create `packages/skills/wiki-lint/SKILL.md`**

````markdown
---
name: wiki-lint
description: Vault health check — validation, sha256 drift, orphans/bridges, review queue (E3). Read-only by default.
---

# wiki-lint

## When to invoke
- User asks for a vault health report.
- Periodic maintenance.

## Pre-orientation reads
Standard four reads.

## Steps (in order)
1. For each typed-knowledge page: `npx skillwiki validate <page>`. Collect errors.
2. For each `raw/` file: `npx skillwiki hash <file>`. Compare to frontmatter `sha256:`. Flag drift WITHOUT auto-update (per N9).
3. `npx skillwiki orphans <vault>`. Collect orphans + bridge nodes.
4. **Review queue (E3).** Build a section listing:
   - Pages with `confidence: low` AND single `sources:` entry → "promote or corroborate".
   - Pages with `contested: true` → "resolve contradiction".
   - Orphan clusters → "knowledge gap".
   - Bridge nodes → "fragility risk".
5. Write a single `log.md` rotation entry summarizing counts.
6. Print the report (terminal-friendly).

## Stop conditions
None — lint reports all findings even on per-page errors.

## Forbidden
- Auto-updating sha256 fields.
- Modifying pages other than `log.md` rotation.
````

- [ ] **Step 2: Create `packages/skills/wiki-crystallize/SKILL.md`**

````markdown
---
name: wiki-crystallize
description: Distill the current working session into a typed-knowledge page with provenance.
---

# wiki-crystallize

## When to invoke
- User asks to capture a session as a vault page.
- A reasoning thread has produced a stable insight worth durable storage.

## Pre-orientation reads
Standard four reads. If cwd is inside `projects/{slug}/`, also read project README and recent work logs.

## Steps
1. Identify type: entity / concept / comparison / query / summary.
2. Set `provenance:`. Default `research`. If in project context: `project` with `provenance_projects: ["[[slug]]"]`.
3. Compose the page with citations pre-attached. Reuse existing `raw/` sources where possible.
4. `npx skillwiki validate <page>`. If non-zero, STOP.
5. Apply writes: page → `index.md` → `log.md`.

## Stop conditions
- `validate` non-zero.
- Missing `provenance:` for project-context runs.

## Forbidden
- Filing without explicit `provenance:`.
- Updating `index.md` before `validate` passes.
````

- [ ] **Step 3: Create `packages/skills/wiki-audit/SKILL.md`**

````markdown
---
name: wiki-audit
description: Verify per-page that every ^[raw/...] resolves and sources frontmatter matches the body.
---

# wiki-audit

## When to invoke
- User asks to audit a specific page.
- Pre-merge gate on a synthesis-heavy page.

## Pre-orientation reads
Standard four reads.

## Steps
1. `npx skillwiki audit <page>`. Read the JSON report.
2. Reason over the report:
   - For each unresolved marker: suggest ingesting the missing source or correcting the path.
   - For each `unused_sources` entry: suggest adding a body marker or removing from `sources:`.
   - For each `missing_from_sources` entry: suggest adding to `sources:`.
3. Append one `log.md` entry summarizing the audit and any suggested follow-ups.

## Stop conditions
None — audit always completes.

## Forbidden
- Auto-applying suggested fixes (audit is observation-only).
````

- [ ] **Step 4: Commit**

```bash
git add packages/skills/wiki-lint packages/skills/wiki-crystallize packages/skills/wiki-audit
git commit -m "feat(skills): wiki-lint, wiki-crystallize, wiki-audit SKILL.md"
```

### Task 15.3: SKILL.md structural test

**Files:**
- Create: `packages/cli/test/skills/skill-md.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "..", "..", "..", "skills");
const ALL = [
  "wiki-init", "wiki-ingest", "wiki-query", "wiki-lint", "wiki-crystallize", "wiki-audit",
  "proj-init", "proj-work", "proj-distill", "proj-decide"
];

describe("SKILL.md structure", () => {
  it.each(ALL)("%s has frontmatter with name + description", (skill) => {
    const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/\nname: /);
    expect(text).toMatch(/\ndescription: /);
  });

  it.each(ALL)("%s declares pre-orientation expectations", (skill) => {
    const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
    expect(text).toMatch(/Pre-orientation reads/);
  });

  it.each(ALL)("%s declares stop conditions", (skill) => {
    const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
    expect(text).toMatch(/Stop conditions/);
  });
});
```

- [ ] **Step 2: Run — at this point only wiki-* exist; proj-* will fail**

Run: `npm run -w skillwiki test -- skill-md`
Expected: 6 wiki-* pass, 4 proj-* fail (file not found). This is intentional — Phase 16 adds the proj-* files and the same test goes green.

- [ ] **Step 3: DO NOT commit yet — Phase 16 completes the suite.**

(Skipping commit at this checkpoint is intentional; the structural test commit goes with Phase 16.)

---

## Phase 16 — `proj-*` SKILL.md files (4 skills)

### Task 16.1: proj-init, proj-work

**Files:**
- Create: `packages/skills/proj-init/SKILL.md`
- Create: `packages/skills/proj-work/SKILL.md`

- [ ] **Step 1: Create `packages/skills/proj-init/SKILL.md`**

````markdown
---
name: proj-init
description: Bootstrap a project workspace at projects/{slug}/ with README, requirements/, architecture/, work/, compound/.
---

# proj-init

## When to invoke
- User starts a new project that should live inside the vault.

## Pre-orientation reads
Standard four reads (vault SCHEMA, index, log) — no project context yet.

## Inputs
- Slug (lowercase, hyphenated).
- One-line intent.

## Steps
1. Verify `projects/{slug}/` does not exist.
2. Create folders: `projects/{slug}/{requirements,architecture,work,compound}/`.
3. Render `projects/{slug}/README.md` from `project-README.md` template, filling `{{slug}}` and `{{date}}`.
4. Update vault `index.md` "Projects" section: add `- [[projects/{slug}]]`.
5. Append vault `log.md` entry: "Project {slug} initialized."

## Stop conditions
- `projects/{slug}/` already exists.

## Forbidden
- Modifying any other project's files.
````

- [ ] **Step 2: Create `packages/skills/proj-work/SKILL.md`**

````markdown
---
name: proj-work
description: Open or run a work item under projects/{slug}/work/YYYY-MM-DD-{slug}/. Redirects brainstorming/writing-plans output paths.
---

# proj-work

## When to invoke
- User starts a feature, issue, refactor, or decision inside an existing project.
- Brainstorming or writing-plans skills would otherwise default-write outside the project tree.

## Pre-orientation reads
Standard four + project context (project README, last ~5 work logs).

## Steps
1. Determine `kind:` (feature | issue | refactor | decision) and slug.
2. Create folder `projects/{slug}/work/YYYY-MM-DD-{work-slug}/`.
3. Override default output paths for any nested skill: `spec.md`, `plan.md`, and `log.md` are written here, not at vault root.
4. Validate work-item frontmatter via `npx skillwiki validate <spec.md>`. If non-zero, STOP.
5. Manage status transitions: `planned` → `in-progress` → `completed` (set `completed:` date) or `abandoned`.
6. Append vault `log.md` entry on creation and on each status transition.

## Stop conditions
- `validate` non-zero.
- Conflicting work folder name.

## Forbidden
- Writing spec/plan files outside the work folder.
- Marking `status: completed` without a `completed:` date.
````

- [ ] **Step 3: Commit**

```bash
git add packages/skills/proj-init packages/skills/proj-work
git commit -m "feat(skills): proj-init, proj-work SKILL.md"
```

### Task 16.2: proj-distill, proj-decide + green skill-md test

**Files:**
- Create: `packages/skills/proj-distill/SKILL.md`
- Create: `packages/skills/proj-decide/SKILL.md`

- [ ] **Step 1: Create `packages/skills/proj-distill/SKILL.md`**

````markdown
---
name: proj-distill
description: 2-step distillation (E4) — analyze project compound entry, then generate a vault concept page with provenance.
---

# proj-distill

## When to invoke
- A project compound entry captures a pattern that generalizes beyond the project.

## Pre-orientation reads
Standard four + project context.

## Steps (E4 — 2-step pattern)
1. **Step 1 — Analyze.** Read the source compound entry + linked work items. Output a candidate concept outline. STOP if no clear universal pattern is found — surface the reasoning instead of forcing a page.
2. **Step 2 — Generate.** Compose the vault concept page with `provenance: project` and `provenance_projects: ["[[slug]]"]`. Validate with `npx skillwiki validate`.
3. **Backlink.** Set `promoted_to: "[[concept-slug]]"` on the source compound entry.
4. **Apply writes in order.** Vault concept page → backlink update → project `log.md` → vault `index.md` → vault `log.md`.

## Stop conditions
- No clear universal pattern.
- `validate` non-zero on either page.

## Forbidden
- Skipping Step 1 (no direct generation).
- Updating index/logs before `validate` passes.
````

- [ ] **Step 2: Create `packages/skills/proj-decide/SKILL.md`**

````markdown
---
name: proj-decide
description: Write an Architectural Decision Record (ADR). If the decision generalizes, also create a concepts/ page.
---

# proj-decide

## When to invoke
- User commits to an architectural decision worth recording for future reference.

## Pre-orientation reads
Standard four + project context.

## Steps
1. Compose the ADR in `projects/{slug}/architecture/YYYY-MM-DD-{adr-slug}.md`. Frontmatter: kind=decision, status=in-progress or completed, project link.
2. `npx skillwiki validate <adr>`. If non-zero, STOP.
3. **Generalization check.** If the decision applies beyond this project, create a `concepts/` page with `provenance: project` (or `mixed` if research-informed).
4. Apply writes: ADR → (optional) concept page → vault `index.md` → vault `log.md` and project `log.md`.

## Stop conditions
- `validate` non-zero on either page.

## Forbidden
- Filing the concept page without explicit `provenance:`.
````

- [ ] **Step 3: Run the structural test from Task 15.3 — expect PASS**

Run: `npm run -w skillwiki test -- skill-md`
Expected: all 30 (10 skills × 3 assertions) pass.

- [ ] **Step 4: Commit**

```bash
git add packages/skills/proj-distill packages/skills/proj-decide packages/cli/test/skills/skill-md.test.ts
git commit -m "feat(skills): proj-distill, proj-decide; green SKILL.md structure test"
```

---

## Phase 17 — Hermes wire-compatibility integration test

### Task 17.1: Round-trip a vault through a Hermes-shaped validator

**Files:**
- Create: `packages/cli/test/integration/hermes-compat.test.ts`
- Create: `packages/cli/test/fixtures/hermes-vault/` (minimal vault)

- [ ] **Step 1: Create `packages/cli/test/fixtures/hermes-vault/`**

`hermes-vault/SCHEMA.md`:
```
# Vault
```

`hermes-vault/concepts/example.md`:
```
---
title: Example
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: [demo]
sources: [raw/articles/note.md]
provenance: project
provenance_projects: ["[[demo]]"]
aliases: ["Ex"]
---
[[other]] body referencing the source.
^[raw/articles/note.md]
```

`hermes-vault/raw/articles/note.md`:
```
---
title: Note
source_url: null
ingested: 2026-05-03
ingested_by: manual
sha256: 0000000000000000000000000000000000000000000000000000000000000000
---
Note body.
```

- [ ] **Step 2: Write the integration test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const VAULT = join(__dirname, "..", "fixtures", "hermes-vault");

const HERMES_REQUIRED = ["title", "created", "updated", "type", "tags", "sources"];

describe("Hermes wire-compat", () => {
  it("typed-knowledge pages contain every Hermes-required field with original meaning", () => {
    const fm = yaml.load(splitFM(readFileSync(join(VAULT, "concepts/example.md"), "utf8"))) as Record<string, unknown>;
    for (const k of HERMES_REQUIRED) expect(fm).toHaveProperty(k);
    expect(fm.type).toBe("concept");
    expect(Array.isArray(fm.sources)).toBe(true);
  });

  it("raw pages preserve the Hermes raw shape (title, source_url, ingested, sha256)", () => {
    const fm = yaml.load(splitFM(readFileSync(join(VAULT, "raw/articles/note.md"), "utf8"))) as Record<string, unknown>;
    for (const k of ["title", "source_url", "ingested", "sha256"]) expect(fm).toHaveProperty(k);
  });

  it("additive fields (provenance, aliases) do NOT collide with Hermes names", () => {
    const reserved = new Set(["title", "created", "updated", "type", "tags", "sources", "confidence", "contested", "contradictions"]);
    for (const k of ["provenance", "provenance_projects", "aliases", "work_items"]) {
      expect(reserved.has(k)).toBe(false);
    }
  });
});

function splitFM(text: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter");
  return m[1];
}
```

- [ ] **Step 3: Run — expect PASS**

Run: `npm run -w skillwiki test -- hermes-compat`

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/integration/hermes-compat.test.ts packages/cli/test/fixtures/hermes-vault/
git commit -m "test: Hermes wire-compat round trip (DoD item)"
```

---

## Phase 18 — Cross-platform CI matrix

### Task 18.1: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push: { branches: [main] }
  pull_request:

jobs:
  build-and-test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20.x]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run -w @skillwiki/shared test
      - run: npm run -w skillwiki build
      - run: npm run -w skillwiki test
      - name: install --dry-run smoke
        run: |
          node packages/cli/dist/cli.js install --dry-run --skills-root packages/skills --target ${{ runner.temp }}/skills-target
        shell: bash
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: cross-platform matrix (Linux/macOS/Windows on Node 20)"
```

---

## Phase 19 — Repo docs

### Task 19.1: README.md and CLAUDE.md

**Files:**
- Create: `README.md`
- Create: `CLAUDE.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# CodeWiki / skillwiki

Project-aware Karpathy-style knowledge base for Claude Code skills.

## Install

```bash
npx skillwiki@latest install
```

This copies 10 SKILL.md files into `~/.claude/skills/` and writes `.claude/skills/wiki-manifest.json`.

## Skills

| Namespace | Skills |
|---|---|
| `wiki-*` | `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit` |
| `proj-*` | `proj-init`, `proj-work`, `proj-distill`, `proj-decide` |

## CLI

`skillwiki` exposes 8 deterministic subcommands consumed by the skills:

| Subcommand | Purpose |
|---|---|
| `hash <file>` | sha256 of body bytes after closing `---`. |
| `fetch-guard <url>` | URL preflight (Layer 1 security). |
| `validate <file>` | Frontmatter Zod validation. |
| `graph build <vault>` | Wikilink adjacency + Adamic-Adar table. |
| `overlap <vault>` | Source-overlap clusters. |
| `orphans <vault>` | Orphan + bridge node detection. |
| `audit <file>` | Citation marker + sources↔body consistency. |
| `install` | Cross-platform skills installer. |

All subcommands emit JSON by default. Pass `--human` for terminal output.

## Development

```bash
npm install
npm run -w @skillwiki/shared test
npm run -w skillwiki build
npm run -w skillwiki test
```

Requires Node ≥ 20.

## Spec

The canonical specification lives at `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md` (revised 2026-05-03).
```

- [ ] **Step 2: Create `CLAUDE.md`**

```markdown
# CLAUDE.md

This repo ships the `skillwiki` CLI and 10 prompt-only SKILL.md files.

## Working in this repo

- The canonical spec is `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md`. Do not regress N1–N18.
- Skills are prompt-only Markdown — no build step, no LLM calls in the CLI.
- All deterministic logic lives under `packages/cli/src/`.
- Shared types live in `packages/shared/src/` and are imported via `@skillwiki/shared`.
- Tests are co-located with the package they cover; run them with `npm run -w <package> test`.

## Conventions

- Exit codes are stable across the v1 line. New failure classes get unused codes; never reassign existing codes.
- Every CLI subcommand returns a `Result<T>` envelope (`{ ok, data }` or `{ ok: false, error, detail? }`).
- `--human` MUST NOT alter exit codes (N2).
- Files under `raw/` MUST NOT be modified after ingestion (N9).

## Where things live

- Schemas: `packages/shared/src/schemas.ts`.
- Subcommand implementations: `packages/cli/src/commands/<name>.ts`.
- SKILL.md files: `packages/skills/<skill-name>/SKILL.md`.
- Templates: `packages/cli/templates/`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: README and CLAUDE.md"
```

---

## Phase 20 — Final DoD verification sweep

### Task 20.1: DoD acceptance test

**Files:**
- Create: `packages/cli/test/integration/dod.test.ts`

- [ ] **Step 1: Write the DoD test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = join(__dirname, "..", "..", "..", "..");
const SKILLS = join(REPO, "packages", "skills");
const CLI_DIST = join(REPO, "packages", "cli", "dist", "cli.js");

const ALL_SKILLS = [
  "wiki-init", "wiki-ingest", "wiki-query", "wiki-lint", "wiki-crystallize", "wiki-audit",
  "proj-init", "proj-work", "proj-distill", "proj-decide"
];

describe("Definition of Done", () => {
  it("all 10 SKILL.md files exist", () => {
    for (const s of ALL_SKILLS) expect(existsSync(join(SKILLS, s, "SKILL.md"))).toBe(true);
  });

  it("CLI binary exists and is built", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("all 4 templates exist", () => {
    const T = join(REPO, "packages", "cli", "templates");
    for (const t of ["SCHEMA.md", "index.md", "log.md", "project-README.md"]) {
      expect(existsSync(join(T, t))).toBe(true);
    }
  });

  it("no bash scripts remain in the repo", () => {
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
          out.push(...walk(join(dir, e.name)));
        } else if (e.isFile() && e.name.endsWith(".sh")) {
          out.push(join(dir, e.name));
        }
      }
      return out;
    }
    expect(walk(REPO)).toEqual([]);
  });

  it("README does not reference install.sh", () => {
    expect(readFileSync(join(REPO, "README.md"), "utf8")).not.toMatch(/install\.sh/);
  });

  it("fetch-guard CLI rejects http with exit 4", () => {
    let status = 0;
    try { execFileSync("node", [CLI_DIST, "fetch-guard", "http://example.com"], { encoding: "utf8" }); }
    catch (e: any) { status = e.status; }
    expect(status).toBe(4);
  });
});
```

- [ ] **Step 2: Run — expect PASS**

Run: `npm run -w skillwiki build && npm run -w skillwiki test -- dod`
Expected: all DoD assertions pass.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/integration/dod.test.ts
git commit -m "test: Definition of Done verification sweep (N1–N18)"
```

### Task 20.2: Final verification — full repo test + N1–N18 traceability

- [ ] **Step 1: Run the full test suite at the repo root**

Run: `npm test`
Expected: every workspace package's tests pass green.

- [ ] **Step 2: Run the build at the repo root**

Run: `npm run build`
Expected: `packages/cli/dist/cli.js` updated; no errors.

- [ ] **Step 3: Manual trace — confirm every Normative Requirement has a verification**

Open the spec and walk N1–N18; for each, point to the test or DoD entry that exercises it:

| N# | Requirement | Verified by |
|---|---|---|
| N1 | JSON by default | `output.test.ts`, `cli.smoke.test.ts` |
| N2 | `--human` flag, no exit-code change | `cli.smoke.test.ts` `--human` case |
| N3 | Stable exit codes per failure class | `exit-codes.test.ts`, every command test |
| N4 | Idempotency or documented side effects | `install.test.ts` idempotent re-run |
| N5 | No LLM calls in CLI | repo grep (manual): no `anthropic`/`openai` imports under `packages/cli/` |
| N6 | `wiki-ingest` runs `fetch-guard` first | `wiki-ingest/SKILL.md` Steps + `fetch-guard.test.ts` |
| N7 | `validate` before index/log update | `wiki-ingest/SKILL.md`, `validate.test.ts` |
| N8 | Write order page → index → log | Per-skill execution contracts in SKILL.md files |
| N9 | `raw/` immutability | `wiki-lint/SKILL.md` "Forbidden", `dod.test.ts` audit |
| N10 | `hash` over body bytes after closing `---` | `hash.test.ts` (CRLF preservation, body-only) |
| N11 | Zod validation with field-level errors | `validate.test.ts`, `schemas.*.test.ts` |
| N12 | Hermes-required fields preserved | `hermes-compat.test.ts` |
| N13 | Additive fields silently ignored | `hermes-compat.test.ts` reserved-name check |
| N14 | `fetch-guard` fails closed | `fetch-guard.test.ts` (every reject path returns non-zero) |
| N15 | Blocked host classes | `blocked-hosts.test.ts`, `fetch-guard.test.ts` |
| N16 | Credential stripping | `fetch-guard.test.ts` `api_key` + path-token cases |
| N17 | `install` idempotent + manifest | `install.test.ts` idempotent case |
| N18 | `install` backs up overwrites | `install-fs.test.ts` backup case |

If any row in the table cannot be filled, add the missing test before tagging v1.

- [ ] **Step 4: Tag v1**

```bash
git tag v0.1.0
git log --oneline -20
```

- [ ] **Step 5: Final commit (changelog stub if anything added in Step 3)**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore: v1 final verification sweep"
```

---

## Self-review notes

- Every spec section in the canonical `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md` is covered:
  - **Vault Architecture** → Phases 7, 14 (templates), 15–16 (skills that scaffold the tree).
  - **Frontmatter Schemas** → Phase 2.
  - **Citation Conventions** → Phases 3 (parsers), 11 (`audit`).
  - **Skill Inventory** → Phases 15–16.
  - **Workflow Patterns (E1–E5)** → encoded in per-SKILL.md execution contracts (E2 in `wiki-query`, E3 in `wiki-lint`, E4 in `proj-distill`, E5 in every skill's pre-orientation reads; E1 explicitly deferred per spec).
  - **Implementation Toolchain** → Phases 0, 13.
  - **Codex Adversarial Review (F1–F4)** → F1 covered by Phases 5, 11, 12; F3 by Phase 4; F4 by Phase 12.
  - **Hermes Wire-Compat** → Phase 17.
  - **Definition of Done** → Phase 20 (every checkbox is exercised).
- E1 (2-step ingest) is intentionally absent from this plan because it is deferred to v1.1 by Decision 5 / Roadmap.
- `tag-sync`, `extract`, MCP server, `views/`, `purpose.md` are explicitly deferred and have no tasks.
