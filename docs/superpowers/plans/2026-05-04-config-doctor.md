# Config & Doctor Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `skillwiki config` (get/set/list/path) and `skillwiki doctor` (pre-flight diagnostic) subcommands to the CLI.

**Architecture:** Two new command modules (`config.ts`, `doctor.ts`) backed by the existing `~/.skillwiki/.env` store. A new `writeDotenv` function in `dotenv.ts` enables config writes. Doctor runs 7 synchronous filesystem checks. Both follow the existing `Result<T>` envelope + `emit()` exit pattern.

**Tech Stack:** TypeScript, vitest, Commander.js, Node.js `fs/promises`, `child_process.execSync`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/exit-codes.ts` | Add 4 new exit code constants (26–29) + reverse map entries |
| `packages/cli/src/utils/dotenv.ts` | Add `writeDotenv()` for serialising key-value pairs back to `.env` |
| `packages/cli/src/commands/config.ts` | New: `runConfigGet`, `runConfigSet`, `runConfigList`, `runConfigPath` |
| `packages/cli/src/commands/doctor.ts` | New: `runDoctor` with 7 checks |
| `packages/cli/src/cli.ts` | Register `config` (4 subcommands) and `doctor` commands |
| `packages/cli/test/commands/config.test.ts` | Unit tests for all config subcommands |
| `packages/cli/test/commands/doctor.test.ts` | Unit tests for all 7 doctor checks |

---

### Task 1: Add exit codes 26–29 to shared package

**Files:**
- Modify: `packages/shared/src/exit-codes.ts`

- [ ] **Step 1: Add the 4 new exit code constants and reverse-map entries**

Append after line 26 (`NO_VAULT_CONFIGURED: 25`):

```typescript
  INVALID_CONFIG_KEY: 26,
  CONFIG_WRITE_FAILED: 27,
  DOCTOR_HAS_WARNINGS: 28,
  DOCTOR_HAS_ERRORS: 29
```

And in the `NAMES` record, append after line 56 (`25: "NO_VAULT_CONFIGURED"`):

```typescript
  26: "INVALID_CONFIG_KEY",
  27: "CONFIG_WRITE_FAILED",
  28: "DOCTOR_HAS_WARNINGS",
  29: "DOCTOR_HAS_ERRORS"
```

- [ ] **Step 2: Run shared package tests to verify no regressions**

Run: `npm run -w @skillwiki/shared test`
Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/exit-codes.ts
git commit -m "feat(shared): add exit codes 26–29 for config and doctor commands"
```

---

### Task 2: Add `writeDotenv` to dotenv utility

**Files:**
- Modify: `packages/cli/src/utils/dotenv.ts`
- Test: `packages/cli/test/utils/dotenv.test.ts` (new)

`writeDotenv(filePath, entries, originalContent?)` serialises a key-value map to a `.env` file. When `originalContent` is provided, it updates existing key lines in-place (preserving comments and blank lines) and appends new keys at the end. When not provided (file is new), it writes a fresh file.

- [ ] **Step 1: Write failing tests for `writeDotenv`**

Create `packages/cli/test/utils/dotenv.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenvFile, writeDotenv } from "../../src/utils/dotenv.js";

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dotenv-"));
  return d;
}

describe("writeDotenv", () => {
  it("creates a new file with the given entries", async () => {
    const dir = tmp();
    const filePath = join(dir, ".env");
    await writeDotenv(filePath, { WIKI_PATH: "/my/vault" }, undefined);
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("WIKI_PATH=/my/vault");
  });

  it("creates parent directories if missing", async () => {
    const dir = tmp();
    const filePath = join(dir, "sub", "dir", ".env");
    await writeDotenv(filePath, { WIKI_LANG: "zh" }, undefined);
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("WIKI_LANG=zh");
  });

  it("updates an existing key while preserving comments and blank lines", async () => {
    const dir = tmp();
    const filePath = join(dir, ".env");
    const original = "# my config\nWIKI_PATH=/old\n\nWIKI_LANG=en\n";
    writeFileSync(filePath, original);
    await writeDotenv(filePath, { WIKI_PATH: "/new" }, original);
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("# my config");
    expect(text).toContain("WIKI_PATH=/new");
    expect(text).not.toContain("WIKI_PATH=/old");
    expect(text).toContain("WIKI_LANG=en");
  });

  it("appends a new key to an existing file", async () => {
    const dir = tmp();
    const filePath = join(dir, ".env");
    const original = "WIKI_PATH=/vault\n";
    writeFileSync(filePath, original);
    await writeDotenv(filePath, { WIKI_LANG: "ja" }, original);
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("WIKI_PATH=/vault");
    expect(text).toContain("WIKI_LANG=ja");
  });

  it("round-trips through parseDotenvFile", async () => {
    const dir = tmp();
    const filePath = join(dir, ".env");
    await writeDotenv(filePath, { WIKI_PATH: "/rt", WIKI_LANG: "de" }, undefined);
    const parsed = await parseDotenvFile(filePath);
    expect(parsed).toEqual({ WIKI_PATH: "/rt", WIKI_LANG: "de" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/test/utils/dotenv.test.ts`
Expected: FAIL — `writeDotenv` is not exported.

- [ ] **Step 3: Implement `writeDotenv`**

Append to `packages/cli/src/utils/dotenv.ts`:

```typescript
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeDotenv(
  filePath: string,
  entries: DotenvMap,
  originalContent?: string
): Promise<void> {
  const lines = originalContent !== undefined
    ? updateLines(originalContent, entries)
    : freshLines(entries);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

function freshLines(entries: DotenvMap): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out.push(`${key}=${value}`);
  }
  return out;
}

function updateLines(originalContent: string, entries: DotenvMap): string[] {
  const rawLines = originalContent.split(/\r?\n/);
  const keysToWrite = new Set(Object.keys(entries));
  const out: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) { out.push(line); continue; }
    const key = trimmed.slice(0, eq).trim();
    if (keysToWrite.has(key) && entries[key as keyof DotenvMap] !== undefined) {
      out.push(`${key}=${entries[key as keyof DotenvMap]}`);
      keysToWrite.delete(key);
    } else if (keysToWrite.has(key)) {
      // key is being removed — skip the line
      keysToWrite.delete(key);
    } else {
      out.push(line);
    }
  }

  // Append any keys not found in the original file
  for (const key of keysToWrite) {
    const value = entries[key as keyof DotenvMap];
    if (value !== undefined) out.push(`${key}=${value}`);
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/cli/test/utils/dotenv.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/utils/dotenv.ts packages/cli/test/utils/dotenv.test.ts
git commit -m "feat(cli): add writeDotenv utility for config set command"
```

---

### Task 3: Implement `config` command

**Files:**
- Create: `packages/cli/src/commands/config.ts`
- Create: `packages/cli/test/commands/config.test.ts`

The config command exposes 4 subcommands: `get`, `set`, `list`, `path`. Each returns `{ exitCode, result }` matching the existing pattern.

- [ ] **Step 1: Write failing tests for config subcommands**

Create `packages/cli/test/commands/config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigGet, runConfigSet, runConfigList, runConfigPath } from "../../src/commands/config.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("runConfigGet", () => {
  it("returns value when key is set", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/my/vault\n");
    const r = await runConfigGet({ key: "WIKI_PATH", home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.key).toBe("WIKI_PATH");
      expect(r.result.data.value).toBe("/my/vault");
    }
  });

  it("returns error when key is not set", async () => {
    const h = home();
    const r = await runConfigGet({ key: "WIKI_LANG", home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.key).toBe("WIKI_LANG");
      expect(r.result.data.value).toBe("");
    }
  });

  it("rejects invalid key with exit 26", async () => {
    const h = home();
    const r = await runConfigGet({ key: "BAD_KEY", home: h });
    expect(r.exitCode).toBe(26);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe("INVALID_CONFIG_KEY");
  });
});

describe("runConfigSet", () => {
  it("writes a new key to existing file", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/old\n");
    const r = await runConfigSet({ key: "WIKI_PATH", value: "/new", home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.key).toBe("WIKI_PATH");
      expect(r.result.data.value).toBe("/new");
      expect(r.result.data.written).toBe(true);
    }
    const text = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(text).toContain("WIKI_PATH=/new");
    expect(text).not.toContain("WIKI_PATH=/old");
  });

  it("creates .skillwiki/.env when it does not exist", async () => {
    const h = home();
    // no .skillwiki dir yet — remove it
    const r = await runConfigSet({ key: "WIKI_PATH", value: "/fresh", home: h });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(h, ".skillwiki", ".env"))).toBe(true);
  });

  it("rejects invalid key with exit 26", async () => {
    const h = home();
    const r = await runConfigSet({ key: "INVALID", value: "x", home: h });
    expect(r.exitCode).toBe(26);
    expect(r.result.ok).toBe(false);
  });
});

describe("runConfigList", () => {
  it("returns all key-value pairs", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/v\nWIKI_LANG=ja\n");
    const r = await runConfigList({ home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries).toEqual([
        { key: "WIKI_PATH", value: "/v" },
        { key: "WIKI_LANG", value: "ja" }
      ]);
    }
  });

  it("returns empty entries when no config file exists", async () => {
    const h = home();
    const r = await runConfigList({ home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries).toEqual([]);
    }
  });
});

describe("runConfigPath", () => {
  it("returns path and exists=true when file present", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/v\n");
    const r = await runConfigPath({ home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.path).toBe(join(h, ".skillwiki", ".env"));
      expect(r.result.data.exists).toBe(true);
    }
  });

  it("returns path and exists=false when file absent", async () => {
    const h = home();
    const r = await runConfigPath({ home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.path).toBe(join(h, ".skillwiki", ".env"));
      expect(r.result.data.exists).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/test/commands/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.ts`**

Create `packages/cli/src/commands/config.ts`:

```typescript
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { parseDotenvFile, writeDotenv } from "../utils/dotenv.js";
import { readFile } from "node:fs/promises";

const VALID_KEYS = new Set(["WIKI_PATH", "WIKI_LANG"]);

function configPath(home: string): string {
  return join(home, ".skillwiki", ".env");
}

function validateKey(key: string): key is "WIKI_PATH" | "WIKI_LANG" {
  return VALID_KEYS.has(key);
}

// --- config get ---

export interface ConfigGetInput {
  key: string;
  home: string;
}
export interface ConfigGetOutput {
  key: string;
  value: string;
}

export async function runConfigGet(
  input: ConfigGetInput
): Promise<{ exitCode: number; result: Result<ConfigGetOutput> }> {
  if (!validateKey(input.key)) {
    return { exitCode: ExitCode.INVALID_CONFIG_KEY, result: err("INVALID_CONFIG_KEY", { key: input.key }) };
  }
  const map = await parseDotenvFile(configPath(input.home));
  const value = map[input.key] ?? "";
  return { exitCode: ExitCode.OK, result: ok({ key: input.key, value }) };
}

// --- config set ---

export interface ConfigSetInput {
  key: string;
  value: string;
  home: string;
}
export interface ConfigSetOutput {
  key: string;
  value: string;
  written: true;
}

export async function runConfigSet(
  input: ConfigSetInput
): Promise<{ exitCode: number; result: Result<ConfigSetOutput> }> {
  if (!validateKey(input.key)) {
    return { exitCode: ExitCode.INVALID_CONFIG_KEY, result: err("INVALID_CONFIG_KEY", { key: input.key }) };
  }
  const filePath = configPath(input.home);
  let originalContent: string | undefined;
  try { originalContent = await readFile(filePath, "utf8"); } catch { /* file doesn't exist yet */ }

  const existing = originalContent !== undefined
    ? await parseDotenvFile(filePath)
    : {};

  const updated = { ...existing, [input.key]: input.value };

  try {
    await writeDotenv(filePath, updated, originalContent);
  } catch (e) {
    return { exitCode: ExitCode.CONFIG_WRITE_FAILED, result: err("CONFIG_WRITE_FAILED", { error: String(e) }) };
  }

  return { exitCode: ExitCode.OK, result: ok({ key: input.key, value: input.value, written: true }) };
}

// --- config list ---

export interface ConfigListInput {
  home: string;
}
export interface ConfigListOutput {
  entries: Array<{ key: string; value: string }>;
}

export async function runConfigList(
  input: ConfigListInput
): Promise<{ exitCode: number; result: Result<ConfigListOutput> }> {
  const map = await parseDotenvFile(configPath(input.home));
  const entries = Object.entries(map).map(([key, value]) => ({ key, value: value ?? "" }));
  return { exitCode: ExitCode.OK, result: ok({ entries }) };
}

// --- config path ---

export interface ConfigPathInput {
  home: string;
}
export interface ConfigPathOutput {
  path: string;
  exists: boolean;
}

export async function runConfigPath(
  input: ConfigPathInput
): Promise<{ exitCode: number; result: Result<ConfigPathOutput> }> {
  const filePath = configPath(input.home);
  let exists = false;
  try {
    await readFile(filePath, "utf8");
    exists = true;
  } catch { /* doesn't exist */ }
  return { exitCode: ExitCode.OK, result: ok({ path: filePath, exists }) };
}
```

- [ ] **Step 4: Run config tests to verify they pass**

Run: `npx vitest run packages/cli/test/commands/config.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/config.ts packages/cli/test/commands/config.test.ts
git commit -m "feat(cli): add config get/set/list/path subcommands"
```

---

### Task 4: Implement `doctor` command

**Files:**
- Create: `packages/cli/src/commands/doctor.ts`
- Create: `packages/cli/test/commands/doctor.test.ts`

Doctor runs 7 synchronous checks. Each check produces `{ id, label, status, detail }`. The overall exit code depends on whether any check has `error` (exit 29) or only `warn` (exit 28).

- [ ] **Step 1: Write failing tests for doctor**

Create `packages/cli/test/commands/doctor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/commands/doctor.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  for (const d of ["raw", "entities", "concepts", "meta"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

const SCHEMA = `# Vault Schema\n\n## Tag Taxonomy\n\n\`\`\`yaml\ntaxonomy:\n  - model\n\`\`\`\n`;

function fullVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  for (const d of ["raw", "entities", "concepts", "meta"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

describe("runDoctor", () => {
  it("all-pass returns exit 0", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, envLang: undefined, argv: ["node", "skillwiki", "doctor"] });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.summary.error).toBe(0);
      expect(r.result.data.summary.warn).toBe(0);
    }
  });

  it("missing config file gives warn for config_file check", async () => {
    const h = home();
    // no .env written
    const r = await runDoctor({ home: h, envValue: undefined, envLang: undefined, argv: ["node", "skillwiki", "doctor"] });
    if (r.result.ok) {
      const cfg = r.result.data.checks.find(c => c.id === "config_file");
      expect(cfg?.status).toBe("warn");
    }
  });

  it("missing WIKI_PATH gives error for wiki_path_set check", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "# empty\n");
    const r = await runDoctor({ home: h, envValue: undefined, envLang: undefined, argv: ["node", "skillwiki", "doctor"] });
    if (r.result.ok) {
      const wp = r.result.data.checks.find(c => c.id === "wiki_path_set");
      expect(wp?.status).toBe("error");
      expect(r.exitCode).toBe(29); // DOCTOR_HAS_ERRORS
    }
  });

  it("WIKI_PATH pointing to non-existent dir gives error for wiki_path_exists", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/no/such/dir\n");
    const r = await runDoctor({ home: h, envValue: undefined, envLang: undefined, argv: ["node", "skillwiki", "doctor"] });
    if (r.result.ok) {
      const wpe = r.result.data.checks.find(c => c.id === "wiki_path_exists");
      expect(wpe?.status).toBe("error");
    }
  });

  it("vault missing subdirs gives error for vault_structure", async () => {
    const h = home();
    const v = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
    // no subdirs
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, envLang: undefined, argv: ["node", "skillwiki", "doctor"] });
    if (r.result.ok) {
      const vs = r.result.data.checks.find(c => c.id === "vault_structure");
      expect(vs?.status).toBe("error");
    }
  });

  it("warn-only scenario returns exit 28", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    // Force cli_on_path to warn by using a cli.js argv
    const r = await runDoctor({ home: h, envValue: undefined, envLang: undefined, argv: ["node", "/path/to/cli.js", "doctor"] });
    if (r.result.ok) {
      const cli = r.result.data.checks.find(c => c.id === "cli_on_path");
      expect(cli?.status).toBe("warn");
      // If no other errors, exit should be 28
      if (r.result.data.summary.error === 0 && r.result.data.summary.warn > 0) {
        expect(r.exitCode).toBe(28);
      }
    }
  });

  it("envValue override is used for wiki_path_set resolution", async () => {
    const h = home();
    const v = fullVault();
    // No .env file, but envValue provides the path
    const r = await runDoctor({ home: h, envValue: v, envLang: undefined, argv: ["node", "skillwiki", "doctor"] });
    if (r.result.ok) {
      const wp = r.result.data.checks.find(c => c.id === "wiki_path_set");
      expect(wp?.status).toBe("pass");
    }
  });

  it("always returns exactly 7 checks", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, envLang: undefined, argv: ["node", "skillwiki", "doctor"] });
    if (r.result.ok) {
      expect(r.result.data.checks).toHaveLength(7);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/test/commands/doctor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `doctor.ts`**

Create `packages/cli/src/commands/doctor.ts`:

```typescript
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { parseDotenvFile } from "../utils/dotenv.js";
import { resolveRuntimePath } from "../utils/wiki-path.js";

type CheckStatus = "pass" | "warn" | "error";

interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorInput {
  home: string;
  envValue: string | undefined;
  envLang: string | undefined;
  argv: string[];
}

export interface DoctorOutput {
  checks: CheckResult[];
  summary: { pass: number; warn: number; error: number };
}

export async function runDoctor(
  input: DoctorInput
): Promise<{ exitCode: number; result: Result<DoctorOutput> }> {
  const checks: CheckResult[] = [];

  // Check 1: node_version
  const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
  if (nodeMajor >= 20) {
    checks.push({ id: "node_version", label: "Node.js version", status: "pass", detail: process.version });
  } else {
    checks.push({ id: "node_version", label: "Node.js version", status: "error", detail: `${process.version} (requires >= 20)` });
  }

  // Check 2: cli_on_path
  const runningFromCliJs = input.argv.length >= 2 && input.argv[1].endsWith("cli.js");
  if (runningFromCliJs) {
    checks.push({ id: "cli_on_path", label: "skillwiki on PATH", status: "warn", detail: "running via node cli.js (development mode)" });
  } else {
    try {
      const which = execSync("which skillwiki 2>/dev/null", { encoding: "utf8" }).trim();
      checks.push({ id: "cli_on_path", label: "skillwiki on PATH", status: "pass", detail: which });
    } catch {
      checks.push({ id: "cli_on_path", label: "skillwiki on PATH", status: "warn", detail: "skillwiki not found on PATH" });
    }
  }

  // Check 3: config_file
  const envFilePath = join(input.home, ".skillwiki", ".env");
  if (existsSync(envFilePath)) {
    try {
      await parseDotenvFile(envFilePath);
      checks.push({ id: "config_file", label: "Config file exists", status: "pass", detail: envFilePath });
    } catch {
      checks.push({ id: "config_file", label: "Config file exists", status: "warn", detail: `${envFilePath} exists but is not parseable` });
    }
  } else {
    checks.push({ id: "config_file", label: "Config file exists", status: "warn", detail: `${envFilePath} not found` });
  }

  // Check 4: wiki_path_set
  const resolved = await resolveRuntimePath({
    flag: undefined,
    envValue: input.envValue,
    home: input.home
  });
  let wikiPath: string | undefined;
  if (resolved.ok) {
    wikiPath = resolved.data.path;
    checks.push({ id: "wiki_path_set", label: "WIKI_PATH configured", status: "pass", detail: `${resolved.data.source} WIKI_PATH=${wikiPath}` });
  } else {
    checks.push({ id: "wiki_path_set", label: "WIKI_PATH configured", status: "error", detail: "No WIKI_PATH found in flag, env, or dotenv" });
  }

  // Check 5: wiki_path_exists
  if (wikiPath !== undefined) {
    if (existsSync(wikiPath) && statSync(wikiPath).isDirectory()) {
      checks.push({ id: "wiki_path_exists", label: "Vault directory exists", status: "pass", detail: wikiPath });
    } else {
      checks.push({ id: "wiki_path_exists", label: "Vault directory exists", status: "error", detail: `${wikiPath} does not exist or is not a directory` });
    }
  } else {
    checks.push({ id: "wiki_path_exists", label: "Vault directory exists", status: "error", detail: "WIKI_PATH not configured" });
  }

  // Check 6: vault_structure
  const requiredSubdirs = ["raw", "entities", "concepts", "meta"];
  if (wikiPath !== undefined && existsSync(wikiPath)) {
    const hasSchema = existsSync(join(wikiPath, "SCHEMA.md"));
    const presentSubdirs = requiredSubdirs.filter(d => {
      const p = join(wikiPath, d);
      return existsSync(p) && statSync(p).isDirectory();
    });
    if (hasSchema && presentSubdirs.length === 4) {
      checks.push({ id: "vault_structure", label: "Vault structure valid", status: "pass", detail: `SCHEMA.md present, ${presentSubdirs.length}/4 subdirs present` });
    } else {
      const missing = requiredSubdirs.filter(d => !presentSubdirs.includes(d));
      const parts: string[] = [];
      if (!hasSchema) parts.push("SCHEMA.md missing");
      if (missing.length > 0) parts.push(`missing subdirs: ${missing.join(", ")}`);
      checks.push({ id: "vault_structure", label: "Vault structure valid", status: "error", detail: parts.join("; ") });
    }
  } else {
    checks.push({ id: "vault_structure", label: "Vault structure valid", status: "error", detail: "WIKI_PATH not configured or does not exist" });
  }

  // Check 7: skills_installed
  const skillsDir = join(input.home, ".claude", "skills");
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = countSkillFiles(skillsDir);
  }
  if (skillCount > 0) {
    checks.push({ id: "skills_installed", label: "Skills installed", status: "pass", detail: `${skillCount} SKILL.md file${skillCount === 1 ? "" : "s"} found` });
  } else {
    checks.push({ id: "skills_installed", label: "Skills installed", status: "warn", detail: "No SKILL.md files found in ~/.claude/skills/" });
  }

  // Summary
  const summary = {
    pass: checks.filter(c => c.status === "pass").length,
    warn: checks.filter(c => c.status === "warn").length,
    error: checks.filter(c => c.status === "error").length
  };

  let exitCode: number = ExitCode.OK;
  if (summary.error > 0) exitCode = ExitCode.DOCTOR_HAS_ERRORS;
  else if (summary.warn > 0) exitCode = ExitCode.DOCTOR_HAS_WARNINGS;

  return { exitCode, result: ok({ checks, summary }) };
}

function countSkillFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countSkillFiles(join(dir, entry.name));
    } else if (entry.name === "SKILL.md") {
      count++;
    }
  }
  return count;
}
```

- [ ] **Step 4: Run doctor tests to verify they pass**

Run: `npx vitest run packages/cli/test/commands/doctor.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor.ts packages/cli/test/commands/doctor.test.ts
git commit -m "feat(cli): add doctor diagnostic command with 7 checks"
```

---

### Task 5: Register commands in `cli.ts`

**Files:**
- Modify: `packages/cli/src/cli.ts`

Add the `config` parent command with 4 subcommands and the `doctor` command, following the existing registration patterns.

- [ ] **Step 1: Add imports at the top of cli.ts**

After the existing import block (line 22), add:

```typescript
import { runConfigGet, runConfigSet, runConfigList, runConfigPath } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
```

- [ ] **Step 2: Register config and doctor commands before `program.parseAsync`**

Insert before line 200 (`program.parseAsync(process.argv)...`):

```typescript
// config — grouped under a parent command
const configCmd = program.command("config").description("manage skillwiki configuration");

configCmd
  .command("get <key>")
  .description("print the value of a config key")
  .action(async (key) => emit(await runConfigGet({ key, home: process.env.HOME ?? "" })));

configCmd
  .command("set <key> <value>")
  .description("set a config key value")
  .action(async (key, value) => emit(await runConfigSet({ key, value, home: process.env.HOME ?? "" })));

configCmd
  .command("list")
  .description("list all config key=value pairs")
  .action(async () => emit(await runConfigList({ home: process.env.HOME ?? "" })));

configCmd
  .command("path")
  .description("print the config file path")
  .action(async () => emit(await runConfigPath({ home: process.env.HOME ?? "" })));

// doctor
program
  .command("doctor")
  .description("diagnose skillwiki setup issues")
  .action(async () => emit(await runDoctor({
    home: process.env.HOME ?? "",
    envValue: process.env.WIKI_PATH,
    envLang: process.env.WIKI_LANG,
    argv: process.argv
  })));
```

- [ ] **Step 3: Build and smoke-test**

Run: `npm run -w @skillwiki/cli build`
Then: `node packages/cli/dist/cli.js config path`
Expected: prints JSON with `{"ok":true,"data":{"path":"<home>/.skillwiki/.env","exists":<bool>}}`

Run: `node packages/cli/dist/cli.js doctor`
Expected: prints JSON with `checks` array containing 7 entries.

- [ ] **Step 4: Run the full test suite**

Run: `npm run -w @skillwiki/cli test`
Expected: All tests pass (including the new config and doctor tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): register config and doctor commands in CLI"
```

---

### Task 6: Add `--human` rendering for config and doctor

**Files:**
- Modify: `packages/cli/src/utils/output.ts`
- Modify: `packages/cli/src/commands/config.ts`
- Modify: `packages/cli/src/commands/doctor.ts`

The current `printHuman` function uses `formatData` which JSON-serialises the data. For config and doctor we want custom human-readable output. The cleanest approach: add an optional `humanHint` field to the result data that `printHuman` checks for, avoiding changes to the shared `Result<T>` type.

- [ ] **Step 1: Update config commands to include `humanHint`**

In `packages/cli/src/commands/config.ts`, add a `humanHint` field to each output interface and populate it:

```typescript
export interface ConfigGetOutput {
  key: string;
  value: string;
  humanHint: string;
}
```

In `runConfigGet`, change the return to:
```typescript
return { exitCode: ExitCode.OK, result: ok({ key: input.key, value, humanHint: value }) };
```

For `runConfigSet`:
```typescript
export interface ConfigSetOutput {
  key: string;
  value: string;
  written: true;
  humanHint: string;
}
```
Populate: `humanHint: \`\${input.key}=\${input.value}\``

For `runConfigList`:
```typescript
export interface ConfigListOutput {
  entries: Array<{ key: string; value: string }>;
  humanHint: string;
}
```
Populate: `humanHint: entries.map(e => \`\${e.key}=\${e.value}\`).join("\\n")`

For `runConfigPath`:
```typescript
export interface ConfigPathOutput {
  path: string;
  exists: boolean;
  humanHint: string;
}
```
Populate: `humanHint: filePath`

- [ ] **Step 2: Update doctor to include `humanHint`**

In `packages/cli/src/commands/doctor.ts`, add `humanHint` to `DoctorOutput`:

```typescript
export interface DoctorOutput {
  checks: CheckResult[];
  summary: { pass: number; warn: number; error: number };
  humanHint: string;
}
```

Build the hint string after the summary:

```typescript
const statusIcon: Record<CheckStatus, string> = { pass: "✓", warn: "⚠", error: "✗" };
const lines = checks.map(c => {
  const icon = statusIcon[c.status];
  const padded = c.label.padEnd(24);
  return `  ${icon} ${padded} ${c.detail}`;
});
lines.push("");
lines.push(`${summary.pass} pass · ${summary.warn} warn · ${summary.error} error`);
const humanHint = lines.join("\n");
```

Then include `humanHint` in the `ok()` call.

- [ ] **Step 3: Update `printHuman` in output.ts to use `humanHint` when present**

In `packages/cli/src/utils/output.ts`, update `printHuman`:

```typescript
export function printHuman<T>(r: Result<T>): void {
  if (r.ok) {
    if (typeof r.data === "object" && r.data !== null && "humanHint" in r.data) {
      process.stdout.write(`${(r.data as { humanHint: string }).humanHint}\n`);
    } else {
      process.stdout.write(`OK\n${formatData(r.data)}\n`);
    }
  } else {
    process.stdout.write(`ERR ${r.error}\n${r.detail !== undefined ? formatData(r.detail) + "\n" : ""}`);
  }
}
```

- [ ] **Step 4: Run full test suite**

Run: `npm run -w @skillwiki/cli test`
Expected: All tests pass.

- [ ] **Step 5: Smoke-test human output**

Run: `node packages/cli/dist/cli.js --human config path`
Expected: prints just the file path.

Run: `node packages/cli/dist/cli.js --human doctor`
Expected: prints a table with ✓/⚠/✗ icons and summary line.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/utils/output.ts packages/cli/src/commands/config.ts packages/cli/src/commands/doctor.ts
git commit -m "feat(cli): add --human rendering for config and doctor commands"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| `config get <key>` | Task 3 |
| `config set <key> <value>` | Task 3 |
| `config list` | Task 3 |
| `config path` | Task 3 |
| Valid keys whitelist (WIKI_PATH, WIKI_LANG only) | Task 3 |
| Exit code 26 (INVALID_CONFIG_KEY) | Task 1 + Task 3 |
| Exit code 27 (CONFIG_WRITE_FAILED) | Task 1 + Task 3 |
| `writeDotenv` preserving comments/blank lines | Task 2 |
| Creates `~/.skillwiki/` and `.env` on set | Task 2 (mkdir recursive) + Task 3 |
| `doctor` with 7 checks | Task 4 |
| Exit code 28 (DOCTOR_HAS_WARNINGS) | Task 1 + Task 4 |
| Exit code 29 (DOCTOR_HAS_ERRORS) | Task 1 + Task 4 |
| Doctor uses runtime resolution chain | Task 4 (uses `resolveRuntimePath`) |
| `--human` rendering for config | Task 6 |
| `--human` rendering for doctor | Task 6 |
| CLI registration in cli.ts | Task 5 |
| No network calls in doctor | Task 4 (all sync fs checks) |

**2. Placeholder scan:** No TBD, TODO, or "implement later" found. All code blocks contain complete implementations.

**3. Type consistency:** All output interfaces defined in Task 3 (`ConfigGetOutput`, `ConfigSetOutput`, etc.) match the usage in Task 6 when `humanHint` is added. `DoctorOutput` checks array type `CheckResult` is consistent between Task 4 definition and Task 6 hint generation. All function signatures use the `home: string` parameter pattern consistent with existing commands like `path.ts` and `lang.ts`.
