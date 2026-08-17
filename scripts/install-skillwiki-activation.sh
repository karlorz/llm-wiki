#!/usr/bin/env bash
set -euo pipefail

# install-skillwiki-activation.sh
#
# Materialize the SkillWiki activation file from the canonical template and
# prepend an instructional reference to user-scope harness instruction files.
#
# Default scope: Grok only. Claude Code and Codex ship SessionStart plugin
# hooks that inject using-skillwiki; writing ~/.claude/CLAUDE.md or
# ~/.codex/AGENTS.md would double-activate and pollute user-scope files.
#
# Idempotent: uses marker comments to replace or skip on re-run.
# Supports --check for read-only drift detection.
#
# ADR-3 through ADR-8 (projects/llm-wiki/architecture/decisions/)
# Policy: skip harnesses that already activate via plugin SessionStart hooks.

MODE="apply"
WITH_CLAUDE=0
WITH_CODEX=0
CLEAN_HOOKED=1

usage() {
  cat <<'EOF' >&2
Usage: install-skillwiki-activation.sh [options]

Options:
  --check              Read-only: verify installed activation files match template
  --with-claude        Also install ~/.claude/skillwiki.md + CLAUDE.md marker
                       (only for Claude without the skillwiki SessionStart plugin)
  --with-codex         Also install ~/.codex/skillwiki.md + AGENTS.md marker
                       (only for Codex without the skillwiki SessionStart plugin)
  --no-clean-hooked    Do not remove prior Claude/Codex activation installs
                       when those harnesses are not requested
  -h, --help           Show this help

Default: install Grok (~/.grok) only. Claude and Codex are cleaned of any
prior activation marker/file unless --with-claude / --with-codex is set.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      MODE="check"
      shift
      ;;
    --with-claude)
      WITH_CLAUDE=1
      shift
      ;;
    --with-codex)
      WITH_CODEX=1
      shift
      ;;
    --no-clean-hooked)
      CLEAN_HOOKED=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE="$REPO_ROOT/packages/skills/using-skillwiki/activation.md"

ERRORS=0

fail() {
  echo "ERROR: $*" >&2
  ERRORS=$((ERRORS + 1))
}

info() {
  printf '%s\n' "$*"
}

if [ ! -f "$TEMPLATE" ]; then
  fail "Activation template missing: $TEMPLATE"
  exit 1
fi

BEGIN_MARKER="<!-- skillwiki:begin -->"
END_MARKER="<!-- skillwiki:end -->"

# Grok has no @file import. The path after @ must stay ~/.grok/skillwiki.md
# so a read_file after stripping @ lands on the compact activation file (ADR-3).
# Relative @skillwiki.md (ADR-6) resolves to ~/skillwiki.md or $CWD/skillwiki.md.
reference_line_for() {
  local dir="$1"
  case "$dir" in
    "$HOME/.grok")
      printf '%s\n' "Read @~/.grok/skillwiki.md for SkillWiki activation context."
      ;;
    "$HOME/.claude")
      printf '%s\n' "Read @~/.claude/skillwiki.md for SkillWiki activation context."
      ;;
    "$HOME/.codex")
      printf '%s\n' "Read @~/.codex/skillwiki.md for SkillWiki activation context."
      ;;
    *)
      printf '%s\n' "Read @~/.grok/skillwiki.md for SkillWiki activation context."
      ;;
  esac
}

# Harnesses without a working SessionStart additionalContext path.
# Claude + Codex activate via plugin hooks (hooks.json / hooks-codex.json).
TARGETS=(
  "$HOME/.grok:AGENTS.md"
)

if [ "$WITH_CLAUDE" -eq 1 ]; then
  TARGETS+=("$HOME/.claude:CLAUDE.md")
fi

if [ "$WITH_CODEX" -eq 1 ]; then
  TARGETS+=("$HOME/.codex:AGENTS.md")
fi

# Prior mistaken installs: Claude/Codex activation files when hooks already cover them.
HOOKED_CLEAN_TARGETS=(
  "$HOME/.claude:CLAUDE.md"
  "$HOME/.codex:AGENTS.md"
)

remove_marker_block() {
  local agents_path="$1"
  local tmp_file

  [ -f "$agents_path" ] || return 0
  if ! grep -qF "$BEGIN_MARKER" "$agents_path" 2>/dev/null; then
    return 0
  fi

  tmp_file="$(mktemp)"
  # Drop begin..end marker block (inclusive). Preserve content before/after.
  awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
    $0 == begin { skip=1; next }
    skip && $0 == end { skip=0; next }
    !skip { print }
  ' "$agents_path" > "$tmp_file"

  # Drop a single leading blank line left after removing a head block.
  if [ -s "$tmp_file" ] && [ "$(head -n 1 "$tmp_file" | wc -c)" -eq 1 ]; then
    tail -n +2 "$tmp_file" > "${tmp_file}.2"
    mv "${tmp_file}.2" "$tmp_file"
  fi

  # If file is empty or only whitespace after removal, delete it.
  if [ ! -s "$tmp_file" ] || ! grep -q '[^[:space:]]' "$tmp_file"; then
    rm -f "$tmp_file" "$agents_path"
    info "removed empty $agents_path (was only skillwiki activation block)"
  else
    mv "$tmp_file" "$agents_path"
    info "removed skillwiki marker block from $agents_path"
  fi
}

clean_hooked_harness() {
  local dir="$1"
  local agents_file="$2"
  local agents_path="$dir/$agents_file"
  local activation_path="$dir/skillwiki.md"

  if [ ! -d "$dir" ]; then
    return 0
  fi

  if [ "$MODE" = "check" ]; then
    if [ -f "$agents_path" ] && grep -qF "$BEGIN_MARKER" "$agents_path" 2>/dev/null; then
      fail "$agents_path still has skillwiki marker; run install:activation to clean (plugin SessionStart already activates)"
    fi
    if [ -f "$activation_path" ]; then
      fail "$activation_path present; run install:activation to clean (plugin SessionStart already activates)"
    fi
    return 0
  fi

  remove_marker_block "$agents_path"

  if [ -f "$activation_path" ]; then
    # Only remove if it matches our template (or is a skillwiki activation copy).
    # Prefer exact match; also remove if it looks like our activation header.
    if cmp -s "$TEMPLATE" "$activation_path" 2>/dev/null \
      || grep -qF "SkillWiki activation" "$activation_path" 2>/dev/null \
      || grep -qF "using-skillwiki" "$activation_path" 2>/dev/null; then
      rm -f "$activation_path"
      info "removed $activation_path"
    else
      info "left $activation_path in place (does not look like SkillWiki activation template)"
    fi
  fi
}

install_or_check_target() {
  local dir="$1"
  local agents_file="$2"
  local agents_path="$dir/$agents_file"
  local activation_path="$dir/skillwiki.md"
  local reference_line block
  reference_line="$(reference_line_for "$dir")"
  block="${BEGIN_MARKER}
${reference_line}
${END_MARKER}"

  if [ ! -d "$dir" ]; then
    if [ "$MODE" = "check" ]; then
      fail "$dir does not exist - run install first"
      return
    fi
    mkdir -p "$dir"
  fi

  # 1. Materialize the activation file.
  if [ "$MODE" = "apply" ]; then
    cp -p "$TEMPLATE" "$activation_path"
    info "materialized $activation_path"
  else
    if [ ! -f "$activation_path" ]; then
      fail "$activation_path missing - run install first"
    elif ! cmp -s "$TEMPLATE" "$activation_path"; then
      fail "$activation_path drift: differs from template"
    fi
  fi

  # 2. Prepend/replace the marker block in AGENTS.md/CLAUDE.md.
  if [ "$MODE" = "apply" ]; then
    if [ -f "$agents_path" ]; then
      if grep -qF "$BEGIN_MARKER" "$agents_path" && grep -qF "$END_MARKER" "$agents_path"; then
        tmp_file="$(mktemp)"
        # Keep content after end marker only (replace existing block at head or mid-file).
        awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
          $0 == begin { skip=1; next }
          skip && $0 == end { skip=0; next }
          !skip { print }
        ' "$agents_path" > "${tmp_file}.tail"
        # Strip a single leading blank line from the tail so re-prepend stays tidy.
        if [ -s "${tmp_file}.tail" ] && [ "$(head -n 1 "${tmp_file}.tail" | wc -c)" -eq 1 ]; then
          tail -n +2 "${tmp_file}.tail" > "${tmp_file}.tail2"
          mv "${tmp_file}.tail2" "${tmp_file}.tail"
        fi
        {
          printf '%s\n%s\n%s\n' "$BEGIN_MARKER" "$reference_line" "$END_MARKER"
          if [ -s "${tmp_file}.tail" ]; then
            printf '\n'
            cat "${tmp_file}.tail"
          fi
        } > "$tmp_file"
        rm -f "${tmp_file}.tail"
        mv "$tmp_file" "$agents_path"
        info "updated marker block in $agents_path"
      else
        tmp_file="$(mktemp)"
        printf '%s\n\n' "$block" > "$tmp_file"
        cat "$agents_path" >> "$tmp_file"
        mv "$tmp_file" "$agents_path"
        info "prepended marker block to $agents_path"
      fi
    else
      printf '%s\n' "$block" > "$agents_path"
      info "created $agents_path with marker block"
    fi
  else
    if [ ! -f "$agents_path" ]; then
      fail "$agents_path missing - run install first"
    elif ! grep -qF "$BEGIN_MARKER" "$agents_path"; then
      fail "$agents_path missing skillwiki marker block - run install first"
    elif ! grep -qF "$END_MARKER" "$agents_path"; then
      fail "$agents_path has begin marker but missing end marker - manual fix needed"
    elif ! grep -qF "$reference_line" "$agents_path"; then
      fail "$agents_path marker block has stale reference line - run install to update"
    fi
  fi
}

# Clean Claude/Codex unless explicitly requested (plugin SessionStart already activates).
if [ "$CLEAN_HOOKED" -eq 1 ]; then
  for target in "${HOOKED_CLEAN_TARGETS[@]}"; do
    dir="${target%%:*}"
    agents_file="${target##*:}"
    # Skip clean if user opted this harness back in.
    if [ "$dir" = "$HOME/.claude" ] && [ "$WITH_CLAUDE" -eq 1 ]; then
      continue
    fi
    if [ "$dir" = "$HOME/.codex" ] && [ "$WITH_CODEX" -eq 1 ]; then
      continue
    fi
    clean_hooked_harness "$dir" "$agents_file"
  done
fi

for target in "${TARGETS[@]}"; do
  dir="${target%%:*}"
  agents_file="${target##*:}"
  install_or_check_target "$dir" "$agents_file"
done

if [ "$ERRORS" -ne 0 ]; then
  echo "Activation install check failed with $ERRORS error(s)." >&2
  exit 1
fi

if [ "$MODE" = "check" ]; then
  info "SkillWiki activation files are current."
else
  info "SkillWiki activation files installed (Grok default; Claude/Codex use plugin SessionStart)."
fi
