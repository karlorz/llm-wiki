#!/usr/bin/env bash
set -euo pipefail

# materialize-plugin-assets.sh
#
# Regenerate install-facing plugin layouts from the canonical package source:
#   - packages/skills/<skill>/SKILL.md is the canonical skill source
#   - packages/skills/agents/*.md is the canonical agent source
#   - packages/skills/hooks/* contains canonical hook assets
#
# Default mode writes mirrors. Use --check for read-only drift detection.

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
SKILLS_DIR="$REPO_ROOT/packages/skills"
CODEX_PLUGIN_ROOT="$REPO_ROOT/packages/codex-skills"

ERRORS=0

fail() {
  echo "ERROR: $*" >&2
  ERRORS=$((ERRORS + 1))
}

info() {
  printf '%s\n' "$*"
}

canonical_skill_names() {
  find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -print | while IFS= read -r dir; do
    if [ -f "$dir/SKILL.md" ]; then
      basename "$dir"
    fi
  done | sort
}

contains_name() {
  local names="$1" name="$2"
  printf '%s\n' "$names" | grep -Fxq "$name"
}

ensure_real_dir() {
  local path="$1" label="$2"

  if [ -L "$path" ]; then
    fail "$label must be a real directory, not a symlink: $path"
    return
  fi

  if [ "$MODE" = "apply" ]; then
    mkdir -p "$path"
  elif [ ! -d "$path" ]; then
    fail "$label missing: $path"
  fi
}

sync_file() {
  local src="$1" dest="$2" label="$3"

  if [ "$MODE" = "apply" ]; then
    if [ -L "$dest" ]; then
      fail "$label must be a real file, not a symlink: $dest"
      return
    fi
    mkdir -p "$(dirname "$dest")"
    cp -p "$src" "$dest"
    info "materialized $label"
    return
  fi

  if [ ! -f "$dest" ]; then
    fail "$label missing: $dest"
  elif [ -L "$dest" ]; then
    fail "$label must be a real file, not a symlink: $dest"
  elif ! cmp -s "$src" "$dest"; then
    fail "$label drift: $dest differs from $src"
  fi
}

sync_dir_exact() {
  local src="$1" dest="$2" label="$3"

  ensure_real_dir "$dest" "$label"
  if [ -L "$dest" ]; then
    return
  fi

  if [ "$MODE" = "apply" ]; then
    rsync -a --delete "$src/" "$dest/"
    info "materialized $label"
    return
  fi

  if [ -d "$dest" ] && find "$dest" -type l -print | grep -q .; then
    fail "$label must contain real files, not symlinks: $dest"
  fi

  if [ -d "$dest" ] && ! diff -rq "$src" "$dest" >/dev/null; then
    fail "$label drift: $dest differs from $src"
  fi
}

sync_skill_mirror() {
  local dest="$1" label="$2"
  local names name source_dir dest_dir existing existing_name

  names="$(canonical_skill_names)"
  ensure_real_dir "$dest" "$label"
  if [ -L "$dest" ]; then
    return
  fi

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    source_dir="$SKILLS_DIR/$name"
    dest_dir="$dest/$name"

    if [ "$MODE" = "apply" ]; then
      rm -rf "$dest_dir"
      mkdir -p "$dest_dir"
      rsync -a --delete "$source_dir/" "$dest_dir/"
      continue
    fi

    if [ ! -d "$dest_dir" ]; then
      fail "$label missing skill mirror: $name"
    elif [ -L "$dest_dir" ]; then
      fail "$label skill mirror must be a real directory, not a symlink: $dest_dir"
    elif find "$dest_dir" -type l -print | grep -q .; then
      fail "$label skill mirror must contain real files, not symlinks: $name"
    elif ! diff -rq "$source_dir" "$dest_dir" >/dev/null; then
      fail "$label skill mirror drift: $name"
    fi
  done <<EOF
$names
EOF

  if [ -d "$dest" ]; then
    for existing in "$dest"/*; do
      [ -e "$existing" ] || continue
      [ -d "$existing" ] || continue
      existing_name="$(basename "$existing")"
      if ! contains_name "$names" "$existing_name"; then
        if [ "$MODE" = "apply" ]; then
          rm -rf "$existing"
        else
          fail "$label has extra skill mirror: $existing_name"
        fi
      fi
    done
  fi

  if [ "$MODE" = "apply" ]; then
    info "materialized $label"
  fi
}

# Codex compatibility mirror inside the canonical package.
sync_skill_mirror "$SKILLS_DIR/skills" "packages/skills/skills"

# Codex-native plugin root.
sync_file "$SKILLS_DIR/.codex-plugin/plugin.json" \
  "$CODEX_PLUGIN_ROOT/.codex-plugin/plugin.json" \
  "packages/codex-skills/.codex-plugin/plugin.json"
sync_skill_mirror "$CODEX_PLUGIN_ROOT/skills" "packages/codex-skills/skills"
ensure_real_dir "$CODEX_PLUGIN_ROOT/hooks" "packages/codex-skills/hooks"
sync_file "$SKILLS_DIR/hooks/hooks-codex.json" "$CODEX_PLUGIN_ROOT/hooks/hooks-codex.json" "packages/codex-skills/hooks/hooks-codex.json"
sync_file "$SKILLS_DIR/hooks/run-hook.cmd" "$CODEX_PLUGIN_ROOT/hooks/run-hook.cmd" "packages/codex-skills/hooks/run-hook.cmd"
sync_file "$SKILLS_DIR/hooks/session-context" "$CODEX_PLUGIN_ROOT/hooks/session-context" "packages/codex-skills/hooks/session-context"
sync_file "$SKILLS_DIR/hooks/session-start-codex" "$CODEX_PLUGIN_ROOT/hooks/session-start-codex" "packages/codex-skills/hooks/session-start-codex"

if [ "$MODE" = "apply" ]; then
  rm -f "$CODEX_PLUGIN_ROOT/hooks/hooks.json"
elif [ -e "$CODEX_PLUGIN_ROOT/hooks/hooks.json" ]; then
  fail "packages/codex-skills/hooks/hooks.json must not exist; Codex uses hooks-codex.json"
fi

# Root Antigravity/agy direct-install layout.
sync_skill_mirror "$REPO_ROOT/skills" "root skills"
sync_dir_exact "$SKILLS_DIR/agents" "$REPO_ROOT/agents" "root agents"
ensure_real_dir "$REPO_ROOT/hooks" "root hooks"
sync_file "$SKILLS_DIR/hooks/hooks.json" "$REPO_ROOT/hooks/hooks.json" "root hooks/hooks.json"
sync_file "$SKILLS_DIR/hooks/run-hook.cmd" "$REPO_ROOT/hooks/run-hook.cmd" "root hooks/run-hook.cmd"
sync_file "$SKILLS_DIR/hooks/session-context" "$REPO_ROOT/hooks/session-context" "root hooks/session-context"
sync_file "$SKILLS_DIR/hooks/session-start" "$REPO_ROOT/hooks/session-start" "root hooks/session-start"
sync_file "$SKILLS_DIR/hooks/hooks.json" "$REPO_ROOT/hooks.json" "root hooks.json compatibility copy"
sync_file "$REPO_ROOT/plugin.json" "$REPO_ROOT/.claude-plugin/plugin.json" "root .claude-plugin/plugin.json"

if [ "$MODE" = "apply" ]; then
  rm -f "$REPO_ROOT/hooks/hooks-codex.json" "$REPO_ROOT/hooks/session-start-codex"
else
  for codex_only_hook in hooks/hooks-codex.json hooks/session-start-codex; do
    if [ -e "$REPO_ROOT/$codex_only_hook" ]; then
      fail "root agy layout must not expose Codex-only hook asset: $codex_only_hook"
    fi
  done
fi

if [ "$ERRORS" -ne 0 ]; then
  echo "Plugin asset materialization check failed with $ERRORS error(s)." >&2
  exit 1
fi

if [ "$MODE" = "check" ]; then
  info "Plugin materialized assets are current."
else
  info "Plugin materialized assets updated."
fi
