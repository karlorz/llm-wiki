# Plugin Intro & Housekeeping Design

Date: 2026-05-04

## Problem

Three issues discovered via Claude Code's `/plugin` screen:

1. **Version mismatch** — `plugin.json` and `marketplace.json` report `0.1.0` while the CLI is at `0.2.0-beta.4`.
2. **Duplicate skills** — all 10 skills appear twice because both `marketplace.json` and `plugin.json` independently declare `"skills": "./"`, causing double-scanning.
3. **No onboarding** — unlike superpowers (which injects `using-superpowers` via a `SessionStart` hook), skillwiki has no intro skill. Users see 10 skills with no guidance.

## Design

### Fix 1: Version sync

Bump `"version"` in both manifest files to match the CLI's `package.json` version (`0.2.0-beta.4`).

Files:
- `packages/skills/.claude-plugin/plugin.json` — `"version": "0.2.0-beta.4"`
- `.claude-plugin/marketplace.json` — `metadata.version` and `plugins[0].version` → `"0.2.0-beta.4"`

### Fix 2: Deduplicate skills

Remove `"skills": "./"` from `marketplace.json`. Keep it only in `plugin.json`.

With `strict: true`, `plugin.json` is the runtime authority for skill discovery. The marketplace entry's `skills` field was a second scan path that found the same 10 skills independently.

File: `.claude-plugin/marketplace.json` — remove `plugins[0].skills` field.

### Fix 3: Add `using-skillwiki` onboarding skill

Create `packages/skills/using-skillwiki/SKILL.md` — the 11th skill.

**Purpose:** An informational map that orients Claude (and the user) to the wiki-*/proj-* skill family, when to use each, and the typical workflow order.

**Skill type:** Flexible — informational guidance, not a rigid gate. Unlike `using-superpowers` which enforces behavior, `using-skillwiki` is a reference map.

**Content structure:**
1. When to activate (session start, or when user mentions wiki/knowledge-base/vault/ingest/research)
2. Skill map table (10 skills with one-line triggers)
3. CLI backbone note (skillwiki CLI, deterministic, no LLM calls)
4. Typical workflow progression (init → ingest → query → lint → crystallize → audit)
5. Project skills section (proj-* for longer-running work)

**Frontmatter description** (triggers Claude to invoke the skill):
```
description: Invoke at session start or when knowledge-base tasks arise — maps all 10 wiki-*/proj-* skills and teaches the skillwiki CLI workflow
```

**Must also update:**
- `packages/cli/src/commands/install.ts` — the directory filter already matches `wiki-*` and `proj-*`; `using-skillwiki` won't be auto-installed by the CLI (it's a plugin-only skill, not needed for npm-based installs since plugins handle discovery). No change needed.
- `CLAUDE.md` — update "10 prompt-only skills" references to "11 prompt-only skills".

### Fix 4: Add session-start hook

Add a `SessionStart` hook that injects `using-skillwiki/SKILL.md` content into every conversation, following the superpowers pattern.

**Files to create:**

1. `packages/skills/hooks/hooks.json` — registers the SessionStart hook
2. `packages/skills/hooks/session-start` — bash script that reads the SKILL.md and emits JSON

**hooks.json:**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/session-start\"",
            "async": false
          }
        ]
      }
    ]
  }
}
```

**session-start script:**
- Determine plugin root via `$CLAUDE_PLUGIN_ROOT` (set by Claude Code at runtime)
- Read `skills/using-skillwiki/SKILL.md` from plugin root
- JSON-escape the content using bash parameter substitution (no jq dependency)
- Emit Claude Code format: `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }`
- Exit 0

The script is ~40 lines of bash. No Windows cross-platform polyglot wrapper needed (skillwiki targets macOS/Linux only).

**No `run-hook.cmd` wrapper** — superpowers uses this for Windows support. skillwiki doesn't need it, keeping the hook simpler.

**Must also update:**
- `packages/skills/package.json` — add `"hooks"` to the `files` array so hooks are included in the plugin package

## What this does NOT change

- No changes to CLI subcommands (config, doctor, etc.)
- No changes to existing 10 skills' SKILL.md content
- No changes to `install` command behavior (CLI installs remain skillwiki-specific, not plugin-specific)
- No changes to the `skills` field in `plugin.json` (stays `"./"`)
- No new npm dependencies

## Files changed

| File | Change |
|------|--------|
| `packages/skills/.claude-plugin/plugin.json` | Bump version to `0.2.0-beta.4` |
| `.claude-plugin/marketplace.json` | Bump version, remove `skills` field from plugin entry |
| `packages/skills/using-skillwiki/SKILL.md` | New — onboarding skill content |
| `packages/skills/hooks/hooks.json` | New — SessionStart hook registration |
| `packages/skills/hooks/session-start` | New — bash hook script |
| `packages/skills/package.json` | Add `hooks` to `files` array |
| `CLAUDE.md` | Update "10" → "11" skills count |

## Verification

1. `npm run -w @skillwiki/cli test` — all existing tests pass
2. Local plugin reinstall — verify single copy of each skill (no duplicates)
3. `/plugin` screen shows `using-skillwiki` in the skill list
4. New session — `using-skillwiki` content appears in system context
5. Skill invocable via `Skill` tool — returns full content
