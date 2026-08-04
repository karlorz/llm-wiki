#!/usr/bin/env bash
set -euo pipefail

# install-skillwiki-activation.sh
#
# Materialize the SkillWiki activation file from the canonical template and
# prepend an instructional reference to the user-scope AGENTS.md/CLAUDE.md.
#
# Idempotent: uses marker comments to replace or skip on re-run.
# Supports --check for read-only drift detection.
#
# ADR-3 through ADR-8 (projects/llm-wiki/architecture/decisions/)

MODE="apply"

if [ "${1:-}" = "--check" ]; then
  MODE="check"
  shift
fi

if [ $# -ne 0 ]; then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi

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
REFERENCE_LINE="Read @skillwiki.md for SkillWiki activation context."
BLOCK="${BEGIN_MARKER}
${REFERENCE_LINE}
${END_MARKER}"

# Target directories for each harness.
# Both files (AGENTS.md/CLAUDE.md and skillwiki.md) are co-located per harness.
TARGETS=(
  "$HOME/.grok:AGENTS.md"
  "$HOME/.claude:CLAUDE.md"
)

for target in "${TARGETS[@]}"; do
  dir="${target%%:*}"
  agents_file="${target##*:}"
  agents_path="$dir/$agents_file"
  activation_path="$dir/skillwiki.md"

  if [ ! -d "$dir" ]; then
    if [ "$MODE" = "check" ]; then
      fail "$dir does not exist - run install first"
      continue
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
      # Check if marker block already exists.
      if grep -qF "$BEGIN_MARKER" "$agents_path" && grep -qF "$END_MARKER" "$agents_path"; then
        # Replace existing block between markers (inclusive) using a temp file.
        tmp_file="$(mktemp)"
        # Write everything before the begin marker.
        sed -n "1,/^${BEGIN_MARKER}\$/d;/^${END_MARKER}\$/,\$p" "$agents_path" | sed "1,/^${END_MARKER}\$/d" > "${tmp_file}.tail"
        # Write new block + everything after end marker.
        printf '%s\n%s\n%s\n' "$BEGIN_MARKER" "$REFERENCE_LINE" "$END_MARKER" > "$tmp_file"
        cat "${tmp_file}.tail" >> "$tmp_file"
        rm -f "${tmp_file}.tail"
        mv "$tmp_file" "$agents_path"
        info "updated marker block in $agents_path"
      else
        # Prepend block + blank line before existing content.
        tmp_file="$(mktemp)"
        printf '%s\n\n' "$BLOCK" > "$tmp_file"
        cat "$agents_path" >> "$tmp_file"
        mv "$tmp_file" "$agents_path"
        info "prepended marker block to $agents_path"
      fi
    else
      # Create new AGENTS.md with the block.
      printf '%s\n' "$BLOCK" > "$agents_path"
      info "created $agents_path with marker block"
    fi
  else
    # Check mode: verify marker block exists and matches.
    if [ ! -f "$agents_path" ]; then
      fail "$agents_path missing - run install first"
    elif ! grep -qF "$BEGIN_MARKER" "$agents_path"; then
      fail "$agents_path missing skillwiki marker block - run install first"
    elif ! grep -qF "$END_MARKER" "$agents_path"; then
      fail "$agents_path has begin marker but missing end marker - manual fix needed"
    elif ! grep -qF "$REFERENCE_LINE" "$agents_path"; then
      fail "$agents_path marker block has stale reference line - run install to update"
    fi
  fi
done

if [ "$ERRORS" -ne 0 ]; then
  echo "Activation install check failed with $ERRORS error(s)." >&2
  exit 1
fi

if [ "$MODE" = "check" ]; then
  info "SkillWiki activation files are current."
else
  info "SkillWiki activation files installed."
fi