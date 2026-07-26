# Design: Sensitive-content token matcher precision (G1 + G2)

**Date:** 2026-07-26  
**Status:** approved-for-spec (awaiting user review of written file)  
**Scope:** CLI product fix only (`packages/cli` sensitive-content scanner)  
**Related work item:** `projects/llm-wiki/work/2026-07-26-sensitive-content-token-regex-false-positives/`  
**Handoff context:** `logs/2026-07-26-skillwiki-vault-sync-fleet-health-handoff.md`  
**Non-goals:** vault content rewrites, fingerprint allowlists, severity changes, entropy thresholds, vault-sync host reinstalls (Track C), raw_source_identity_conflict policy

---

## 1. Problem

The sensitive-content scanner’s `token` matcher is:

```ts
/\b(?:token|session)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{16,})["']?/gi
```

It has no value-shape discrimination beyond length ≥ 16. Two vault findings are false positives:

| ID | File | Pattern | Fingerprint |
|----|------|---------|-------------|
| FP1 | `projects/portfolio-lab/log.md` | prose `this session: incidents-isolate` | `09c7db7c8f33` |
| FP2 | `raw/transcripts/2026-07-24-clawgod-v175-upstream-sync-session.md` | `source_url: session://…` | `b4719c7e3e09` |

### Why vault-side cleanup is wrong

- FP1 is legitimate engineering prose; redacting destroys history.
- FP2 is on **immutable** raw; schema forbids edit-after-ingest.
- Documenting the FPs with literal trigger strings previously created *new* lint-delta errors and blocked leaf S3 push (since recovered by rewriting the work-item spec).

### Impact

- Inherited `full_errors` includes 2 `sensitive_content` findings that cannot be cleared safely.
- Health / daily-wiki-sleep treat `sensitive_content` as a security error and may stop write work.
- The product root cause remains in CLI source even after operational push recovery.

---

## 2. Goals and success criteria

### Goals

1. Stop matching FP1 and FP2 without mutating vault content.
2. Keep all existing `sensitive-content` unit tests green.
3. Preserve detection of explicit `token: <secret-shaped value>` and other matcher kinds (access_key, api_key, password, provider_key, private_key, authorization_header, etc.).
4. Ship as a small, reviewable change in `packages/cli/src/utils/sensitive-content.ts` + unit tests only.

### Success criteria

- [ ] Unit tests assert FP1- and FP2-shaped strings produce **zero** findings.
- [ ] Existing suite in `packages/cli/test/utils/sensitive-content.test.ts` remains green.
- [ ] Explicit true positives still match (see §5).
- [ ] After a release that includes this change is installed on a host, vault  
  `skillwiki lint <vault> --only sensitive_content` no longer reports fingerprints  
  `09c7db7c8f33` or `b4719c7e3e09`.  
  (`raw_source_identity_conflict` may remain — out of scope.)

---

## 3. Approach: G1 + G2 post-match value filters

**Ship slice:** two post-match filters applied only when `matcher.kind === "token"` (or equivalently only for the token matcher path). Other matchers are unchanged.

| Guard | Rule | Rationale |
|-------|------|-----------|
| **G1 URL scheme** | Skip if captured value starts with `//` | `session://id…` yields capture `//id…` under the current regex |
| **G2 Prose compound** | Skip if value matches `^[a-z]{2,}(?:-[a-z]{2,})+$` | Pure lowercase hyphenated English compounds (`incidents-isolate`) are not credential-shaped |

### Explicitly deferred (not in this design)

| Idea | Why deferred |
|------|----------------|
| G3 keyword split / remove bare `session` | G1+G2 already clear both known FPs with smaller blast radius |
| Shannon entropy threshold | Low-entropy real keys (`sk-AAA…`, `hana_dev_AAA…`) make global entropy unsafe; unnecessary for known FPs |
| Fingerprint allowlist / baseline file | Ops band-aid; does not fix root cause |
| Severity downgrade for “ambiguous” token | Weakens security posture without fixing matcher |
| Live verification (TruffleHog-style) | Offline vault linter; no network secret checks |
| Vault content rewrites / raw mutation | Violates immutability / destroys history |

### Industry alignment (supporting rationale)

Secret scanners (Gitleaks, detect-secrets, TruffleHog) combine pattern matching with value-shape filters (entropy, allowlists, stopwords, scheme context). SkillWiki already implements the *baseline/new-errors* half via `lint-delta`; this design adds the missing *value-shape* half for the token rule only.

---

## 4. Implementation design

### 4.1 Location

- **Source:** `packages/cli/src/utils/sensitive-content.ts`
- **Tests:** `packages/cli/test/utils/sensitive-content.test.ts`
- **No** command wiring changes; all consumers (`lint`, `validate`, `ingest`, `log-append`, `page-publish`, `memory`) call `scanSensitiveContent` / `redactSensitiveContent` and inherit the fix automatically.

### 4.2 Algorithm change

In `collectMatches`, after resolving `value` and before `matches.push`:

1. Keep existing skips: `REDACTED_RE` on whole match; `isSyntheticPlaceholder(value)`.
2. **New:** if `matcher.kind === "token"` and `isNonSecretTokenCapture(value)` → `continue`.

```ts
/** Reject token captures that are URL-scheme paths or pure lower-hyphen prose. */
function isNonSecretTokenCapture(value: string): boolean {
  // G1: session://… captures as //…
  if (value.startsWith("//")) return true;
  // G2: pure lowercase hyphenated compounds (incidents-isolate)
  if (/^[a-z]{2,}(?:-[a-z]{2,})+$/.test(value)) return true;
  return false;
}
```

### 4.3 Regex

**No regex change in the ship slice.** The token matcher pattern stays as-is so risk is limited to the two filters. Optional follow-up (out of scope): tighten keywords so bare prose `session` is never a candidate.

### 4.4 Redaction path

`redactSensitiveContent` uses the same `collectMatches` → inherits G1/G2. FP strings must yield `changed: false` and empty findings.

### 4.5 Public API

No exported type or function signature changes. Helper may remain private (unexported) unless tests need it; prefer testing via `scanSensitiveContent` only.

---

## 5. Test plan

### 5.1 Non-findings (new)

| Input | Guard |
|-------|--------|
| `Prior this session: incidents-isolate session-scoped root` | G2 |
| `source_url: session://abc123def456ghi789xyz` | G1 |
| `this session: another-long-hyphenated-phrase` | G2 |
| `session: pure-english-compound-word` (≥16 via hyphens) | G2 |

### 5.2 Still findings (new or reinforced)

| Input | Expect |
|-------|--------|
| `token: abcdefghijklmnop` | kind `token` |
| `token: tok_aB3dEf9hIjKlMnOpQrStUv` | kind `token` |
| Existing suite fixtures (access key, bearer, password, api_key, provider keys, private key) | unchanged |

### 5.3 Safety properties

- Findings and JSON serialization never include raw secret material (existing invariant).
- Redaction of true positives still produces `[REDACTED:token:<fp>]`.

### 5.4 Commands

```bash
# from monorepo root
pnpm --filter skillwiki test -- packages/cli/test/utils/sensitive-content.test.ts
# or package-local vitest equivalent used by this repo
```

Post-release host smoke (manual, not blocking merge of the code change):

```bash
skillwiki lint /Users/karlchow/wiki --only sensitive_content --human
# expect no 09c7db7c8f33 / b4719c7e3e09
```

---

## 6. Rollout

1. Implement G1+G2 + tests on `llm-wiki` mainline branch / PR.
2. Include in next patch release (e.g. `0.10.20` — exact version decided at release time).
3. Upgrade leaf/snapshotter/satellite CLI installs to that version (fleet steps may follow separately; not part of this code change).
4. Confirm vault sensitive_content FP fingerprints cleared; leave `raw_source_identity_conflict` for its own work item.

**Do not** force-push vault git. **Do not** edit immutable raw. **Do not** require vault-sync host reinstall for this fix to take effect (scanner lives in skillwiki CLI, not host vault-sync scripts).

---

## 7. Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Real secret is pure `lower-hyphen-words` ≥16 chars | Low | Uncommon for credentials; other matchers still catch provider/access patterns |
| Real secret value is only a URL path starting with `//` | Very low | Not a typical credential form for `token`/`session` labels |
| More prose FPs without hyphens (e.g. long single tokens) | Medium residual | Out of scope; collect for a follow-up if seen |
| Work items re-quote live match strings and re-trigger other rules | Low | G1/G2 reduce self-trigger; docs should keep using fingerprints |

---

## 8. Alternatives considered

1. **Rewrite vault content** — rejected (immutability / history loss).  
2. **Fingerprint allowlist** — rejected as sole fix (ops debt, root cause remains).  
3. **Remove bare `session` keyword** — deferred; larger behavior change than needed.  
4. **Entropy ≥ 3.5** — rejected for this slice; risks low-entropy true keys if ever applied carelessly and does not map cleanly to the hyphen prose class.  
5. **G1+G2+G3 combined** — deferred polish; revisit if new `session:` prose FPs appear after ship.

---

## 9. Open questions (resolved)

| Question | Resolution |
|----------|------------|
| Ship G1+G2 only or add G3? | **G1+G2 only** (user accepted recommendation) |
| Change other matchers? | **No** |
| Release version number in this design? | **No** — decided at release time |

---

## 10. Implementation checklist (for plan phase)

1. Add `isNonSecretTokenCapture` (or equivalent name) in `sensitive-content.ts`.
2. Wire into `collectMatches` for `kind === "token"`.
3. Add unit tests for FP1, FP2, hyphen prose, and true-positive token cases.
4. Run sensitive-content unit tests; fix any failures.
5. PR / commit with clear message referencing this design and the vault work item.
6. (Separate session) release + fleet CLI upgrade + vault lint verification.

---

## 11. References

- Source: `packages/cli/src/utils/sensitive-content.ts`
- Tests: `packages/cli/test/utils/sensitive-content.test.ts`
- Vault work item: `/Users/karlchow/wiki/projects/llm-wiki/work/2026-07-26-sensitive-content-token-regex-false-positives/spec.md`
- Fleet handoff: `logs/2026-07-26-skillwiki-vault-sync-fleet-health-handoff.md`
- Lint-delta gate contract: block only when `new_errors > 0` (wiki-sync / vault-presync)
