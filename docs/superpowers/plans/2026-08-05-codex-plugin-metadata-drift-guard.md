# Codex Plugin Metadata Drift Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stale Codex plugin metadata, inventory prose, marketplace wiring, and generated mirror paths fail repository validation before release.

**Architecture:** Keep platform-specific descriptions, but add layered contracts around identity, version, source paths, inventories, explicit release markers, and generated mirror bytes. `llm-wiki` keeps canonical assets under `packages/skills/` and validates materialized roots; `agent-skills` keeps each plugin’s Claude manifest as the release metadata anchor and validates all marketplace/Codex counterparts. Documentation is corrected at the same time and tested through the repository release gates.

**Tech Stack:** Bash, `jq`, Python JSON/YAML helpers already used by the repositories, Node.js scripts already used by `llm-wiki`, Git temporary worktrees/copies for regression fixtures, and existing CI workflows.

## Global Constraints

- Do not make all platform descriptions byte-identical; `llm-wiki` has intentional Claude/Codex/marketplace wording differences.
- Do not remove intentional Codex-only keywords.
- A description release marker matching `v<semver>:` must equal the current plugin manifest version.
- Marketplace inventory checks are bidirectional: every catalog entry resolves to one plugin and every plugin resolves to one catalog entry.
- Generated mirrors are changed only through `npm run materialize:plugins`; never hand-edit downstream mirrors.
- Do not edit `~/.codex/plugins/cache`, publish packages, push branches, or create release tags in this change.

---

## Track A — `agent-skills`

### Task 1: Add failing release-marker and marketplace-inventory regression fixtures

**Files:**
- Create: `/Users/karlchow/Desktop/code/agent-skills/scripts/test-plugin-metadata.sh`
- Modify: `/Users/karlchow/Desktop/code/agent-skills/.github/workflows/ci.yml:50-54`

**Interfaces:**
- Consumes: repository root, `scripts/test-dev-loop-release-tooling.sh` helper behavior, `jq`, and PyYAML installed by CI.
- Produces: an executable regression test that reports PASS/FAIL and exits nonzero for stale release markers, duplicate marketplace names, and orphaned marketplace entries.

- [ ] **Step 1: Write the failing fixture test.**

  Create a temporary Git-backed copy of `agent-skills` so the test can mutate JSON without touching the checkout. Add helpers with the existing shell convention:

  ```bash
  assert_fail() {
    local label="$1" pattern="$2"
    local output rc
    output="$($TEST_ROOT/scripts/test-dev-loop-release-tooling.sh 2>&1)"
    rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$output" | grep -Fq -- "$pattern"; then
      printf 'PASS: %s\n' "$label"
    else
      printf 'FAIL: %s — exit %s: %s\n' "$label" "$rc" "$output"
      FAIL=$((FAIL + 1))
    fi
  }
  ```

  Add three mutations and expected diagnostics:

  1. Replace `v2.4.3:` with `v2.4.2:` in all `deep-research` descriptions and expect a release-marker mismatch.
  2. Duplicate the `deep-research` marketplace object and expect a duplicate-name or duplicate-source failure.
  3. Append a marketplace object whose source is `./skills/not-a-plugin` and expect an orphan/source-directory failure.

- [ ] **Step 2: Run the new test to verify the current checker does not catch the fixtures.**

  Run:

  ```bash
  cd /Users/karlchow/Desktop/code/agent-skills
  bash scripts/test-plugin-metadata.sh
  ```

  Expected before implementation: at least one fixture reports `FAIL` because the current release-tooling script does not yet enforce the new metadata contract.

- [ ] **Step 3: Commit the red regression test.**

  ```bash
  git add scripts/test-plugin-metadata.sh .github/workflows/ci.yml
  git commit -m "test: cover stale agent-skills plugin metadata"
  ```

### Task 2: Implement the `agent-skills` metadata contract and correct current metadata

**Files:**
- Modify: `/Users/karlchow/Desktop/code/agent-skills/scripts/test-dev-loop-release-tooling.sh:746-836`
- Modify: `/Users/karlchow/Desktop/code/agent-skills/scripts/bump-version.sh:1-16`
- Modify: `/Users/karlchow/Desktop/code/agent-skills/skills/deep-research/.claude-plugin/plugin.json:4`
- Modify: `/Users/karlchow/Desktop/code/agent-skills/skills/deep-research/.codex-plugin/plugin.json:4`
- Modify: `/Users/karlchow/Desktop/code/agent-skills/.claude-plugin/marketplace.json:14`
- Modify: `/Users/karlchow/Desktop/code/agent-skills/skills/host-backup-restore/.claude-plugin/plugin.json:4`
- Modify: `/Users/karlchow/Desktop/code/agent-skills/skills/host-backup-restore/.codex-plugin/plugin.json:4`
- Modify: `/Users/karlchow/Desktop/code/agent-skills/.claude-plugin/marketplace.json:166`

**Interfaces:**
- Consumes: marketplace plugin objects and each plugin’s Claude/Codex manifests.
- Produces: `run_plugin_metadata_contract_checks`, an internal shell function invoked by the existing release-tooling gate; it fails with plugin name, field, expected value, and actual value.

- [ ] **Step 1: Add reusable shell assertions for metadata.**

  Extend the existing `run_plugin_version_sync_contract_checks` area with:

  ```bash
  assert_release_markers() {
    local label="$1" description="$2" expected_version="$3"
    local marker
    while IFS= read -r marker; do
      [ -n "$marker" ] || continue
      assert_eq "$label release marker" "$marker" "$expected_version"
    done < <(printf '%s' "$description" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?:' | sed 's/^v//; s/:$//' | sort -u)
  }
  ```

  The main loop must enumerate every marketplace object, reject duplicate names and sources before processing, resolve the source directory, and compare Claude/Codex `name` and `version`. It must call `assert_release_markers` for marketplace, Claude, and Codex descriptions. Do not compare keyword arrays.

- [ ] **Step 2: Make the fixture test pass.**

  Run:

  ```bash
  bash scripts/test-plugin-metadata.sh
  ```

  Expected: all stale-marker, duplicate-entry, and orphan-entry fixtures report PASS.

- [ ] **Step 3: Correct stale release markers without changing plugin versions.**

  Change only the description markers:

  ```text
  deep-research: v2.4.2: -> v2.4.3:
  host-backup-restore: v3.6.3: -> v3.6.4:
  ```

  Keep the rest of each platform-specific description unchanged unless the test identifies a second stale marker.

- [ ] **Step 4: Document the release metadata source of truth.**

  Update the `bump-version.sh` header to state that Claude plugin metadata is the release anchor, Codex and marketplace `name`/`version` fields must agree, and descriptions may differ by surface except for release markers.

- [ ] **Step 5: Run the repository release gates.**

  ```bash
  bash scripts/test-dev-loop-release-tooling.sh
  bash scripts/test-dev-loop-preflight-inventory.sh
  bash scripts/test-plugin-release-drift.sh
  git diff --check
  ```

  Expected: all commands exit 0 and the release-tooling output ends with `test-dev-loop-release-tooling: ok`.

- [ ] **Step 6: Commit the `agent-skills` implementation.**

  ```bash
  git add scripts/test-dev-loop-release-tooling.sh scripts/bump-version.sh scripts/test-plugin-metadata.sh .github/workflows/ci.yml skills/deep-research/.claude-plugin/plugin.json skills/deep-research/.codex-plugin/plugin.json skills/host-backup-restore/.claude-plugin/plugin.json skills/host-backup-restore/.codex-plugin/plugin.json .claude-plugin/marketplace.json
  git commit -m "test: guard agent-skills metadata drift"
  ```

---

## Track B — `llm-wiki`

### Task 3: Add failing `llm-wiki` inventory and mirror-path fixtures

**Files:**
- Create: `/Users/karlchow/Desktop/code/llm-wiki/scripts/test/plugin-metadata.test.sh`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/package.json:12-27`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/.github/workflows/ci.yml:15-18`

**Interfaces:**
- Consumes: a temporary Git worktree/copy and the repository’s existing `verify-manifests.sh` and `materialize-plugin-assets.sh --check` commands.
- Produces: deterministic shell regression coverage for stale counts, release markers, marketplace wiring, and hidden/broken mirror entries.

- [ ] **Step 1: Add the fixture harness and a valid baseline.**

  Follow `scripts/test/release-lockfile.test.sh` conventions (`set -u`, `mktemp`, `trap`, PASS/FAIL counters). Create a temporary worktree from `HEAD`, run the existing verifier once, and assert that the unmodified fixture passes.

- [ ] **Step 2: Add failing mutations.**

  In separate temporary worktrees, apply these exact mutations with Python or Node JSON edits:

  1. Change `19 prompt-only skills` to `18 prompt-only skills` in the canonical Claude plugin description and expect `verify-manifests.sh` to fail with a skill-count diagnostic.
  2. Change the `.claude-plugin/marketplace.json` `vault-sync` source path to `./packages/missing` and expect a missing-source diagnostic.
  3. Add `.stale-skill` under `packages/codex-skills/skills/` and expect `materialize-plugin-assets.sh --check` to fail.
  4. Create a broken symlink under the same mirror and expect the materializer check to fail.

- [ ] **Step 3: Run the fixture test before implementation.**

  ```bash
  cd /Users/karlchow/Desktop/code/llm-wiki
  bash scripts/test/plugin-metadata.test.sh
  ```

  Expected before implementation: the hidden/broken mirror cases are not reliably rejected, so the test reports at least one FAIL.

- [ ] **Step 4: Wire the focused test into npm and CI.**

  Add `test:plugin-metadata` to `package.json` and invoke it from the existing CI manifest-verification job after `bash scripts/verify-manifests.sh`.

- [ ] **Step 5: Commit the red regression test.**

  ```bash
  git add scripts/test/plugin-metadata.test.sh package.json .github/workflows/ci.yml
  git commit -m "test: cover llm-wiki plugin metadata drift"
  ```

### Task 4: Strengthen the `llm-wiki` materializer and verifier

**Files:**
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/scripts/materialize-plugin-assets.sh:150-168`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/scripts/verify-manifests.sh:189-223`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/scripts/verify-manifests.sh:468-500`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/scripts/verify-manifests.sh:556-593`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/scripts/verify-manifests.sh:607-616`

**Interfaces:**
- Consumes: canonical skill directories, Claude/Codex manifests, both marketplace files, and plugin descriptions.
- Produces: nonzero checks with actionable diagnostics for stale metadata, missing/duplicate/orphaned marketplace entries, and any extra mirror path.

- [ ] **Step 1: Make mirror extra detection include hidden and broken entries.**

  Replace the glob loop in `sync_skill_mirror` with a null-delimited `find` loop:

  ```bash
  while IFS= read -r -d '' existing; do
    existing_name="$(basename "$existing")"
    if ! contains_name "$names" "$existing_name"; then
      if [ "$MODE" = "apply" ]; then
        rm -rf -- "$existing"
      else
        fail "$label has extra skill mirror: $existing_name"
      fi
    fi
  done < <(find "$dest" -mindepth 1 -maxdepth 1 -print0)
  ```

  Treat `[ -L "$existing" ]` as present so broken symlinks are not skipped.

- [ ] **Step 2: Add a reusable release-marker check to `verify-manifests.sh`.**

  Add a Python helper that accepts a label, description, and expected version, extracts `v<semver>:` markers, and increments `ERRORS` with a diagnostic for every mismatch. Run it for the Claude/Codex skillwiki descriptions, Codex interface long description, Claude marketplace description, root agy description, and both vault-sync marketplace/Codex long descriptions.

- [ ] **Step 3: Replace fixed marketplace index checks with a bidirectional inventory loop.**

  Enumerate every `.claude-plugin/marketplace.json` plugin object, resolve its `source` to a canonical package, and check the manifest name/version. Separately enumerate the canonical skillwiki and vault-sync plugin manifests and require exactly one matching marketplace object. Reject duplicate names and sources before processing.

- [ ] **Step 4: Derive and check both plugin skill inventories.**

  Keep the existing skillwiki count check, add the Codex `interface.longDescription` count, derive `VAULT_SYNC_COUNT` from `packages/vault-sync/skills/*`, and check the marketplace and Codex long description counts. Compare the six expected vault-sync names as a set rather than trusting prose order.

- [ ] **Step 5: Run the fixture test and the existing verifier.**

  ```bash
  bash scripts/test/plugin-metadata.test.sh
  npm run materialize:plugins:check
  bash scripts/verify-manifests.sh
  ```

  Expected: all fixture mutations fail for the intended reason, while the real checkout passes.

- [ ] **Step 6: Commit the `llm-wiki` guard implementation.**

  ```bash
  git add scripts/materialize-plugin-assets.sh scripts/verify-manifests.sh scripts/test/plugin-metadata.test.sh package.json .github/workflows/ci.yml
  git commit -m "test: enforce llm-wiki plugin inventory contracts"
  ```

### Task 5: Correct `llm-wiki` documentation and run full validation

**Files:**
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/README.md:14-52`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/docs/codex-compatible-reference.md:84-103`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/.claude-plugin/marketplace.json:8-38`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/packages/skills/.claude-plugin/plugin.json:4`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/packages/skills/.codex-plugin/plugin.json:4,25`
- Modify: `/Users/karlchow/Desktop/code/llm-wiki/packages/codex-skills/.codex-plugin/plugin.json:4,25`

**Interfaces:**
- Consumes: the dynamic inventory checks from Task 4.
- Produces: accurate docs and plugin metadata with no stale 18-skill or single-plugin claims.

- [ ] **Step 1: Update the documentation prose.**

  Change the Antigravity validation sentence and Codex checklist to use the current derived count of 19, add `wiki-remove` to the `wiki-*` table, and document the `find ... | wc -l` command as the authority so future count changes have an obvious update path.

- [ ] **Step 2: Correct marketplace metadata.**

  Change `.claude-plugin/marketplace.json` metadata description from “Single-plugin marketplace” to wording that names both `skillwiki` and `vault-sync`. Keep the two plugin entries and their independent descriptions intact.

- [ ] **Step 3: Align count-bearing plugin descriptions.**

  Ensure every count-bearing Claude/Codex/root-agy/interface description says 19 for skillwiki and every vault-sync count-bearing description says 6. Do not make Claude and Codex prose otherwise identical.

- [ ] **Step 4: Run all final checks.**

  ```bash
  npm run materialize:plugins:check
  npm run test:plugin-metadata
  npm run test:release-lockfile
  bash scripts/verify-manifests.sh
  npm run -w packages/cli build
  npm run -w skillwiki test
  git diff --check
  git status --short --branch
  ```

  Expected: every command exits 0, the verifier reports 19 skillwiki skills and 6 vault-sync skills, and the worktree contains only intended source, test, and documentation changes.

- [ ] **Step 5: Commit the documentation and final `llm-wiki` changes.**

  ```bash
  git add README.md docs/codex-compatible-reference.md .claude-plugin/marketplace.json packages/skills/.claude-plugin/plugin.json packages/skills/.codex-plugin/plugin.json packages/codex-skills/.codex-plugin/plugin.json
  git commit -m "docs: keep llm-wiki Codex inventory current"
  ```

---

## Final cross-repository review

### Task 6: Review diffs and confirm runtime handoff

**Files:**
- Review only: both repository diffs and their committed test output.

- [ ] **Step 1: Inspect both repository histories and diffs.**

  ```bash
  git -C /Users/karlchow/Desktop/code/llm-wiki log -3 --oneline
  git -C /Users/karlchow/Desktop/code/llm-wiki diff HEAD~3..HEAD --stat
  git -C /Users/karlchow/Desktop/code/agent-skills log -3 --oneline
  git -C /Users/karlchow/Desktop/code/agent-skills diff HEAD~2..HEAD --stat
  ```

  Confirm no cache files, unrelated plugin payloads, or release tags were modified.

- [ ] **Step 2: Verify local Codex state without editing its cache.**

  ```bash
  codex plugin marketplace list
  codex plugin list
  ```

  If a source version changed, report the supported refresh/reinstall command instead of copying files into `~/.codex/plugins/cache`.

- [ ] **Step 3: Record the final handoff.**

  Report the two repository commit IDs, validation commands and results, any intentionally platform-specific descriptions, and the exact Codex marketplace refresh needed by the user.
