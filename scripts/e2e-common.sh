# scripts/e2e-common.sh
# Shared helpers for e2e smoke tests of the skillwiki CLI.
# Source this file — do NOT execute it directly.
#
# Usage:
#   source "$(dirname "$0")/e2e-common.sh"
#   # or
#   . /path/to/e2e-common.sh

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
PASS=0
FAIL=0

# Captured output from the most recent run_cli call.
RUN_OUTPUT=""
RUN_RC=0

# ---------------------------------------------------------------------------
# run_cli <cmd...>
#
# Runs the given command, capturing stdout into RUN_OUTPUT and exit code into
# RUN_RC. Redirects stderr to /dev/null. Use after calling:
#   assert_exit <expected> "$RUN_RC" "label"
#   assert_json_contains "$RUN_OUTPUT" "field" "value" "label"
# ---------------------------------------------------------------------------
run_cli() {
  RUN_RC=0
  RUN_OUTPUT=$("$@" 2>/dev/null) || RUN_RC=$?
}

# ---------------------------------------------------------------------------
# assert_exit <expected> <actual> <label>
# ---------------------------------------------------------------------------
assert_exit() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$actual" -eq "$expected" ]; then
    PASS=$((PASS + 1))
    printf "  \u2713 %s (exit %d)\n" "$label" "$actual"
  else
    FAIL=$((FAIL + 1))
    printf "  \u2717 %s — expected exit %d, got %d\n" "$label" "$expected" "$actual"
  fi
}

# ---------------------------------------------------------------------------
# assert_json_contains <json_string> <field> <expected_value> <label>
#
# Uses python3 to parse JSON. Supports dot-notation for nested fields
# and numeric array indices (e.g. "data.broken.0.slug").
# ---------------------------------------------------------------------------
assert_json_contains() {
  local json="$1"
  local field="$2"
  local expected="$3"
  local label="$4"

  # python3 one-liner: walk dot-separated keys, print value or __MISSING__
  local actual
  actual=$(printf '%s' "$json" | python3 -c "
import sys, json

def dig(obj, keys):
    for k in keys:
        if isinstance(obj, dict) and k in obj:
            obj = obj[k]
        elif isinstance(obj, list):
            try:
                idx = int(k)
                obj = obj[idx]
            except (ValueError, IndexError):
                return '__MISSING__'
        else:
            return '__MISSING__'
    return obj

data = json.load(sys.stdin)
keys = '$field'.split('.')
val = dig(data, keys)
if isinstance(val, (dict, list)):
    print(json.dumps(val))
else:
    print(val)
" 2>/dev/null)

  # Normalize booleans (Python prints True/False, JSON uses true/false)
  case "$expected" in
    true)  [ "$actual" = "True"  ] && actual="true"  ;;
    false) [ "$actual" = "False" ] && actual="false" ;;
  esac

  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    printf "  \u2713 %s (%s=%s)\n" "$label" "$field" "$expected"
  else
    FAIL=$((FAIL + 1))
    printf "  \u2717 %s — expected %s=%s, got %s\n" "$label" "$field" "$expected" "$actual"
  fi
}

# ---------------------------------------------------------------------------
# assert_file_exists <path> <label>
# ---------------------------------------------------------------------------
assert_file_exists() {
  local path="$1"
  local label="$2"

  if [ -e "$path" ]; then
    PASS=$((PASS + 1))
    printf "  \u2713 %s (%s)\n" "$label" "$path"
  else
    FAIL=$((FAIL + 1))
    printf "  \u2717 %s — file not found: %s\n" "$label" "$path"
  fi
}

# ---------------------------------------------------------------------------
# seed_vault <vault_dir>
#
# Creates a set of fixture pages that exercise each lint check category.
# Also creates the raw/articles/stale-source.md file needed by stale-page.
# ---------------------------------------------------------------------------
seed_vault() {
  local vault="$1"

  # Ensure sub-directories exist (in case init hasn't run yet).
  mkdir -p "$vault/entities" "$vault/concepts" "$vault/meta"
  mkdir -p "$vault/raw/articles"

  # Compute a date >90 days in the past for the stale-page fixture.
  # Works on both macOS (BSD date) and Linux (GNU date).
  local stale_date
  if date -v-120d >/dev/null 2>&1; then
    # macOS BSD date
    stale_date=$(date -v-120d '+%Y-%m-%d')
  else
    # GNU date (Debian)
    stale_date=$(date -d '120 days ago' '+%Y-%m-%d')
  fi

  # ---- entities/valid-entity.md ----
  cat > "$vault/entities/valid-entity.md" <<'FRONTMATTER'
---
title: "Valid Entity"
tags: ["research"]
updated: "2026-05-03"
---

Links to [[valid-concept]].
FRONTMATTER

  # ---- concepts/valid-concept.md ----
  cat > "$vault/concepts/valid-concept.md" <<'FRONTMATTER'
---
title: "Valid Concept"
tags: ["research"]
updated: "2026-05-03"
---

Links to [[valid-entity]].
FRONTMATTER

  # ---- entities/orphan-entity.md (warning: orphans) ----
  cat > "$vault/entities/orphan-entity.md" <<'FRONTMATTER'
---
title: "Orphan Entity"
tags: ["research"]
updated: "2026-05-03"
---

No wikilinks here.
FRONTMATTER

  # ---- concepts/broken-link.md (error: broken_wikilinks) ----
  cat > "$vault/concepts/broken-link.md" <<'FRONTMATTER'
---
title: "Broken Link"
tags: ["research"]
updated: "2026-05-03"
---

A link to [[nonexistent-page]].
FRONTMATTER

  # ---- entities/bad-tag.md (error: tag_not_in_taxonomy) ----
  cat > "$vault/entities/bad-tag.md" <<'FRONTMATTER'
---
title: "Bad Tag"
tags: ["not-in-taxonomy"]
updated: "2026-05-03"
---

Normal content.
FRONTMATTER

  # ---- concepts/stale-page.md (warning: stale_page) ----
  cat > "$vault/concepts/stale-page.md" <<FRONTMATTER
---
title: "Stale Page"
tags: ["research"]
updated: "$stale_date"
sources: ["raw/articles/stale-source.md"]
---

Normal content.
FRONTMATTER

  # ---- raw/articles/stale-source.md (companion file for stale-page) ----
  cat > "$vault/raw/articles/stale-source.md" <<'FRONTMATTER'
---
title: "Stale Source"
ingested: "2026-05-03"
---

Source content
FRONTMATTER

  # ---- entities/big-page.md (warning: page_too_large) ----
  # Body must exceed 200 lines. Write frontmatter then 252 lines of content.
  {
    printf -- '---\n'
    printf 'title: "Big Page"\n'
    printf 'tags: ["research"]\n'
    printf 'updated: "2026-05-03"\n'
    printf -- '---\n\n'
    i=0
    while [ "$i" -lt 252 ]; do
      printf 'line content\n'
      i=$((i + 1))
    done
  } > "$vault/entities/big-page.md"

  # ---- log.md (warning: log_rotate_needed) ----
  # Overwrite with 620 entries matching pattern: ## [YYYY-MM-DD] action | description
  {
    printf -- '---\ntitle: "Changelog"\n---\n\n'
    i=0
    while [ "$i" -lt 620 ]; do
      printf '## [2026-05-03] update | log entry %d\n\n' "$i"
      i=$((i + 1))
    done
  } > "$vault/log.md"
}

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
summary() {
  printf "\n--- Results ---\n"
  printf "PASS: %d\n" "$PASS"
  printf "FAIL: %d\n" "$FAIL"

  if [ "$FAIL" -gt 0 ]; then
    return 1
  fi
  return 0
}
