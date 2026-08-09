# FUSE Read-Mirror for `status` and `session-brief` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `skillwiki status` and `skillwiki session-brief` from hanging on sg01's rclone FUSE mount by applying the existing `resolveReadOnlyVaultRoot()` read-mirror pattern that `doctor` and `lint` already use.

**Architecture:** Both commands call `scanVault(input.vault)` directly on the FUSE path. The fix is to call `resolveReadOnlyVaultRoot()` before `scanVault()`, redirecting reads to the sibling git worktree (`/root/wiki-git`) when a FUSE mount is detected. `status` also gains a `read_source` field and updated `humanHint` so the agent knows whether counts are from the live vault or the mirror.

**Tech Stack:** TypeScript, Node.js, vitest

## Global Constraints

- No changes to `packages/cli/src/utils/vault.ts` (`scanVault`, `resolveReadOnlyVaultRoot`, etc. stay unchanged)
- No changes to `packages/cli/src/commands/doctor.ts` or `packages/cli/src/commands/lint.ts` (they already use the mirror)
- Env overrides `SKILLWIKI_VAULT_READ_MIRROR` and `SKILLWIKI_DISABLE_VAULT_READ_MIRROR` continue to work (handled inside `resolveReadOnlyVaultRoot()`)
- Existing tests must pass without modification (they use local temp dirs where `resolveReadOnlyVaultRoot()` returns the same path - no FUSE detected)
- New `read_source` field is additive to `StatusOutput` - does not break existing consumers

---

### Task 1: Add `read_source` to `StatusOutput` and apply read-mirror in `status.ts`

**Files:**
- Modify: `packages/cli/src/commands/status.ts:1-6` (imports)
- Modify: `packages/cli/src/commands/status.ts:13-34` (StatusOutput interface)
- Modify: `packages/cli/src/commands/status.ts:36-42` (runStatus entry point)
- Modify: `packages/cli/src/commands/status.ts:109-130` (humanHint + return)

**Interfaces:**
- Consumes: `resolveReadOnlyVaultRoot` from `../utils/vault.js` (returns `{ root: string; mirrored: boolean }`)
- Consumes: `detectFuseMount` from `../utils/s3-mount-health.js` (returns `{ mountPoint: string; fsType: string } | null`)
- Produces: `StatusOutput.read_source: "live" | "mirror" | "fuse-no-mirror"`

- [ ] **Step 1: Write the failing test**

Add this test to `packages/cli/test/commands/status.test.ts`, after the existing "humanHint is non-empty" test:

```typescript
it("reports read_source=mirror when SKILLWIKI_VAULT_READ_MIRROR is set", async () => {
  const h = makeHome();
  const v = makeVault();
  writeFileSync(join(v, "entities", "foo.md"), "---\ntitle: foo\n---\nbody");

  // Create a mirror vault with SCHEMA.md so resolveReadOnlyVaultRoot picks it up
  const mirror = `${v}-git`;
  mkdirSync(mirror, { recursive: true });
  writeFileSync(join(mirror, "SCHEMA.md"), "# Schema\n");
  mkdirSync(join(mirror, "entities"), { recursive: true });
  writeFileSync(join(mirror, "entities", "mirror-page.md"), "---\ntitle: mirror-page\n---\nbody");

  const prior = process.env.SKILLWIKI_VAULT_READ_MIRROR;
  process.env.SKILLWIKI_VAULT_READ_MIRROR = mirror;
  try {
    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.read_source).toBe("mirror");
      expect(r.result.data.humanHint).toContain("read source: mirror");
      // Page count should come from the mirror, which has mirror-page.md
      expect(r.result.data.page_counts.entities).toBe(1);
      expect(r.result.data.total_pages).toBe(1);
    }
  } finally {
    if (prior === undefined) delete process.env.SKILLWIKI_VAULT_READ_MIRROR;
    else process.env.SKILLWIKI_VAULT_READ_MIRROR = prior;
  }
});

it("reports read_source=live for local vault without mirror", async () => {
  const h = makeHome();
  const v = makeVault();
  writeFileSync(join(v, "entities", "foo.md"), "---\ntitle: foo\n---\nbody");

  // Ensure no mirror env is set
  const prior = process.env.SKILLWIKI_VAULT_READ_MIRROR;
  delete process.env.SKILLWIKI_VAULT_READ_MIRROR;
  try {
    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.read_source).toBe("live");
      expect(r.result.data.humanHint).not.toContain("read source: mirror");
    }
  } finally {
    if (prior !== undefined) process.env.SKILLWIKI_VAULT_READ_MIRROR = prior;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cli/test/commands/status.test.ts --reporter=verbose 2>&1 | grep -E "read_source|mirror|FAIL|PASS"`
Expected: FAIL - `read_source` is `undefined` (property doesn't exist on `StatusOutput`)

- [ ] **Step 3: Add imports to `status.ts`**

In `packages/cli/src/commands/status.ts`, add the two imports after the existing `scanVault` import (line 5):

```typescript
import { scanVault, resolveReadOnlyVaultRoot } from "../utils/vault.js";
import { detectFuseMount } from "../utils/s3-mount-health.js";
```

Replace the existing line 5:
```typescript
import { scanVault } from "../utils/vault.js";
```

- [ ] **Step 4: Add `read_source` to `StatusOutput` interface**

In `packages/cli/src/commands/status.ts`, add `read_source` to the `StatusOutput` interface. After the `last_modified: string;` field (around line 30), add:

```typescript
  read_source: "live" | "mirror" | "fuse-no-mirror";
```

The full interface should look like:

```typescript
export interface StatusOutput {
  vault_path: string;
  schema_version: string;
  lang: string;
  page_counts: {
    entities: number;
    concepts: number;
    comparisons: number;
    queries: number;
    meta: number;
    raw_articles: number;
    raw_transcripts: number;
    work_items: number;
    compound: number;
  };
  total_pages: number;
  last_modified: string;
  read_source: "live" | "mirror" | "fuse-no-mirror";
  humanHint: string;
}
```

- [ ] **Step 5: Apply read-mirror in `runStatus()`**

In `packages/cli/src/commands/status.ts`, replace the entry point of `runStatus()`. Find this code (around line 38-42):

```typescript
  if (!existsSync(input.vault)) {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { vault: input.vault }) };
  }

  const scan = await scanVault(input.vault);
```

Replace with:

```typescript
  if (!existsSync(input.vault)) {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { vault: input.vault }) };
  }

  // Redirect reads to the sibling git worktree on FUSE mounts (e.g. sg01's
  // /root/wiki -> /root/wiki-git). doctor and lint already do this; status
  // and session-brief were missing it, causing hangs on cold rclone VFS.
  const { root: scanRoot, mirrored } = resolveReadOnlyVaultRoot(input.vault);
  let readSource: StatusOutput["read_source"] = "live";
  if (mirrored) {
    readSource = "mirror";
  } else if (detectFuseMount(input.vault)) {
    readSource = "fuse-no-mirror";
  }

  const scan = await scanVault(scanRoot);
```

- [ ] **Step 6: Update `humanHint` and return value**

In `packages/cli/src/commands/status.ts`, update the `humanHint` construction and the return statement. Find the existing `humanHint` array (around line 109-120):

```typescript
  const humanHint = [
    `vault: ${input.vault}`,
    `lang: ${langResult.value}`,
    `total: ${totalPages} pages`,
    `  entities: ${pageCounts.entities}  concepts: ${pageCounts.concepts}  comparisons: ${pageCounts.comparisons}  queries: ${pageCounts.queries}  meta: ${pageCounts.meta}`,
    `  raw: ${rawTotal}  work_items: ${workItems}  compound: ${compound}`,
    `last modified: ${lastModified.slice(0, 10)}`,
  ].join("\n");
```

Replace with:

```typescript
  const hintLines = [
    `vault: ${input.vault}`,
    `lang: ${langResult.value}`,
    `total: ${totalPages} pages`,
    `  entities: ${pageCounts.entities}  concepts: ${pageCounts.concepts}  comparisons: ${pageCounts.comparisons}  queries: ${pageCounts.queries}  meta: ${pageCounts.meta}`,
    `  raw: ${rawTotal}  work_items: ${workItems}  compound: ${compound}`,
    `last modified: ${lastModified.slice(0, 10)}`,
  ];
  if (readSource === "mirror") {
    hintLines.push(`read source: mirror (${scanRoot}) - page counts may lag up to 30m`);
  } else if (readSource === "fuse-no-mirror") {
    hintLines.push(`FUSE vault with no read mirror - status scan may be slow`);
  }
  const humanHint = hintLines.join("\n");
```

Then update the return object to include `read_source`. Find the return statement (around line 127-133):

```typescript
  return {
    exitCode: ExitCode.OK,
    result: ok({
      vault_path: input.vault,
      schema_version: schemaVersion,
      lang: langResult.canonical,
      page_counts: pageCounts,
      total_pages: totalPages,
      last_modified: lastModified,
      humanHint,
    }),
  };
```

Add `read_source: readSource,` before `humanHint`:

```typescript
  return {
    exitCode: ExitCode.OK,
    result: ok({
      vault_path: input.vault,
      schema_version: schemaVersion,
      lang: langResult.canonical,
      page_counts: pageCounts,
      total_pages: totalPages,
      last_modified: lastModified,
      read_source: readSource,
      humanHint,
    }),
  };
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run packages/cli/test/commands/status.test.ts --reporter=verbose`
Expected: PASS - all existing tests + 2 new tests pass

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/status.ts packages/cli/test/commands/status.test.ts
git commit -m "fix: apply read-mirror to status command on FUSE mounts

status.ts called scanVault() directly on the FUSE path, causing hangs
on sg01's rclone mount. Now uses resolveReadOnlyVaultRoot() (same as
doctor and lint) to redirect reads to /root/wiki-git. Adds read_source
field to StatusOutput and a humanHint line when mirrored."
```

---

### Task 2: Apply read-mirror in `session-brief.ts`

**Files:**
- Modify: `packages/cli/src/commands/session-brief.ts:6` (import)
- Modify: `packages/cli/src/commands/session-brief.ts:67-70` (runSessionBrief entry point)

**Interfaces:**
- Consumes: `resolveReadOnlyVaultRoot` from `../utils/vault.js`
- Produces: no interface changes (session-brief output is unchanged)

- [ ] **Step 1: Write the failing test**

Add this test to `packages/cli/test/commands/session-brief.test.ts`:

```typescript
it("uses read mirror when SKILLWIKI_VAULT_READ_MIRROR is set", async () => {
  const vault = await makeVault();
  writeFileSync(join(vault, "entities", "foo.md"), "---\ntitle: foo\n---\nbody");

  // Create a mirror vault with SCHEMA.md and same structure
  const mirror = `${vault}-git`;
  mkdirSync(mirror, { recursive: true });
  writeFileSync(join(mirror, "SCHEMA.md"), "# Schema\n");
  writeFileSync(join(mirror, "index.md"), "# Index\n\n## Meta\n");
  writeFileSync(join(mirror, "log.md"), "# Log\n");
  mkdirSync(join(mirror, "meta"), { recursive: true });
  mkdirSync(join(mirror, "queries"), { recursive: true });
  mkdirSync(join(mirror, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(mirror, "projects", "llm-wiki", "work", "2026-06-11-agent-memory-trends-workflow"), { recursive: true });

  const prior = process.env.SKILLWIKI_VAULT_READ_MIRROR;
  process.env.SKILLWIKI_VAULT_READ_MIRROR = mirror;
  try {
    const r = await runSessionBrief({ vault, project: undefined });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.SKILLWIKI_VAULT_READ_MIRROR;
    else process.env.SKILLWIKI_VAULT_READ_MIRROR = prior;
  }
});
```

- [ ] **Step 2: Run test to verify it fails (or passes spuriously)**

Run: `npx vitest run packages/cli/test/commands/session-brief.test.ts --reporter=verbose`
Expected: May pass or fail - the test verifies that session-brief can complete when a mirror is set. Without the fix, if the mirror has different content the scan would read the original vault. After the fix, it reads from the mirror. The key verification is that it doesn't hang.

- [ ] **Step 3: Add import to `session-brief.ts`**

In `packages/cli/src/commands/session-brief.ts`, replace line 6:

```typescript
import { scanVault, readPage, type VaultPage } from "../utils/vault.js";
```

with:

```typescript
import { scanVault, readPage, resolveReadOnlyVaultRoot, type VaultPage } from "../utils/vault.js";
```

- [ ] **Step 4: Apply read-mirror in `runSessionBrief()`**

In `packages/cli/src/commands/session-brief.ts`, find the `runSessionBrief` entry point (around line 65-70):

```typescript
export async function runSessionBrief(
  input: SessionBriefInput
): Promise<{ exitCode: number; result: Result<SessionBriefOutput> }> {
  const scan = await scanVault(input.vault);
```

Replace with:

```typescript
export async function runSessionBrief(
  input: SessionBriefInput
): Promise<{ exitCode: number; result: Result<SessionBriefOutput> }> {
  // Redirect reads to the sibling git worktree on FUSE mounts (same as
  // doctor, lint, and status). Prevents hangs on sg01's rclone FUSE vault.
  const { root: scanRoot } = resolveReadOnlyVaultRoot(input.vault);
  const scan = await scanVault(scanRoot);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/cli/test/commands/session-brief.test.ts --reporter=verbose`
Expected: PASS - all existing tests + 1 new test pass

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/session-brief.ts packages/cli/test/commands/session-brief.test.ts
git commit -m "fix: apply read-mirror to session-brief on FUSE mounts

session-brief.ts called scanVault() directly on the FUSE path, causing
the same hang as status on sg01. Now uses resolveReadOnlyVaultRoot()
consistent with doctor, lint, and status."
```

---

### Task 3: Full test suite verification

**Files:**
- No file changes - verification only

- [ ] **Step 1: Run the full CLI test suite**

Run: `npx vitest run packages/cli/test/ --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass, no regressions

- [ ] **Step 2: Verify no type errors**

Run: `cd packages/cli && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit (if any cleanup needed)**

If no changes needed, skip. Otherwise:

```bash
git add -A
git commit -m "test: verify full suite passes after read-mirror changes"
```
