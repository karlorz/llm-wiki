# Plugin Intro & Housekeeping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix plugin version mismatch, eliminate duplicate skills, and add a `using-skillwiki` onboarding skill with a session-start hook for auto-injection.

**Architecture:** Four targeted fixes to the plugin manifests and skill layout. The session-start hook follows the superpowers pattern: a polyglot `run-hook.cmd` wrapper dispatches to a bash `session-start` script that reads `using-skillwiki/SKILL.md`, JSON-escapes it, and emits it as `hookSpecificOutput.additionalContext`.

**Tech Stack:** JSON manifests, Markdown SKILL.md, bash hook scripts. No TypeScript changes.

---

### Task 1: Version sync and deduplicate skills

**Files:**
- Modify: `packages/skills/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

These two manifest changes are bundled because they're both small JSON edits to the same logical concern (plugin metadata).

- [ ] **Step 1: Bump version and remove duplicate skills field in marketplace.json**

In `.claude-plugin/marketplace.json`, change `metadata.version` from `"0.1.0"` to `"0.2.0-beta.4"`, change `plugins[0].version` from `"0.1.0"` to `"0.2.0-beta.4"`, and remove the `"skills": "./"` line from `plugins[0]`.

The file should become:

```json
{
  "name": "llm-wiki",
  "owner": {
    "name": "karlorz",
    "url": "https://github.com/karlorz"
  },
  "metadata": {
    "description": "Single-plugin marketplace for skillwiki — project-aware Karpathy-style knowledge base for Claude Code.",
    "version": "0.2.0-beta.4"
  },
  "plugins": [
    {
      "name": "skillwiki",
      "description": "11 prompt-only skills (wiki-*, proj-*, using-skillwiki) backed by the deterministic skillwiki CLI.",
      "version": "0.2.0-beta.4",
      "source": "./packages/skills",
      "strict": true,
      "author": {
        "name": "karlorz",
        "url": "https://github.com/karlorz"
      },
      "homepage": "https://github.com/karlorz/llm-wiki",
      "repository": "https://github.com/karlorz/llm-wiki",
      "license": "MIT",
      "keywords": [
        "knowledge-base",
        "wiki",
        "obsidian",
        "claude-code",
        "skills",
        "karpathy"
      ]
    }
  ]
}
```

- [ ] **Step 2: Bump version in plugin.json**

In `packages/skills/.claude-plugin/plugin.json`, change `"version"` from `"0.1.0"` to `"0.2.0-beta.4"` and update the description to mention 11 skills.

The file should become:

```json
{
  "name": "skillwiki",
  "version": "0.2.0-beta.4",
  "skills": "./",
  "description": "Project-aware Karpathy-style knowledge base for Claude Code: 11 prompt-only skills (wiki-*, proj-*, using-skillwiki) backed by the deterministic `skillwiki` CLI (8 subcommands, JSON-by-default).",
  "author": {
    "name": "karlorz",
    "url": "https://github.com/karlorz"
  },
  "homepage": "https://github.com/karlorz/llm-wiki",
  "repository": "https://github.com/karlorz/llm-wiki",
  "license": "MIT",
  "keywords": [
    "knowledge-base",
    "wiki",
    "obsidian",
    "claude-code",
    "skills",
    "karpathy",
    "markdown",
    "research",
    "rag-alternative"
  ]
}
```

- [ ] **Step 3: Commit manifest changes**

```bash
git add packages/skills/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "fix(plugin): sync version to 0.2.0-beta.4 and remove duplicate skills field"
```

---

### Task 2: Add using-skillwiki onboarding skill

**Files:**
- Create: `packages/skills/using-skillwiki/SKILL.md`

This is the 11th skill — an informational map that orients Claude to the skillwiki skill family. It is flexible (not rigid), meant as a reference guide injected at session start.

- [ ] **Step 1: Create the using-skillwiki SKILL.md**

Create `packages/skills/using-skillwiki/SKILL.md` with the following content:

```markdown
---
name: using-skillwiki
description: Invoke at session start or when knowledge-base tasks arise — maps all wiki-*/proj-* skills and teaches the skillwiki CLI workflow
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>

# using-skillwiki

You have skillwiki — a project-aware Karpathy-style knowledge base for Claude Code.

## When to Use These Skills

Invoke a skillwiki skill when the user:
- Wants to create, build, or start a vault/wiki/knowledge base
- Mentions ingesting sources, reading URLs into notes, converting content
- Asks to search, query, or find information in their vault
- Wants a health check or lint on their vault
- Mentions crystallizing a session into a note
- Talks about project workspaces, ADRs, or distillation
- Asks about their skillwiki configuration or setup health

## Skill Map

| Skill | When to Invoke |
|-------|----------------|
| `wiki-init` | Bootstrap a new vault — SCHEMA.md, index.md, log.md, ~/.skillwiki/.env |
| `wiki-ingest` | Convert URLs, files, or pasted text into typed-knowledge pages |
| `wiki-query` | Search the vault and synthesize an answer with ranked results |
| `wiki-lint` | Vault health check (stale pages, oversized pages, log rotation) |
| `wiki-crystallize` | Distill the current working session into a typed-knowledge page |
| `wiki-audit` | Verify raw provenance references and source frontmatter integrity |
| `proj-init` | Bootstrap a project workspace (README, requirements, architecture) |
| `proj-work` | Open or run a work item under a project's work/ directory |
| `proj-distill` | Distill project compound entries into vault concept pages |
| `proj-decide` | Write an Architectural Decision Record (ADR) |

## CLI Backbone

All skills are backed by the `skillwiki` CLI — a deterministic tool with no LLM calls. It handles path resolution, config management, validation, and linting. Skills invoke it via Bash for the mechanical parts and use Claude for the creative parts.

Key CLI subcommands: `init`, `lint`, `config`, `doctor`, `path`, `lang`, `install`, `graph build`.

Run `skillwiki doctor` to diagnose setup issues. Run `skillwiki config list` to see current configuration.

## Typical Workflow

1. **Init** (`wiki-init`) — create vault, set domain and taxonomy
2. **Ingest** (`wiki-ingest`) — add sources, build pages
3. **Query** (`wiki-query`) — search and synthesize answers
4. **Lint** (`wiki-lint`) — periodic health checks
5. **Crystallize** (`wiki-crystallize`) — save session insights as pages
6. **Audit** (`wiki-audit`) — verify source integrity

For longer-running project work, use `proj-init` → `proj-work` → `proj-distill` / `proj-decide`.
```

- [ ] **Step 2: Commit the new skill**

```bash
git add packages/skills/using-skillwiki/SKILL.md
git commit -m "feat(plugin): add using-skillwiki onboarding skill"
```

---

### Task 3: Add session-start hook infrastructure

**Files:**
- Create: `packages/skills/hooks/hooks.json`
- Create: `packages/skills/hooks/run-hook.cmd`
- Create: `packages/skills/hooks/session-start`
- Modify: `packages/skills/package.json`

The hook infrastructure follows the superpowers pattern: `hooks.json` registers a `SessionStart` event that calls `run-hook.cmd` (cross-platform polyglot wrapper), which delegates to the `session-start` bash script.

- [ ] **Step 1: Create hooks.json**

Create `packages/skills/hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "async": false
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Create run-hook.cmd (cross-platform polyglot wrapper)**

Create `packages/skills/hooks/run-hook.cmd` — adapted from superpowers v5.0.7. On Windows (cmd.exe), the batch portion finds Git Bash and delegates. On Unix, the shell portion runs the named script directly:

```bash
: << 'CMDBLOCK'
@echo off
REM Cross-platform polyglot wrapper for hook scripts.
REM On Windows: cmd.exe runs the batch portion, which finds and calls bash.
REM On Unix: the shell interprets this as a script (: is a no-op in bash).
REM
REM Hook scripts use extensionless filenames (e.g. "session-start" not
REM "session-start.sh") so Claude Code's Windows auto-detection -- which
REM prepends "bash" to any command containing .sh -- doesn't interfere.

if "%~1"=="" (
    echo run-hook.cmd: missing script name >&2
    exit /b 1
)

set "HOOK_DIR=%~dp0"

REM Try Git for Windows bash in standard locations
if exist "C:\Program Files\Git\bin\bash.exe" (
    "C:\Program Files\Git\bin\bash.exe" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)
if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    "C:\Program Files (x86)\Git\bin\bash.exe" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)

REM Try bash on PATH
where bash >nul 2>nul
if %ERRORLEVEL% equ 0 (
    bash "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)

REM No bash found - exit silently
exit /b 0
CMDBLOCK

# Unix: run the named script directly
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="$1"
shift
exec bash "${SCRIPT_DIR}/${SCRIPT_NAME}" "$@"
```

- [ ] **Step 3: Create session-start bash script**

Create `packages/skills/hooks/session-start`:

```bash
#!/usr/bin/env bash
# SessionStart hook for skillwiki plugin
# Injects using-skillwiki SKILL.md content into every conversation.

set -euo pipefail

# Determine plugin root directory
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Read using-skillwiki content
skill_content=$(cat "${PLUGIN_ROOT}/skills/using-skillwiki/SKILL.md" 2>&1 || echo "Error reading using-skillwiki skill")

# Escape string for JSON embedding using bash parameter substitution.
# Each ${s//old/new} is a single C-level pass.
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

skill_escaped=$(escape_for_json "$skill_content")
session_context="<EXTREMELY_IMPORTANT>\nYou have skillwiki.\n\n**Below is the full content of your 'skillwiki:using-skillwiki' skill - your introduction to the skillwiki skills. For all other skills, use the 'Skill' tool:**\n\n${skill_escaped}\n</EXTREMELY_IMPORTANT>"

# Output context injection as JSON for Claude Code.
# Uses printf instead of heredoc to work around bash 5.3+ heredoc hang.
printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' "$session_context"

exit 0
```

- [ ] **Step 4: Make session-start executable**

```bash
chmod +x packages/skills/hooks/session-start
```

- [ ] **Step 5: Update packages/skills/package.json to include hooks in files array**

Change the `files` array from `["wiki-*", "proj-*", ".claude-plugin", "README.md"]` to `["wiki-*", "proj-*", "using-skillwiki", ".claude-plugin", "hooks", "README.md"]`:

```json
{
  "name": "@skillwiki/skills",
  "version": "0.2.0-beta.4",
  "private": true,
  "files": ["wiki-*", "proj-*", "using-skillwiki", ".claude-plugin", "hooks", "README.md"]
}
```

Note: Also bump the skills package version from `0.1.0` to `0.2.0-beta.4` to stay in sync.

- [ ] **Step 6: Commit hook infrastructure**

```bash
git add packages/skills/hooks/hooks.json packages/skills/hooks/run-hook.cmd packages/skills/hooks/session-start packages/skills/package.json
git commit -m "feat(plugin): add session-start hook for using-skillwiki auto-injection"
```

---

### Task 4: Update CLAUDE.md references

**Files:**
- Modify: `CLAUDE.md`

Update all references from "10" to "11" skills and reflect that marketplace.json no longer has a `skills` field.

- [ ] **Step 1: Update CLAUDE.md**

Apply these changes to `CLAUDE.md`:

1. Line 3: `10 prompt-only SKILL.md files` → `11 prompt-only SKILL.md files`
2. Line 27: Remove the phrase `and enumerates the 10 skill paths explicitly so the existing flat layout works without a \`skills/\` subdirectory` — replace with explanation that plugin.json drives discovery via `"skills": "./"`
3. Line 36: Update the "Changing the layout" note — remove reference to `marketplace.json#plugins[0].skills` since that field no longer exists

The updated CLAUDE.md should read:

```markdown
# CLAUDE.md

This repo ships the `skillwiki` CLI and 11 prompt-only SKILL.md files.

## Working in this repo

- The canonical spec is `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md`. Do not regress N1–N18.
- Skills are prompt-only Markdown — no build step, no LLM calls in the CLI.
- All deterministic logic lives under `packages/cli/src/`.
- Shared types live in `packages/shared/src/` and are imported via `@skillwiki/shared`.
- Tests are co-located with the package they cover; run them with `npm run -w <package> test`.

## Conventions

- Exit codes are stable across the v1 line. New failure classes get unused codes; never reassign existing codes.
- Every CLI subcommand returns a `Result<T>` envelope (`{ ok, data }` or `{ ok: false, error, detail? }`).
- `--human` MUST NOT alter exit codes (N2).
- Files under `raw/` MUST NOT be modified after ingestion (N9).

## Where things live

- Schemas: `packages/shared/src/schemas.ts`.
- Subcommand implementations: `packages/cli/src/commands/<name>.ts`.
- SKILL.md files: `packages/skills/<skill-name>/SKILL.md`.
- Templates: `packages/cli/templates/`.
- Claude plugin manifest: `packages/skills/.claude-plugin/plugin.json`.
- Claude marketplace manifest: `.claude-plugin/marketplace.json` (repo root). Skill discovery is driven by `plugin.json`'s `"skills": "./"` field; `marketplace.json` points the plugin source at `./packages/skills`.

## Distribution channels

The skills ship through two independent channels — keep both working:

1. **Claude Code plugin** — `/plugin marketplace add karlorz/llm-wiki` then `/plugin install skillwiki@llm-wiki`. Discovery is driven by `packages/skills/.claude-plugin/plugin.json` with a SessionStart hook that auto-injects the `using-skillwiki` onboarding skill.
2. **npm CLI installer** — `npx skillwiki install` copies SKILL.md files into `~/.claude/skills/` via the `install` subcommand (see `packages/cli/src/commands/install.ts`).

Changing the layout under `packages/skills/<skill>/` requires updating BOTH `packages/skills/.claude-plugin/plugin.json` AND the `install` subcommand's directory scan.
```

- [ ] **Step 2: Commit CLAUDE.md update**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for 11 skills and plugin-driven discovery"
```

---

### Task 5: Verify all tests pass and run smoke checks

**Files:** None (verification only)

- [ ] **Step 1: Run the full CLI test suite**

```bash
npm run -w @skillwiki/cli test
```

Expected: All existing tests pass. No new tests needed — this change only touches manifests, Markdown, and bash scripts, not TypeScript code.

- [ ] **Step 2: Verify hook script executes correctly**

Run the session-start script directly to verify it produces valid JSON:

```bash
CLAUDE_PLUGIN_ROOT="$(pwd)/packages/skills" bash packages/skills/hooks/session-start
```

Expected: Valid JSON output containing `"hookSpecificOutput"` with `"additionalContext"` that includes the `using-skillwiki` skill content.

- [ ] **Step 3: Verify using-skillwiki is not caught by install filter**

Confirm the `install.ts` filter (`wiki-*` and `proj-*` prefixes) excludes `using-skillwiki`:

```bash
ls -d packages/skills/wiki-* packages/skills/proj-* | wc -l
```

Expected: 10 (the original 10 skills, not including `using-skillwiki`).
