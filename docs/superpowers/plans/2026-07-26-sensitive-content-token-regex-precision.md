# Sensitive-content token matcher precision (G1 + G2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the sensitive-content `token` matcher from flagging pure lower-hyphen prose (`this session: incidents-isolate`) and `session://` URL values, without weakening existing secret detection.

**Architecture:** Keep the existing token regex. After a candidate capture is extracted in `collectMatches`, apply two token-only value filters (G1: capture starts with `//`; G2: pure lowercase hyphenated compound). All CLI entrypoints already call `scanSensitiveContent` / `redactSensitiveContent`, so no command wiring changes.

**Tech Stack:** TypeScript, Vitest, Node crypto (existing fingerprinting), monorepo package `packages/cli` (`skillwiki`).

**Spec:** `docs/superpowers/specs/2026-07-26-sensitive-content-token-regex-precision-design.md`

## Global Constraints

- Token matcher only — do not change password, api_key, access_key, provider_key, jwt, cookie, secret, authorization_header, or private_key matchers.
- No entropy threshold in this change.
- No fingerprint allowlist / baseline file.
- No vault content edits and no raw mutation.
- No public API signature changes (`scanSensitiveContent`, `redactSensitiveContent` exports stay the same).
- Helper `isNonSecretTokenCapture` stays unexported; test only through public scan/redact APIs.
- TDD: failing tests first, then minimal implementation.
- Do not bump package version or cut a release in this plan (release is a separate follow-up).

## File map

| File | Responsibility |
|------|----------------|
| `packages/cli/src/utils/sensitive-content.ts` | Add G1/G2 filter; wire into `collectMatches` for `kind === "token"` |
| `packages/cli/test/utils/sensitive-content.test.ts` | Regression tests for FP1/FP2 shapes + true-positive token still matches |

No new files.

---

### Task 1: Failing tests for G1/G2 token precision

**Files:**
- Modify: `packages/cli/test/utils/sensitive-content.test.ts`
- Test: `packages/cli/test/utils/sensitive-content.test.ts`

**Interfaces:**
- Consumes: `scanSensitiveContent(text, opts?)`, `redactSensitiveContent(text, opts?)` from `../../src/utils/sensitive-content.js`
- Produces: new `describe("token matcher precision (G1/G2)")` block that documents required behavior for Task 2

- [ ] **Step 1: Append the failing test block**

Open `packages/cli/test/utils/sensitive-content.test.ts`. Keep all existing tests. Append this block **before** the final closing `});` of the top-level `describe("sensitive-content", …)` (i.e. as sibling `it`/`describe` children of that suite):

```ts
  describe("token matcher precision (G1/G2)", () => {
    it("ignores pure lower-hyphen prose after bare session: (FP1 shape)", () => {
      const text = "Prior this session: incidents-isolate session-scoped root\n";
      expect(scanSensitiveContent(text)).toEqual([]);
    });

    it("ignores session:// URL scheme captures (FP2 shape)", () => {
      const text = "source_url: session://abc123def456ghi789xyz\n";
      expect(scanSensitiveContent(text)).toEqual([]);
    });

    it("ignores additional pure lower-hyphen session prose", () => {
      const text = "this session: another-long-hyphenated-phrase\n";
      expect(scanSensitiveContent(text)).toEqual([]);
    });

    it("still detects explicit token assignments", () => {
      const secret = "abcdefghijklmnop"; // length 16, not pure lower-hyphen compound
      const findings = scanSensitiveContent(`token: ${secret}\n`);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ kind: "token", line: 1 });
      expect(findings[0]!.preview).toContain("[REDACTED:token:");
      expect(JSON.stringify(findings)).not.toContain(secret);
    });

    it("still detects mixed-shape token values", () => {
      const secret = "tok_aB3dEf9hIjKlMnOpQrStUv";
      const findings = scanSensitiveContent(`token: ${secret}\n`);
      expect(findings.map(f => f.kind)).toContain("token");
      expect(JSON.stringify(findings)).not.toContain(secret);
    });

    it("does not redact FP prose via redactSensitiveContent", () => {
      const text = "Prior this session: incidents-isolate session-scoped root\n";
      const result = redactSensitiveContent(text);
      expect(result.changed).toBe(false);
      expect(result.text).toBe(text);
      expect(result.findings).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run tests and confirm the FP cases fail**

Run:

```bash
cd /Users/karlchow/Desktop/code/llm-wiki/packages/cli && npm test -- test/utils/sensitive-content.test.ts
```

Expected:
- Existing tests: PASS
- `ignores pure lower-hyphen prose…`: **FAIL** (findings non-empty, kind `token`)
- `ignores session:// URL scheme…`: **FAIL** (findings non-empty)
- `ignores additional pure lower-hyphen…`: **FAIL**
- `still detects explicit token assignments`: PASS (already true under current code)
- `still detects mixed-shape token values`: PASS
- `does not redact FP prose…`: **FAIL** (`changed` true or findings non-empty)

Do not implement production code until you see the FP-related failures.

- [ ] **Step 3: Commit the failing tests**

```bash
cd /Users/karlchow/Desktop/code/llm-wiki
git add packages/cli/test/utils/sensitive-content.test.ts
git commit -m "$(cat <<'EOF'
test: add failing G1/G2 sensitive-content token precision cases

Lock FP1 prose and FP2 session:// non-findings before implementing
token capture filters.
EOF
)"
```

---

### Task 2: Implement `isNonSecretTokenCapture` and wire into `collectMatches`

**Files:**
- Modify: `packages/cli/src/utils/sensitive-content.ts` (after `isSyntheticPlaceholder`, inside `collectMatches`)
- Test: `packages/cli/test/utils/sensitive-content.test.ts` (already has Task 1 cases)

**Interfaces:**
- Consumes: existing `Matcher.kind`, captured `value: string`
- Produces: private function

```ts
function isNonSecretTokenCapture(value: string): boolean
```

Returns `true` when the token capture must be skipped (G1 or G2).

- [ ] **Step 1: Add the helper after `isSyntheticPlaceholder`**

In `packages/cli/src/utils/sensitive-content.ts`, immediately after `isSyntheticPlaceholder`:

```ts
/**
 * Token-only value filters (G1/G2).
 * G1: session://… captures as //… under the token matcher.
 * G2: pure lowercase hyphenated English compounds are not credentials.
 */
function isNonSecretTokenCapture(value: string): boolean {
  if (value.startsWith("//")) return true;
  if (/^[a-z]{2,}(?:-[a-z]{2,})+$/.test(value)) return true;
  return false;
}
```

Do not export this function.

- [ ] **Step 2: Wire the filter into `collectMatches`**

In the `matchAll` loop, after:

```ts
      const value = matcher.valueGroup ? m[matcher.valueGroup] : whole;
      if (isSyntheticPlaceholder(value)) continue;
```

insert:

```ts
      if (matcher.kind === "token" && isNonSecretTokenCapture(value)) continue;
```

Full relevant loop body after the change:

```ts
    for (const m of text.matchAll(matcher.re)) {
      const whole = m[0]!;
      const start = m.index ?? 0;
      if (REDACTED_RE.test(whole)) continue;

      const value = matcher.valueGroup ? m[matcher.valueGroup] : whole;
      if (isSyntheticPlaceholder(value)) continue;
      if (matcher.kind === "token" && isNonSecretTokenCapture(value)) continue;

      const valueOffset = whole.lastIndexOf(value);
      const valueStart = start + Math.max(0, valueOffset);
      matches.push({
        start,
        end: start + whole.length,
        valueStart,
        valueEnd: valueStart + value.length,
        kind: matcher.kind,
      });
    }
```

Do **not** change the token regex line. Do **not** alter other matchers.

- [ ] **Step 3: Run unit tests — all must pass**

```bash
cd /Users/karlchow/Desktop/code/llm-wiki/packages/cli && npm test -- test/utils/sensitive-content.test.ts
```

Expected: all tests in that file PASS, including the new G1/G2 block and the full pre-existing suite.

- [ ] **Step 4: Quick local reproduction (optional but recommended)**

From monorepo root (tsx/node as available). Prefer running the same Vitest file; if you want a one-liner against source:

```bash
cd /Users/karlchow/Desktop/code/llm-wiki/packages/cli && npx vitest run test/utils/sensitive-content.test.ts
```

Expected: exit code 0.

- [ ] **Step 5: Commit implementation**

```bash
cd /Users/karlchow/Desktop/code/llm-wiki
git add packages/cli/src/utils/sensitive-content.ts packages/cli/test/utils/sensitive-content.test.ts
git commit -m "$(cat <<'EOF'
fix: skip non-secret token captures for session:// and hyphen prose

Apply G1 (// URL-scheme capture) and G2 (pure lower-hyphen compounds)
only on the token matcher so vault FP1/FP2 stop false-positive.
EOF
)"
```

---

### Task 3: Regression safety — full sensitive-content suite + typecheck

**Files:**
- Verify only (no intentional edits unless typecheck forces a fix)
- Test: `packages/cli/test/utils/sensitive-content.test.ts`
- Source: `packages/cli/src/utils/sensitive-content.ts`

**Interfaces:**
- Consumes: Task 2 implementation
- Produces: green typecheck + green focused test suite as merge gate for this change

- [ ] **Step 1: Re-run focused tests**

```bash
cd /Users/karlchow/Desktop/code/llm-wiki/packages/cli && npm test -- test/utils/sensitive-content.test.ts
```

Expected: PASS, exit 0.

- [ ] **Step 2: Typecheck the CLI package**

```bash
cd /Users/karlchow/Desktop/code/llm-wiki/packages/cli && npm run typecheck
```

Expected: PASS, exit 0. If typecheck fails only because of pre-existing unrelated errors, note them in the commit message / PR description; do not expand scope to fix unrelated packages. If your change introduced a type error, fix it in `sensitive-content.ts` only.

- [ ] **Step 3: Manual assertion checklist (read findings JSON mentally)**

Confirm by reading the test names / results:

| Case | Expected |
|------|----------|
| `this session: incidents-isolate` | no findings |
| `session://abc123…` | no findings |
| `token: abcdefghijklmnop` | one `token` finding |
| Existing access_key / bearer / provider_key tests | still pass |

- [ ] **Step 4: Commit only if you made typecheck fixes; otherwise skip**

If no file changes, skip commit. If you fixed types:

```bash
cd /Users/karlchow/Desktop/code/llm-wiki
git add packages/cli/src/utils/sensitive-content.ts
git commit -m "fix: typecheck cleanups for token capture filters"
```

---

### Task 4: Plan completion note (no release)

**Files:** none required

This plan stops at code + tests. Release (`0.10.20` or next), npm publish, and fleet CLI upgrade are **out of scope** (see design §6).

- [ ] **Step 1: Summarize for the human**

Report:
1. Commits created (hashes + subjects)
2. Test command + pass result
3. Reminder: vault FP fingerprints clear only after hosts run a CLI build/release that includes this change
4. Remaining inherited lint: `raw_source_identity_conflict` still separate

- [ ] **Step 2: Do not** run `npm version`, publish, remote `npm install -g`, or vault edits unless the human explicitly asks in a follow-up.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| G1 skip values starting with `//` | Task 2 helper |
| G2 skip `^[a-z]{2,}(?:-[a-z]{2,})+$` | Task 2 helper |
| Token-only; other matchers unchanged | Task 2 wire condition `matcher.kind === "token"` |
| Unit tests for FP1/FP2 + true positives | Task 1 |
| Redaction inherits filters | Task 1 redaction test + shared `collectMatches` |
| No public API change | No export of helper |
| No version bump / release in this change | Task 4 |
| No vault mutation | Not in any task |

Placeholder scan: none.  
Type consistency: `isNonSecretTokenCapture(value: string): boolean` used only in Task 2 as defined.
