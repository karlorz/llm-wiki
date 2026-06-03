---
version: 0.2.1
name: wiki-gate-plan-mode
description: Toggle EnterPlanMode gating — force superpowers planning skills instead of built-in plan mode
---

# wiki-gate-plan-mode

Gate the agent away from Claude Code's built-in `EnterPlanMode` tool, forcing
all planning through `superpowers:brainstorming` → `superpowers:writing-plans`
(or a configurable pipeline). Uses `permissions.deny` for two-layer enforcement:
the tool is removed from the model's context before it ever sees it.

## When This Skill Activates

- User says "gate plan mode", "disable EnterPlanMode", "force superpowers planning"
- User asks to toggle, check, or configure plan-mode gating
- User wants to enforce structured planning workflows in a project

## Pre-orientation reads

None for the first run.

## Steps

0. **Parse arguments.** Accept one of:
   - `on` — enable gating (add EnterPlanMode to deny)
   - `off` — disable gating (remove EnterPlanMode from deny)
   - `status` (default if no argument) — report current state

1. **Locate settings file.** Check in this order:
   - `~/.claude/settings.json` (user-level, global — primary target for plan-mode gating)
   - `.claude/settings.json` (project-level, checked into repo — use if user specifies project scope)
   If the target file does not exist, create it with `{ "permissions": { "deny": [] } }`.

2. **Read current state.** Parse the settings JSON. Check whether `"EnterPlanMode"` is present in `permissions.deny[]`.

3. **Apply the requested action:**

   **`on`:**
   - If `"EnterPlanMode"` is already in `permissions.deny`, report "already gated" and stop.
   - Otherwise, add `"EnterPlanMode"` to `permissions.deny[]`. Create the array if absent.
   - Write the updated JSON back, preserving formatting.
   - Report: "EnterPlanMode gated — agent will use superpowers planning skills."

   **`off`:**
   - If `"EnterPlanMode"` is not in `permissions.deny`, report "already ungated" and stop.
   - Otherwise, remove `"EnterPlanMode"` from `permissions.deny[]`. If the array is now empty, remove the `deny` key.
   - Write the updated JSON back.
   - Report: "EnterPlanMode ungated — built-in plan mode is available."

   **`status`:**
   - Check both `~/.claude/settings.json` and `.claude/settings.json`.
   - Report whether EnterPlanMode is currently gated or ungated.
   - If gated, list which settings file contains the deny entry.

4. **Suggest CLAUDE.md directive (on action only).** After enabling gating, check whether the project's `CLAUDE.md` contains a planning directive (search for "EnterPlanMode" or "superpowers:brainstorming"). If not found, suggest adding:

   ```
   ## Planning

   Use superpowers:brainstorming → superpowers:writing-plans for all planning. EnterPlanMode is disabled.
   ```

   Do NOT edit CLAUDE.md automatically — only suggest.

## Schema Warning

The JSON Schema Store's `claude-code-settings.json` schema has a closed regex for `permissions.deny` that includes `ExitPlanMode` but **omits `EnterPlanMode`**. IDEs (VS Code, JetBrains) will show a validation warning. This is a schema staleness issue, not a runtime issue — Claude Code's runtime accepts `EnterPlanMode` in `permissions.deny` and enforces it correctly. See `[[queries/claude-code-plan-mode-schema-validation]]` for full analysis.

## Stop conditions

- No project directory found (not inside a git repo or project).
- Settings file exists but is not valid JSON and cannot be parsed.

## Forbidden

- Do not add any tool other than `EnterPlanMode` to the deny list.
- Do not modify CLAUDE.md automatically — only suggest changes.
- Do not remove other entries from `permissions.deny` when toggling off — only remove `EnterPlanMode`.
