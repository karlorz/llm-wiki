#!/usr/bin/env bash

# Regression fixtures for Codex/marketplace metadata and materialized mirror
# contracts enforced by scripts/verify-manifests.sh.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llm-wiki-plugin-metadata.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASS=0
FAIL=0

copy_fixture() {
  local name="$1"
  local destination="$TEST_ROOT/$name"

  git clone --quiet --no-hardlinks "$REPO_ROOT" "$destination"
  rsync -a --exclude='.git' --exclude='.DS_Store' --exclude='node_modules' \
    --exclude='dist' --exclude='.skillwiki' --exclude='.worktrees' \
    --exclude='artifacts' --exclude='logs' "$REPO_ROOT/" "$destination/"
  printf '%s\n' "$destination"
}

run_verify() {
  local root="$1"
  (
    cd "$root" || exit 1
    export NODE_PATH="$REPO_ROOT/node_modules${NODE_PATH:+:$NODE_PATH}"
    bash scripts/verify-manifests.sh
  )
}

run_materializer_check() {
  local root="$1"
  (
    cd "$root" || exit 1
    bash scripts/materialize-plugin-assets.sh --check
  )
}

assert_pass() {
  local label="$1" mode="$2" root="$3"
  local output rc

  if [ "$mode" = "verify" ]; then
    output="$(run_verify "$root" 2>&1)"
  else
    output="$(run_materializer_check "$root" 2>&1)"
  fi
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'PASS: %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected success, got exit %s:\n%s\n' "$label" "$rc" "$output"
    FAIL=$((FAIL + 1))
  fi
}

assert_fail() {
  local label="$1" pattern="$2" mode="$3" root="$4"
  local output rc

  if [ "$mode" = "verify" ]; then
    output="$(run_verify "$root" 2>&1)"
  else
    output="$(run_materializer_check "$root" 2>&1)"
  fi
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$output" | grep -Fq -- "$pattern"; then
    printf 'PASS: %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected nonzero with %s, got exit %s:\n%s\n' \
      "$label" "$pattern" "$rc" "$output"
    FAIL=$((FAIL + 1))
  fi
}

normalize_documentation_fixture() {
  local root="$1"
  python3 - "$root" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
readme = root / "README.md"
readme_text = readme.read_text()
readme_text = readme_text.replace(
    "Local validation should report 18 processed skills and 16 processed agents:",
    "Local validation derives the current skill and agent counts from the command below:",
)
if "`wiki-remove`" not in readme_text:
    readme_text = readme_text.replace(
        "`wiki-gate-plan-mode`",
        "`wiki-gate-plan-mode`, `wiki-remove`",
    )
readme.write_text(readme_text)

reference = root / "docs/codex-compatible-reference.md"
reference_text = reference.read_text().replace(
    "# 3) Skill count served by plugin root (must be 18)",
    "# 3) Skill count served by plugin root (derive from command output)",
)
reference.write_text(reference_text)
PY
}

baseline_root="$(copy_fixture baseline)"
normalize_documentation_fixture "$baseline_root"
assert_pass "normalized documentation and mirrors pass" verify "$baseline_root"

docs_root="$(copy_fixture stale-documentation)"
normalize_documentation_fixture "$docs_root"
python3 - "$docs_root" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
readme = root / "README.md"
text = readme.read_text()
text = text.replace(
    "Local validation derives the current skill and agent counts from the command below:",
    "Local validation should report 18 processed skills and 16 processed agents:",
)
text = text.replace(", `wiki-remove`", "")
readme.write_text(text)

reference = root / "docs/codex-compatible-reference.md"
text = reference.read_text().replace(
    "# 3) Skill count served by plugin root (derive from command output)",
    "# 3) Skill count served by plugin root (must be 18)",
)
reference.write_text(text)
PY
assert_fail "stale documentation inventory is reported" "llm-wiki documentation" verify "$docs_root"

marker_root="$(copy_fixture stale-marker)"
python3 - "$marker_root" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
paths = [
    root / "packages/skills/.claude-plugin/plugin.json",
    root / "packages/skills/.codex-plugin/plugin.json",
    root / "packages/codex-skills/.codex-plugin/plugin.json",
    root / ".claude-plugin/marketplace.json",
    root / "plugin.json",
    root / ".claude-plugin/plugin.json",
]

for path in paths:
    data = json.loads(path.read_text())
    if path.name == "marketplace.json":
        for plugin in data["plugins"]:
            if plugin["name"] == "skillwiki":
                plugin["description"] += " v9.9.9: stale fixture marker."
    else:
        data["description"] += " v9.9.9: stale fixture marker."
    path.write_text(json.dumps(data, indent=2) + "\n")
PY
assert_fail "stale release marker is reported" "release marker" verify "$marker_root"

missing_source_root="$(copy_fixture missing-marketplace-source)"
python3 - "$missing_source_root" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
path = root / ".claude-plugin/marketplace.json"
data = json.loads(path.read_text())
for plugin in data["plugins"]:
    if plugin["name"] == "vault-sync":
        plugin["source"] = "./packages/missing"
path.write_text(json.dumps(data, indent=2) + "\n")
PY
assert_fail "missing marketplace source is reported" "marketplace source directory missing" verify "$missing_source_root"

hidden_root="$(copy_fixture hidden-extra)"
mkdir -p "$hidden_root/packages/codex-skills/skills/.stale-skill"
printf 'stale\n' > "$hidden_root/packages/codex-skills/skills/.stale-skill/SKILL.md"
assert_fail "hidden mirror extras are reported" "extra skill mirror: .stale-skill" materializer "$hidden_root"

broken_root="$(copy_fixture broken-extra)"
ln -s "$broken_root/packages/codex-skills/skills/does-not-exist" \
  "$broken_root/packages/codex-skills/skills/.broken-skill"
assert_fail "broken mirror links are reported" "extra skill mirror: .broken-skill" materializer "$broken_root"

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
