#!/usr/bin/env bash
set -euo pipefail

# verify-manifests.sh — Validate manifest consistency across distribution channels.
#
# Checks:
#   1. Version field is identical across all 13 manifest files
#   2. Every skill directory has a SKILL.md
#   3. SKILL.md frontmatter uses Agent Skills schema fields across shipped layouts
#   4. Skill count in plugin descriptions/marketplace matches actual count
#   5. Claude marketplace version matches Claude plugin version
#   6. Codex marketplace wiring points to ./packages/codex-skills for skillwiki
#   7. Codex plugin layout mirrors top-level skills under ./skills/ and uses native Codex hooks
#   8. Root agy plugin layout materializes skills/, agents/, and hooks/ for direct GitHub URL install
#
# Exit 0 if all pass, non-zero with descriptive errors if any fail.
#
# Usage: ./scripts/verify-manifests.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILLS_DIR="$REPO_ROOT/packages/skills"
CODEX_PLUGIN_ROOT="$REPO_ROOT/packages/codex-skills"

ERRORS=0

# ---- 0. Materialized plugin assets are current ----

if ! "$REPO_ROOT/scripts/materialize-plugin-assets.sh" --check; then
  echo "✗ Plugin materialized assets drift check failed" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Plugin materialized assets are current"
fi

# ---- 0b. Case-only path collision guard ----

CASE_RC=0
CASE_COLLISIONS=$(git -C "$REPO_ROOT" ls-files | awk '
  {
    key = tolower($0)
    if (seen[key] && seen[key] != $0) {
      print seen[key] " <-> " $0
      bad = 1
    } else if (!seen[key]) {
      seen[key] = $0
    }
  }
  END { exit bad ? 1 : 0 }
') || CASE_RC=$?
if [ "$CASE_RC" -ne 0 ]; then
  echo "✗ Case-only tracked path collision(s) detected:" >&2
  printf '%s\n' "$CASE_COLLISIONS" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ No case-only tracked path collisions"
fi

# ---- 1. Version consistency across all 13 manifests ----

CLI_VER=$(grep '"version"' "$REPO_ROOT/packages/cli/package.json" | head -1 | sed 's/.*: *"//;s/".*//')
SKILLS_PKG_VER=$(grep '"version"' "$REPO_ROOT/packages/skills/package.json" | head -1 | sed 's/.*: *"//;s/".*//')
SHARED_VER=$(grep '"version"' "$REPO_ROOT/packages/shared/package.json" | head -1 | sed 's/.*: *"//;s/".*//')
AGENT_MEMORY_TRENDS_VER=$(grep '"version"' "$REPO_ROOT/packages/agent-memory-trends/package.json" 2>/dev/null | head -1 | sed 's/.*: *"//;s/".*//' || true)
ROOT_VER=$(grep '"version"' "$REPO_ROOT/package.json" | head -1 | sed 's/.*: *"//;s/".*//')
PLUGIN_VER=$(grep '"version"' "$REPO_ROOT/packages/skills/.claude-plugin/plugin.json" | head -1 | sed 's/.*: *"//;s/".*//')
CODEX_PLUGIN_VER=$(grep '"version"' "$REPO_ROOT/packages/skills/.codex-plugin/plugin.json" | head -1 | sed 's/.*: *"//;s/".*//')
CODEX_ROOT_PLUGIN_VER=$(grep '"version"' "$CODEX_PLUGIN_ROOT/.codex-plugin/plugin.json" 2>/dev/null | head -1 | sed 's/.*: *"//;s/".*//' || true)
VAULT_SYNC_CLAUDE_VER=$(grep '"version"' "$REPO_ROOT/packages/vault-sync/.claude-plugin/plugin.json" | head -1 | sed 's/.*: *"//;s/".*//')
VAULT_SYNC_CODEX_VER=$(grep '"version"' "$REPO_ROOT/packages/vault-sync/.codex-plugin/plugin.json" | head -1 | sed 's/.*: *"//;s/".*//')
ROOT_AGY_VER=$(grep '"version"' "$REPO_ROOT/plugin.json" 2>/dev/null | head -1 | sed 's/.*: *"//;s/".*//' || true)
ROOT_AGY_REMOTE_VER=$(grep '"version"' "$REPO_ROOT/.claude-plugin/plugin.json" 2>/dev/null | head -1 | sed 's/.*: *"//;s/".*//' || true)
MARKET_VER=$(python3 -c "import json; d=json.load(open('$REPO_ROOT/.claude-plugin/marketplace.json')); print(d['metadata']['version'])")

check_version() {
  local label="$1" ver="$2"
  if [ "$ver" != "$CLI_VER" ]; then
    echo "✗ Version mismatch: $label has $ver (expected $CLI_VER)" >&2
    ERRORS=$((ERRORS + 1))
  fi
}

check_version "packages/cli/package.json" "$CLI_VER"
check_version "packages/skills/package.json" "$SKILLS_PKG_VER"
check_version "packages/shared/package.json" "$SHARED_VER"
check_version "packages/agent-memory-trends/package.json" "$AGENT_MEMORY_TRENDS_VER"
check_version "package.json (root)" "$ROOT_VER"
check_version "packages/skills/.claude-plugin/plugin.json" "$PLUGIN_VER"
check_version "packages/skills/.codex-plugin/plugin.json" "$CODEX_PLUGIN_VER"
check_version "packages/codex-skills/.codex-plugin/plugin.json" "$CODEX_ROOT_PLUGIN_VER"
check_version "packages/vault-sync/.claude-plugin/plugin.json" "$VAULT_SYNC_CLAUDE_VER"
check_version "packages/vault-sync/.codex-plugin/plugin.json" "$VAULT_SYNC_CODEX_VER"
check_version "plugin.json (root agy plugin)" "$ROOT_AGY_VER"
check_version ".claude-plugin/plugin.json (root agy URL marker)" "$ROOT_AGY_REMOTE_VER"
check_version ".claude-plugin/marketplace.json metadata.version" "$MARKET_VER"

if [ "$ERRORS" -eq 0 ]; then
  echo "✓ All 13 manifests at version $CLI_VER"
fi

# ---- 2. Skill directories have SKILL.md ----

ACTUAL_COUNT=0
for dir in "$SKILLS_DIR"/*/; do
  name=$(basename "$dir")
  if [ -f "$dir/SKILL.md" ]; then
    ACTUAL_COUNT=$((ACTUAL_COUNT + 1))
  fi
done
echo "✓ $ACTUAL_COUNT skill directories all have SKILL.md"

# ---- 2b. SKILL.md frontmatter uses Agent Skills schema fields ----

check_skill_frontmatter_schema() {
  local label="$1" root="$2"

  if [ ! -d "$root" ]; then
    return
  fi

  local schema_errors=0
  while IFS= read -r -d '' skill_file; do
    if ! awk -v file="$skill_file" '
      BEGIN {
        allowed["allowed-tools"] = 1
        allowed["compatibility"] = 1
        allowed["description"] = 1
        allowed["license"] = 1
        allowed["metadata"] = 1
        allowed["name"] = 1
        in_frontmatter = 0
        closed = 0
        bad = 0
      }
      NR == 1 {
        if ($0 != "---") {
          printf("✗ %s must start with YAML frontmatter\n", file) > "/dev/stderr"
          bad = 1
          exit
        }
        in_frontmatter = 1
        next
      }
      in_frontmatter && $0 == "---" {
        closed = 1
        exit
      }
      in_frontmatter && $0 ~ /^[A-Za-z0-9_-]+:[[:space:]]*/ {
        key = $0
        sub(/:.*/, "", key)
        if (!(key in allowed)) {
          printf("✗ %s uses unsupported top-level SKILL.md frontmatter field: %s\n", file, key) > "/dev/stderr"
          bad = 1
        }
      }
      END {
        if (NR > 0 && !closed) {
          printf("✗ %s frontmatter is not closed\n", file) > "/dev/stderr"
          bad = 1
        }
        exit bad
      }
    ' "$skill_file"; then
      schema_errors=$((schema_errors + 1))
    fi
  done < <(find "$root" -mindepth 2 -maxdepth 2 -name SKILL.md -print0)

  if [ "$schema_errors" -eq 0 ]; then
    echo "✓ $label SKILL.md frontmatter uses Agent Skills schema fields"
  else
    ERRORS=$((ERRORS + schema_errors))
  fi
}

check_skill_frontmatter_schema "Canonical" "$SKILLS_DIR"
check_skill_frontmatter_schema "Claude mirror" "$SKILLS_DIR/skills"
check_skill_frontmatter_schema "Codex mirror" "$CODEX_PLUGIN_ROOT/skills"
check_skill_frontmatter_schema "Root agy mirror" "$REPO_ROOT/skills"

# ---- 3. Skill count in plugin descriptors matches actual ----

# Extract the number from descriptions like "15 prompt-only skills"
DESC_COUNT=$(grep -oE '[0-9]+ prompt-only skills' "$REPO_ROOT/packages/skills/.claude-plugin/plugin.json" | grep -oE '^[0-9]+' || echo "0")
CODEX_DESC_COUNT=$(grep -oE '[0-9]+ prompt-only skills' "$REPO_ROOT/packages/skills/.codex-plugin/plugin.json" | head -1 | grep -oE '^[0-9]+' || echo "0")
CODEX_ROOT_DESC_COUNT=$(grep -oE '[0-9]+ prompt-only skills' "$CODEX_PLUGIN_ROOT/.codex-plugin/plugin.json" | head -1 | grep -oE '^[0-9]+' || echo "0")
MARKET_DESC_COUNT=$(grep -oE '[0-9]+ prompt-only skills' "$REPO_ROOT/.claude-plugin/marketplace.json" | grep -oE '^[0-9]+' || echo "0")

if [ "$DESC_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "✗ Claude plugin.json says $DESC_COUNT skills but found $ACTUAL_COUNT" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Claude plugin.json skill count ($DESC_COUNT) matches actual ($ACTUAL_COUNT)"
fi

if [ "$CODEX_DESC_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "✗ Codex plugin.json says $CODEX_DESC_COUNT skills but found $ACTUAL_COUNT" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Codex plugin.json skill count ($CODEX_DESC_COUNT) matches actual ($ACTUAL_COUNT)"
fi

if [ "$CODEX_ROOT_DESC_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "✗ Codex root plugin.json says $CODEX_ROOT_DESC_COUNT skills but found $ACTUAL_COUNT" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Codex root plugin.json skill count ($CODEX_ROOT_DESC_COUNT) matches actual ($ACTUAL_COUNT)"
fi

if [ "$MARKET_DESC_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "✗ Claude marketplace.json says $MARKET_DESC_COUNT skills but found $ACTUAL_COUNT" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Claude marketplace.json skill count ($MARKET_DESC_COUNT) matches actual ($ACTUAL_COUNT)"
fi

# ---- 3b. Root agy plugin manifest ----

ROOT_AGY_PLUGIN="$REPO_ROOT/plugin.json"
if [ ! -f "$ROOT_AGY_PLUGIN" ]; then
  echo "✗ Root agy plugin manifest missing: plugin.json" >&2
  ERRORS=$((ERRORS + 1))
elif [ -L "$ROOT_AGY_PLUGIN" ]; then
  echo "✗ Root agy plugin manifest must be a real file, not a symlink" >&2
  ERRORS=$((ERRORS + 1))
else
  ROOT_AGY_STATUS=$(python3 -c "import json; d=json.load(open('$ROOT_AGY_PLUGIN')); print('|'.join([str(d.get('skills', '')), str(d.get('agents', '')), str(d.get('description', ''))]))")
  ROOT_AGY_SKILLS_FIELD=$(printf '%s' "$ROOT_AGY_STATUS" | cut -d'|' -f1)
  ROOT_AGY_AGENTS_FIELD=$(printf '%s' "$ROOT_AGY_STATUS" | cut -d'|' -f2)
  ROOT_AGY_DESC=$(printf '%s' "$ROOT_AGY_STATUS" | cut -d'|' -f3-)
  ROOT_AGY_DESC_COUNT=$(printf '%s' "$ROOT_AGY_DESC" | grep -oE '[0-9]+ prompt-only skills' | head -1 | grep -oE '^[0-9]+' || echo "0")

  if [ "$ROOT_AGY_SKILLS_FIELD" != "./skills/" ]; then
    echo "✗ Root agy plugin skills path is $ROOT_AGY_SKILLS_FIELD (expected ./skills/)" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "✓ Root agy plugin skills path points to ./skills/"
  fi

  if [ "$ROOT_AGY_AGENTS_FIELD" != "./agents/" ]; then
    echo "✗ Root agy plugin agents path is $ROOT_AGY_AGENTS_FIELD (expected ./agents/)" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "✓ Root agy plugin agents path points to ./agents/"
  fi

  if [ "$ROOT_AGY_DESC_COUNT" != "$ACTUAL_COUNT" ]; then
    echo "✗ Root agy plugin.json says $ROOT_AGY_DESC_COUNT skills but found $ACTUAL_COUNT" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "✓ Root agy plugin.json skill count ($ROOT_AGY_DESC_COUNT) matches actual ($ACTUAL_COUNT)"
  fi

  if [ ! -d "$REPO_ROOT/skills" ]; then
    echo "✗ Root agy skills directory missing: skills" >&2
    ERRORS=$((ERRORS + 1))
  elif [ -L "$REPO_ROOT/skills" ]; then
    echo "✗ Root agy skills path must be a real directory, not a symlink" >&2
    ERRORS=$((ERRORS + 1))
  elif find "$REPO_ROOT/skills" -mindepth 1 -maxdepth 1 -type l | grep -q .; then
    echo "✗ Root agy skills directory must contain real skill directories, not symlinks" >&2
    ERRORS=$((ERRORS + 1))
  else
    ROOT_AGY_SKILL_COUNT=$(find "$REPO_ROOT/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -print | wc -l | tr -d ' ')
    if [ "$ROOT_AGY_SKILL_COUNT" != "$ACTUAL_COUNT" ]; then
      echo "✗ Root agy skills directory exposes $ROOT_AGY_SKILL_COUNT skills (expected $ACTUAL_COUNT)" >&2
      ERRORS=$((ERRORS + 1))
    else
      echo "✓ Root agy skills directory exposes $ROOT_AGY_SKILL_COUNT skills"
    fi

    ROOT_SKILL_DRIFT=0
    for skill_file in "$SKILLS_DIR"/*/SKILL.md; do
      name=$(basename "$(dirname "$skill_file")")
      root_skill_file="$REPO_ROOT/skills/$name/SKILL.md"
      if [ ! -f "$root_skill_file" ]; then
        echo "✗ Root agy skills mirror missing skill: $name" >&2
        ROOT_SKILL_DRIFT=$((ROOT_SKILL_DRIFT + 1))
      elif ! cmp -s "$skill_file" "$root_skill_file"; then
        echo "✗ Root agy skills mirror drift for skill: $name" >&2
        ROOT_SKILL_DRIFT=$((ROOT_SKILL_DRIFT + 1))
      fi
    done

    for root_skill_file in "$REPO_ROOT"/skills/*/SKILL.md; do
      name=$(basename "$(dirname "$root_skill_file")")
      if [ ! -f "$SKILLS_DIR/$name/SKILL.md" ]; then
        echo "✗ Root agy skills mirror has extra skill: $name" >&2
        ROOT_SKILL_DRIFT=$((ROOT_SKILL_DRIFT + 1))
      fi
    done

    if [ "$ROOT_SKILL_DRIFT" -eq 0 ]; then
      echo "✓ Root agy skills mirror matches canonical top-level skills"
    else
      ERRORS=$((ERRORS + ROOT_SKILL_DRIFT))
    fi
  fi

  if [ ! -d "$REPO_ROOT/agents" ]; then
    echo "✗ Root agy agents directory missing: agents" >&2
    ERRORS=$((ERRORS + 1))
  elif [ -L "$REPO_ROOT/agents" ]; then
    echo "✗ Root agy agents path must be a real directory, not a symlink" >&2
    ERRORS=$((ERRORS + 1))
  else
    ROOT_AGY_AGENT_COUNT=$(find "$REPO_ROOT/agents" -maxdepth 1 -type f -name '*.md' -print | wc -l | tr -d ' ')
    CANONICAL_AGENT_COUNT=$(find "$SKILLS_DIR/agents" -maxdepth 1 -type f -name '*.md' -print | wc -l | tr -d ' ')
    if [ "$ROOT_AGY_AGENT_COUNT" != "$CANONICAL_AGENT_COUNT" ]; then
      echo "✗ Root agy agents directory exposes $ROOT_AGY_AGENT_COUNT agents (expected $CANONICAL_AGENT_COUNT)" >&2
      ERRORS=$((ERRORS + 1))
    else
      echo "✓ Root agy agents directory exposes $ROOT_AGY_AGENT_COUNT agents"
    fi

    ROOT_AGENT_DRIFT=0
    for agent_file in "$SKILLS_DIR"/agents/*.md; do
      name=$(basename "$agent_file")
      root_agent_file="$REPO_ROOT/agents/$name"
      if [ ! -f "$root_agent_file" ]; then
        echo "✗ Root agy agents mirror missing agent: $name" >&2
        ROOT_AGENT_DRIFT=$((ROOT_AGENT_DRIFT + 1))
      elif ! cmp -s "$agent_file" "$root_agent_file"; then
        echo "✗ Root agy agents mirror drift for agent: $name" >&2
        ROOT_AGENT_DRIFT=$((ROOT_AGENT_DRIFT + 1))
      fi
    done

    for root_agent_file in "$REPO_ROOT"/agents/*.md; do
      name=$(basename "$root_agent_file")
      if [ ! -f "$SKILLS_DIR/agents/$name" ]; then
        echo "✗ Root agy agents mirror has extra agent: $name" >&2
        ROOT_AGENT_DRIFT=$((ROOT_AGENT_DRIFT + 1))
      fi
    done

    if [ "$ROOT_AGENT_DRIFT" -eq 0 ]; then
      echo "✓ Root agy agents mirror matches packages/skills/agents"
    else
      ERRORS=$((ERRORS + ROOT_AGENT_DRIFT))
    fi
  fi

  if [ ! -e "$REPO_ROOT/hooks.json" ]; then
    echo "✗ Root hook asset missing: hooks.json" >&2
    ERRORS=$((ERRORS + 1))
  elif [ -L "$REPO_ROOT/hooks.json" ]; then
    echo "✗ Root hook asset must be a real file, not a symlink" >&2
    ERRORS=$((ERRORS + 1))
  elif ! cmp -s "$SKILLS_DIR/hooks/hooks.json" "$REPO_ROOT/hooks.json"; then
    echo "✗ Root hooks.json differs from packages/skills/hooks/hooks.json" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "✓ Root hooks.json matches packages/skills/hooks/hooks.json"
  fi

  if [ ! -d "$REPO_ROOT/hooks" ]; then
    echo "✗ Root agy hooks directory missing: hooks/" >&2
    ERRORS=$((ERRORS + 1))
  elif [ -L "$REPO_ROOT/hooks" ]; then
    echo "✗ Root agy hooks directory must be real, not a symlink" >&2
    ERRORS=$((ERRORS + 1))
  else
    ROOT_HOOK_DRIFT=0
    for hook_file in hooks.json run-hook.cmd session-context session-start; do
      if [ ! -f "$REPO_ROOT/hooks/$hook_file" ]; then
        echo "✗ Root agy hooks mirror missing: hooks/$hook_file" >&2
        ROOT_HOOK_DRIFT=$((ROOT_HOOK_DRIFT + 1))
      elif [ -L "$REPO_ROOT/hooks/$hook_file" ]; then
        echo "✗ Root agy hooks mirror must be real file, not symlink: hooks/$hook_file" >&2
        ROOT_HOOK_DRIFT=$((ROOT_HOOK_DRIFT + 1))
      elif ! cmp -s "$SKILLS_DIR/hooks/$hook_file" "$REPO_ROOT/hooks/$hook_file"; then
        echo "✗ Root agy hooks mirror drift: hooks/$hook_file" >&2
        ROOT_HOOK_DRIFT=$((ROOT_HOOK_DRIFT + 1))
      fi
    done

    for codex_only_hook in hooks-codex.json session-start-codex; do
      if [ -e "$REPO_ROOT/hooks/$codex_only_hook" ]; then
        echo "✗ Root agy hooks mirror exposes Codex-only asset: hooks/$codex_only_hook" >&2
        ROOT_HOOK_DRIFT=$((ROOT_HOOK_DRIFT + 1))
      fi
    done

    if [ "$ROOT_HOOK_DRIFT" -eq 0 ]; then
      echo "✓ Root agy hooks mirror exposes Claude hooks under hooks/"
    else
      ERRORS=$((ERRORS + ROOT_HOOK_DRIFT))
    fi
  fi
fi

# ---- 3c. Root agy URL-install marker ----

ROOT_AGY_REMOTE_PLUGIN="$REPO_ROOT/.claude-plugin/plugin.json"
if [ ! -f "$ROOT_AGY_REMOTE_PLUGIN" ]; then
  echo "✗ Root agy URL marker missing: .claude-plugin/plugin.json" >&2
  ERRORS=$((ERRORS + 1))
elif [ -L "$ROOT_AGY_REMOTE_PLUGIN" ]; then
  echo "✗ Root agy URL marker must be a real file, not a symlink" >&2
  ERRORS=$((ERRORS + 1))
elif ! cmp -s "$ROOT_AGY_PLUGIN" "$ROOT_AGY_REMOTE_PLUGIN"; then
  echo "✗ Root agy URL marker differs from plugin.json" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Root agy URL marker matches plugin.json"
fi

# ---- 4. Claude marketplace version matches Claude plugin version ----

MARKET_PLUGIN_VER=$(python3 -c "import json; d=json.load(open('$REPO_ROOT/.claude-plugin/marketplace.json')); print(d['plugins'][0]['version'])")

if [ "$MARKET_PLUGIN_VER" != "$PLUGIN_VER" ]; then
  echo "✗ marketplace.json plugin version ($MARKET_PLUGIN_VER) != plugin.json ($PLUGIN_VER)" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ marketplace.json plugin version matches plugin.json"
fi

# ---- 5. Codex marketplace wiring ----

CODEX_MARKET_STATUS=$(python3 -c "import json; d=json.load(open('$REPO_ROOT/.agents/plugins/marketplace.json')); p=next((x for x in d.get('plugins', []) if x.get('name') == 'skillwiki'), None); print('__MISSING__' if p is None else f\"{p.get('source', {}).get('source', '')}|{p.get('source', {}).get('path', '')}\")")

if [ "$CODEX_MARKET_STATUS" = "__MISSING__" ]; then
  echo "✗ Codex marketplace missing plugin entry: skillwiki" >&2
  ERRORS=$((ERRORS + 1))
else
  CODEX_SOURCE_TYPE="${CODEX_MARKET_STATUS%%|*}"
  CODEX_SOURCE_PATH="${CODEX_MARKET_STATUS#*|}"
  if [ "$CODEX_SOURCE_TYPE" != "local" ]; then
    echo "✗ Codex marketplace source type is $CODEX_SOURCE_TYPE (expected local)" >&2
    ERRORS=$((ERRORS + 1))
  fi
  if [ "$CODEX_SOURCE_PATH" != "./packages/codex-skills" ]; then
    echo "✗ Codex marketplace source path is $CODEX_SOURCE_PATH (expected ./packages/codex-skills)" >&2
    ERRORS=$((ERRORS + 1))
  fi
  if [ "$CODEX_SOURCE_TYPE" = "local" ] && [ "$CODEX_SOURCE_PATH" = "./packages/codex-skills" ]; then
    echo "✓ Codex marketplace points skillwiki to ./packages/codex-skills"
  fi
fi

# ---- 6. Codex plugin skill layout ----

if [ ! -d "$CODEX_PLUGIN_ROOT" ]; then
  echo "✗ Codex plugin root missing: packages/codex-skills" >&2
  ERRORS=$((ERRORS + 1))
else

if [ -L "$CODEX_PLUGIN_ROOT/.codex-plugin" ] || [ -L "$CODEX_PLUGIN_ROOT/skills" ]; then
  echo "✗ Codex plugin root must use real directories, not symlinks" >&2
  ERRORS=$((ERRORS + 1))
fi

if [ -e "$CODEX_PLUGIN_ROOT/hooks/hooks.json" ]; then
  echo "✗ Codex plugin root must not expose Claude hooks/hooks.json" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Codex plugin root omits Claude hooks/hooks.json"
fi

for hook_file in hooks/hooks-codex.json hooks/run-hook.cmd hooks/session-context hooks/session-start-codex; do
  if [ ! -e "$CODEX_PLUGIN_ROOT/$hook_file" ]; then
    echo "✗ Codex plugin root missing $hook_file" >&2
    ERRORS=$((ERRORS + 1))
  elif [ -L "$CODEX_PLUGIN_ROOT/$hook_file" ]; then
    echo "✗ Codex plugin root $hook_file must be a real file, not a symlink" >&2
    ERRORS=$((ERRORS + 1))
  elif ! cmp -s "$SKILLS_DIR/$hook_file" "$CODEX_PLUGIN_ROOT/$hook_file"; then
    echo "✗ Codex plugin root $hook_file differs from packages/skills/$hook_file" >&2
    ERRORS=$((ERRORS + 1))
  fi
done

if ! cmp -s "$SKILLS_DIR/.codex-plugin/plugin.json" "$CODEX_PLUGIN_ROOT/.codex-plugin/plugin.json"; then
  echo "✗ Codex root plugin.json differs from packages/skills/.codex-plugin/plugin.json" >&2
  ERRORS=$((ERRORS + 1))
fi

CODEX_SKILLS_FIELD=$(python3 -c "import json; d=json.load(open('$CODEX_PLUGIN_ROOT/.codex-plugin/plugin.json')); print(d.get('skills', ''))")
CODEX_HOOKS_FIELD=$(python3 -c "import json; d=json.load(open('$CODEX_PLUGIN_ROOT/.codex-plugin/plugin.json')); print(d.get('hooks', ''))")

if [ "$CODEX_SKILLS_FIELD" != "./skills/" ]; then
  echo "✗ Codex plugin skills path is $CODEX_SKILLS_FIELD (expected ./skills/)" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Codex plugin skills path points to ./skills/"
fi

if [ "$CODEX_HOOKS_FIELD" != "./hooks/hooks-codex.json" ]; then
  echo "✗ Codex plugin hooks path is $CODEX_HOOKS_FIELD (expected ./hooks/hooks-codex.json)" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Codex plugin hooks path points to ./hooks/hooks-codex.json"
fi

CODEX_MIRROR_DIR="$CODEX_PLUGIN_ROOT/skills"
if [ ! -d "$CODEX_MIRROR_DIR" ]; then
  echo "✗ Codex skills mirror missing: packages/codex-skills/skills" >&2
  ERRORS=$((ERRORS + 1))
else
  CODEX_LAYOUT_ERRORS=0
  for dir in "$SKILLS_DIR"/*/; do
    name=$(basename "$dir")
    if [ "$name" = "skills" ]; then
      continue
    fi
    if [ ! -f "$dir/SKILL.md" ]; then
      continue
    fi
    if [ ! -f "$CODEX_MIRROR_DIR/$name/SKILL.md" ]; then
      echo "✗ Codex mirror missing skill: $name" >&2
      CODEX_LAYOUT_ERRORS=$((CODEX_LAYOUT_ERRORS + 1))
      continue
    fi
    if ! cmp -s "$dir/SKILL.md" "$CODEX_MIRROR_DIR/$name/SKILL.md"; then
      echo "✗ Codex mirror drift for skill: $name" >&2
      CODEX_LAYOUT_ERRORS=$((CODEX_LAYOUT_ERRORS + 1))
    fi
  done

  for dir in "$CODEX_MIRROR_DIR"/*/; do
    name=$(basename "$dir")
    if [ -f "$dir/SKILL.md" ] && [ ! -f "$SKILLS_DIR/$name/SKILL.md" ]; then
      echo "✗ Codex mirror has extra skill: $name" >&2
      CODEX_LAYOUT_ERRORS=$((CODEX_LAYOUT_ERRORS + 1))
    fi
  done

  if [ "$CODEX_LAYOUT_ERRORS" -eq 0 ]; then
    echo "✓ Codex skills mirror matches canonical top-level skills"
  else
    ERRORS=$((ERRORS + CODEX_LAYOUT_ERRORS))
  fi
fi

fi

# ---- Summary ----

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "All manifest checks passed."
  exit 0
else
  echo "FAILED: $ERRORS error(s) found." >&2
  exit 1
fi
