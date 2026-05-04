# Hermes Compatibility Fixes — Design Specification

**Date**: 2026-05-04
**Status**: Approved for plan generation
**Supersedes**: nothing (additive bug fixes to existing hermes-parity implementation)
**Repo**: `/Users/karlchow/Desktop/code/llm-wiki`

## TL;DR

Fix 7 concrete bugs and gaps in the skillwiki CLI that cause poor compatibility when running against existing hermes-format wikis. All fixes are targeted in-place — no new commands, no architecture changes. After these fixes, running `skillwiki init --force` on an existing hermes vault migrates the SCHEMA.md format, auto-discovers missing taxonomy tags from pages, and preserves existing content — reducing lint errors from 374 to near zero without manual editing.

## Context

The sg01 `~/wiki` vault has 106 pages created by hermes. It uses an old-format SCHEMA.md with 30-tag taxonomy, but pages use 50+ unique tags. Running `skillwiki lint` produces 374 errors. The CLI should help bridge this gap instead of requiring manual editing.

## Approach

Targeted fixes in-place (Approach A). Each fix is scoped to the file where the bug lives. No new commands, no new files beyond tests.

## Design

### Fix 1: init.ts uses writeDotenv() helper

**File**: `packages/cli/src/commands/init.ts` (lines 120-126)
**Bug**: init writes `~/.skillwiki/.env` as a bare string, destroying comments and extra keys.
**Fix**: Replace the bare `writeFileSync` call with the existing `writeDotenv()` helper from `utils/dotenv.ts`, which has `updateLines()` that preserves comments and non-whitelisted keys.

### Fix 2: init --force preserves existing index.md and log.md

**File**: `packages/cli/src/commands/init.ts` (lines 99-118)
**Bug**: When init runs with `--force`, it overwrites `index.md` and `log.md`, destroying curated index entries and log history.
**Fix**: Before writing each file, check if it exists and has >10 lines. If so, skip the write. Add a `preserved: string[]` field to the JSON output listing which files were kept.

### Fix 3: SCHEMA.md migration on --force

**File**: `packages/cli/src/commands/init.ts` (lines 87-97)
**Bug**: init overwrites SCHEMA.md entirely with the template, losing domain descriptions and taxonomy from hermes-format schemas.
**Fix**: When init finds an existing SCHEMA.md with `--force`:
1. Parse old domain description (text under `## Domain`)
2. Parse old taxonomy via `extractTaxonomy()`
3. Use the `--domain` flag if provided; otherwise use the old domain from the existing SCHEMA.md
4. Merge old taxonomy tags into the new template's taxonomy section
5. If old SCHEMA.md has no fenced YAML taxonomy (plain hermes format), fall through to auto-discovery (Fix 7)

### Fix 4: extractTaxonomy returns error on missing block

**File**: `packages/cli/src/parsers/taxonomy.ts` (lines 7-8)
**Bug**: When no fenced YAML block is found, `extractTaxonomy` returns `ok([])`, causing tag-audit to flag every tag on every page as a violation.
**Fix**: Return `err({ message: "No fenced YAML taxonomy block found in SCHEMA.md" })` instead. tag-audit already propagates errors — this surfaces as a clear diagnostic instead of hundreds of spurious violations.

### Fix 5: Case-insensitive wikilink matching

**File**: `packages/cli/src/commands/links.ts` (lines 15, 28), `packages/cli/src/commands/index-check.ts` (lines 20, 28-29)
**Bug**: Wikilink resolution is case-sensitive — `[[C929]]` won't match `c929.md`.
**Fix**: Build slug Sets with `.toLowerCase()` on each entry. In the lookup, also `.toLowerCase()` the wikilink target before `.has()`. Page filenames stay as-is — only the comparison is case-insensitive.

### Fix 6: Env safety guard

**File**: `packages/cli/src/commands/init.ts` (lines 120-126)
**Bug**: init always writes `~/.skillwiki/.env`, even when `--target` points to `/tmp` or a throwaway directory. A test init overwrote production config.
**Fix**:
- Skip env write if the resolved target starts with `/tmp`, `/var`, or `/private`
- Add `--no-env` flag to init to explicitly skip env write (for test/dry-run scenarios)
- Add `env_skipped: true` to JSON output when write is skipped

### Fix 7: Taxonomy auto-discovery from existing pages

**File**: `packages/cli/src/commands/init.ts` (new step after template render)
**Gap**: When migrating a hermes vault, the taxonomy in SCHEMA.md is minimal but pages use many more tags. The CLI should discover and merge these.
**Fix**: After rendering the SCHEMA.md template:
1. Scan all typed-knowledge pages (`entities/`, `concepts/`, `comparisons/`, `queries/`) in the target vault
2. Extract all tags from frontmatter
3. Compute: `discovered = tags_from_pages - tags_in_taxonomy`
4. If `discovered` is non-empty, append them to the taxonomy YAML under a `# --- Discovered from existing pages ---` comment
5. Add `discovered_tags: number` to the init JSON output

## Scope

### In this round
- All 7 fixes described above
- Vitest coverage for each fix
- Existing tests must continue to pass

### Out of scope
- Any change to SKILL.md prompts
- New CLI subcommands
- New exit codes
- Changes to `audit`, `validate`, `hash`, `fetch-guard`, `graph`, `overlap`, `install`

## Impact on sg01 wiki

After deploying these fixes and running `skillwiki init --force` on sg01:
- SCHEMA.md migrates from hermes format to skillwiki format (domain preserved, taxonomy expanded)
- 20+ missing tags auto-discovered and merged into taxonomy
- index.md and log.md preserved
- `skillwiki lint` errors drop from 374 to ~2 (the 2 oversized-page warnings)

## Testing strategy

Each fix gets its own test:
1. **Fix 1**: Init writes env via writeDotenv — verify existing comments preserved
2. **Fix 2**: Init --force with 20-line index.md — verify not overwritten; with empty index.md — verify overwritten
3. **Fix 3**: Init --force against hermes SCHEMA.md — verify domain migrated, taxonomy merged
4. **Fix 4**: tag-audit with SCHEMA.md missing taxonomy block — verify error returned
5. **Fix 5**: links check with [[C929]] and c929.md — verify resolved; index-check same
6. **Fix 6**: Init --target /tmp/foo — verify env not written; init --no-env — verify env not written
7. **Fix 7**: Init --force against vault with pages using tags not in taxonomy — verify discovered_tags in output and taxonomy expanded
