#!/usr/bin/env bash
# Frozen-leaf Phase 5 contract: wiki-sync / proj-work / using-skillwiki /
# skillwiki-mcp must refuse git close and unpublished work-item MCP writes.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILLS="$REPO_ROOT/packages/skills"
PASS=0
FAIL=0

assert_file_has() {
  local file="$1" needle="$2" label="$3"
  if grep -Fq -- "$needle" "$file"; then
    printf 'PASS: %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — missing %s in %s\n' "$label" "$needle" "$file"
    FAIL=$((FAIL + 1))
  fi
}

SYNC="$SKILLS/wiki-sync/SKILL.md"
PROJ="$SKILLS/proj-work/SKILL.md"
USING="$SKILLS/using-skillwiki/SKILL.md"
MCP="$SKILLS/skillwiki-mcp/SKILL.md"

assert_file_has "$SYNC" ".WIKI_GIT_FROZEN" "wiki-sync names freeze marker"
assert_file_has "$SYNC" "fail closed" "wiki-sync fail-closed freeze"
assert_file_has "$PROJ" ".WIKI_GIT_FROZEN" "proj-work names freeze marker"
assert_file_has "$PROJ" "wiki_workitem_write" "proj-work feature-detects wiki_workitem_write"
assert_file_has "$PROJ" "wiki_capture" "proj-work points close notes at MCP capture"
assert_file_has "$USING" ".WIKI_GIT_FROZEN" "using-skillwiki names freeze marker"
assert_file_has "$USING" "wiki_workitem_write" "using-skillwiki names wiki_workitem_write tool"
assert_file_has "$MCP" "wiki_workitem_write" "skillwiki-mcp names wiki_workitem_write tool"
assert_file_has "$MCP" "wiki_page_publish" "skillwiki-mcp names wiki_page_publish tool"
assert_file_has "$MCP" "wiki_capture" "skillwiki-mcp retains fallback wiki_capture"

echo "passed=$PASS failed=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
