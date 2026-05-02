# LLM Wiki Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-skill Claude Code plugin that produces Hermes-compatible wiki vaults using Karpathy's LLM Wiki pattern.

**Architecture:** 6 skill files (init, ingest, query, lint, crystallize, audit) based on kfchou/wiki-skills, adapted to produce Hermes wire-compatible output (typed subdirs, full frontmatter, sha256 raw sources, provenance markers). Two helper scripts enforce security and hash contracts. Single install.sh for Claude Code.

**Tech Stack:** Bash (scripts), Markdown (skills), Claude Code Skill system

---

## File Structure

| File | Responsibility |
|------|---------------|
| `skills/wiki-init/SKILL.md` | Bootstrap a new Hermes-compatible wiki vault |
| `skills/wiki-ingest/SKILL.md` | URL/file/paste → raw capture → wiki pages with staged batch writes |
| `skills/wiki-query/SKILL.md` | Question → 4-tier search (index → grep → raw → external) → synthesis |
| `skills/wiki-lint/SKILL.md` | Health check with sha256 drift detection, orphans, broken links |
| `skills/wiki-crystallize/SKILL.md` | Session → wiki page distillation with Pending Review sections |
| `skills/wiki-audit/SKILL.md` | Per-page citation verification against raw sources |
| `scripts/wiki-hash.sh` | Canonical sha256 computation (body-only, no frontmatter) |
| `scripts/wiki-fetch-guard.sh` | Security wrapper: IP blocklist, scheme allowlist, API key stripping |
| `templates/SCHEMA.md` | Hermes-compatible schema template with tag taxonomy |
| `templates/index.md` | Sectioned content catalog template |
| `templates/log.md` | Append-only log template |
| `install.sh` | Claude Code skill installer with preflight, backup, manifest |
| `CLAUDE.md` | Repo instructions for Claude Code agents |
| `README.md` | Usage documentation |

---

### Task 1: Initialize Repo Structure

**Files:**
- Create: `LICENSE`
- Create: `.gitignore`

- [ ] **Step 1: Initialize git repo**

```bash
cd /Users/karlchow/Desktop/code/llm-wiki
git init
```

- [ ] **Step 2: Create LICENSE**

```bash
cat > LICENSE << 'EOF'
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF
```

- [ ] **Step 3: Create .gitignore**

```bash
cat > .gitignore << 'EOF'
.DS_Store
*.swp
*.swo
*~
wiki/
.wiki-manifest.json
EOF
```

- [ ] **Step 4: Create directory structure**

```bash
mkdir -p skills/wiki-init skills/wiki-ingest skills/wiki-query skills/wiki-lint skills/wiki-crystallize skills/wiki-audit scripts templates
```

- [ ] **Step 5: Commit**

```bash
git add LICENSE .gitignore skills/ scripts/ templates/
git commit -m "chore: initialize repo structure with license and directories"
```

---

### Task 2: Helper Scripts

**Files:**
- Create: `scripts/wiki-hash.sh`
- Create: `scripts/wiki-fetch-guard.sh`

- [ ] **Step 1: Write wiki-hash.sh**

Canonical sha256 contract: hashes file content AFTER the closing `---` of YAML frontmatter. If no frontmatter, hashes entire file.

```bash
#!/usr/bin/env bash
# wiki-hash.sh — Canonical sha256 for wiki raw source files
# Contract: sha256 of body content only (everything after the closing --- of frontmatter)
# Usage: wiki-hash.sh <file>
# Exit 0 + prints hash on success, exit 1 on error
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: wiki-hash.sh <file>" >&2
  exit 1
fi

file="$1"

if [[ ! -f "$file" ]]; then
  echo "Error: file not found: $file" >&2
  exit 1
fi

# Check if file starts with YAML frontmatter (---)
first_line=$(head -n 1 "$file")

if [[ "$first_line" == "---" ]]; then
  # Find the closing --- (second occurrence at start of line)
  # Skip the opening --- line, then find the next --- at start of line
  body=$(tail -n +2 "$file" | awk 'BEGIN{n=0} /^---[[:space:]]*$/{n++; if(n>=1) {found=NR; exit}} END{if(found) print found}')
  if [[ -n "$body" ]]; then
    # $body is the line number of the closing --- (after skipping first line)
    # Content starts at line body+2 (skip opening + closing ---)
    tail -n +"$((body + 2))" "$file" | sha256sum | awk '{print $1}'
  else
    # No closing --- found, hash entire file
    sha256sum "$file" | awk '{print $1}'
  fi
else
  # No frontmatter, hash entire file
  sha256sum "$file" | awk '{print $1}'
fi
```

- [ ] **Step 2: Make wiki-hash.sh executable**

```bash
chmod +x scripts/wiki-hash.sh
```

- [ ] **Step 3: Test wiki-hash.sh**

```bash
# Create test file with frontmatter
mkdir -p /tmp/wiki-hash-test
cat > /tmp/wiki-hash-test/test.md << 'TESTEOF'
---
source_url: https://example.com
ingested: 2026-05-02
sha256: placeholder
---
This is the body content that should be hashed.
Line two of body.
TESTEOF

# Run the hash script
HASH=$(scripts/wiki-hash.sh /tmp/wiki-hash-test/test.md)
echo "Hash: $HASH"

# Verify it's a valid sha256 (64 hex chars)
if [[ ${#HASH} -eq 64 ]]; then
  echo "PASS: Valid sha256 hash"
else
  echo "FAIL: Hash length is ${#HASH}, expected 64"
  exit 1
fi

# Verify determinism (same file = same hash)
HASH2=$(scripts/wiki-hash.sh /tmp/wiki-hash-test/test.md)
if [[ "$HASH" == "$HASH2" ]]; then
  echo "PASS: Deterministic"
else
  echo "FAIL: Different hashes for same file"
  exit 1
fi

# Verify body-only (changing frontmatter doesn't change hash)
sed -i '' 's/sha256: placeholder/sha256: changed/' /tmp/wiki-hash-test/test.md
HASH3=$(scripts/wiki-hash.sh /tmp/wiki-hash-test/test.md)
if [[ "$HASH" == "$HASH3" ]]; then
  echo "PASS: Frontmatter change doesn't affect hash"
else
  echo "FAIL: Hash changed when frontmatter changed"
  exit 1
fi

rm -rf /tmp/wiki-hash-test
```

Expected output: All 3 PASS lines.

- [ ] **Step 4: Write wiki-fetch-guard.sh**

Security wrapper for URL ingestion. Checks scheme, private IPs, API keys in URLs.

```bash
#!/usr/bin/env bash
# wiki-fetch-guard.sh — Security wrapper for URL fetching in wiki ingest
# Checks: scheme allowlist, private IP blocklist, API key stripping
# Usage: wiki-fetch-guard.sh <url>
# Exit 0 = safe to fetch, prints cleaned URL. Exit 1 = blocked.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: wiki-fetch-guard.sh <url>" >&2
  exit 1
fi

url="$1"

# 1. Scheme allowlist: only https
scheme=$(echo "$url" | grep -oE '^[a-zA-Z]+://' | tr -d '://' || true)
if [[ "$scheme" != "https" ]]; then
  echo "BLOCKED: Only https URLs allowed. Got scheme: ${scheme:-none}" >&2
  exit 1
fi

# 2. Extract hostname
hostname=$(echo "$url" | sed -E 's|^https://([^/:]+).*|\1|')

# 3. Private/metadata IP blocklist
# Check if hostname is an IP address
if echo "$hostname" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  # IPv4 private ranges
  if echo "$hostname" | grep -qE '^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)'; then
    echo "BLOCKED: Private/metadata IP address: $hostname" >&2
    exit 1
  fi
fi

# 4. IPv6 loopback
if [[ "$hostname" == "::1" ]] || [[ "$hostname" == "[::1]" ]]; then
  echo "BLOCKED: IPv6 loopback" >&2
  exit 1
fi

# 5. Strip embedded API keys from query params
# Patterns: ?key=..., &token=..., &api_key=..., #access_token=...
cleaned_url=$(echo "$url" | sed -E \
  -e 's/([?&])(key|token|api_key|access_token|secret|password)=[^&#]*/\1[REDACTED]/gi' \
  -e 's/#(access_token|token)=[^&#]*//gi')

# 6. Check for common localhost aliases
if echo "$hostname" | grep -qE '^(localhost|0\.0\.0\.0)$'; then
  echo "BLOCKED: Localhost/0.0.0.0 not allowed" >&2
  exit 1
fi

echo "$cleaned_url"
exit 0
```

- [ ] **Step 5: Make wiki-fetch-guard.sh executable**

```bash
chmod +x scripts/wiki-fetch-guard.sh
```

- [ ] **Step 6: Test wiki-fetch-guard.sh**

```bash
# Test: HTTPS passes
RESULT=$(scripts/wiki-fetch-guard.sh "https://example.com/article" 2>/dev/null)
if [[ $? -eq 0 ]]; then echo "PASS: https allowed"; else echo "FAIL: https blocked"; exit 1; fi

# Test: HTTP blocked
if scripts/wiki-fetch-guard.sh "http://example.com" 2>/dev/null; then
  echo "FAIL: http should be blocked"
  exit 1
else
  echo "PASS: http blocked"
fi

# Test: Private IP blocked
if scripts/wiki-fetch-guard.sh "https://192.168.1.1/admin" 2>/dev/null; then
  echo "FAIL: private IP should be blocked"
  exit 1
else
  echo "PASS: private IP blocked"
fi

# Test: API key stripping
RESULT=$(scripts/wiki-fetch-guard.sh "https://example.com/api?key=secret123&other=ok" 2>/dev/null)
if echo "$RESULT" | grep -q "REDACTED"; then
  echo "PASS: API key stripped"
else
  echo "FAIL: API key not stripped: $RESULT"
  exit 1
fi

# Test: Localhost blocked
if scripts/wiki-fetch-guard.sh "https://localhost:3000/api" 2>/dev/null; then
  echo "FAIL: localhost should be blocked"
  exit 1
else
  echo "PASS: localhost blocked"
fi

echo "All fetch-guard tests passed"
```

- [ ] **Step 7: Commit**

```bash
git add scripts/wiki-hash.sh scripts/wiki-fetch-guard.sh
git commit -m "feat: add wiki-hash.sh and wiki-fetch-guard.sh helper scripts"
```

---

### Task 3: Templates

**Files:**
- Create: `templates/SCHEMA.md`
- Create: `templates/index.md`
- Create: `templates/log.md`

- [ ] **Step 1: Write templates/SCHEMA.md**

```bash
cat > templates/SCHEMA.md << 'EOF'
# Wiki Schema

## Identity
- **Path:** <absolute path to wiki root>
- **Domain:** <what this wiki covers — e.g., "AI/ML research", "personal health", "startup intelligence">
- **Source types:** <papers, URLs, code files, transcripts, etc.>
- **Created:** <YYYY-MM-DD>

## Page Frontmatter
Every wiki page must start with:
```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [from taxonomy below]
sources: [raw/articles/source-name.md]
# Optional quality signals:
confidence: high | medium | low
contested: true
contradictions: [other-page-slug]
---
```

`confidence` and `contested` are recommended for opinion-heavy or fast-moving topics. Lint surfaces `contested: true` and `confidence: low` pages for review.

## Directory Layout
```
<wiki-root>/
├── SCHEMA.md
├── index.md
├── log.md
├── raw/
│   ├── articles/
│   ├── papers/
│   ├── transcripts/
│   └── assets/
├── entities/
├── concepts/
├── comparisons/
└── queries/
```

## Cross-References
Use `[[wikilinks]]` where the target is the filename without `.md`.
Example: `[[transformer-architecture]]` → `entities/transformer-architecture.md` or `concepts/transformer-architecture.md`
Minimum 2 outbound `[[wikilinks]]` per page.

## Citations
Cite every non-common-knowledge factual claim. Granularity is paragraph or claim, never per-sentence.
Format: Markdown footnotes. Two citation kinds, three valid targets.

**Quote citation** (preferred):
```
The model uses 8 attention heads.[^1]
[^1]: [[attention-is-all-you-need]] §3.2.2 — "We employ h = 8 parallel attention layers"
```

**Synthesis citation** (when no single quote captures the claim):
```
The architecture is fundamentally an encoder-decoder with attention.[^2]
[^2]: [[attention-is-all-you-need]] §3.2-3.4 [synthesis] — encoder, decoder, and attention sections together describe the full multi-head architecture
```

Three rules for every footnote:
1. Target is one of: `[[source-slug]]` (a source wiki page), `raw/<path>` or `assets/<path>` (local file), or `<url>`. Never cite entity, concept, or query pages — those are syntheses, not sources.
2. A locator is present: `§<section>`, `p.<page>`, `[HH:MM:SS]`, URL anchor, or `(YYYY-MM-DD)`.
3. Either a verbatim quote, or the `[synthesis]` tag plus a description.

## Provenance Markers
On pages that synthesize 3+ sources, append `^[raw/articles/source.md]` at the end of paragraphs whose claims come from a specific source. This lets a reader trace each claim back without re-reading the whole raw file.

## Page Thresholds
- **Create a page** when an entity/concept appears in 2+ sources OR is central to one source
- **Add to existing page** when a source mentions something already covered
- **DON'T create a page** for passing mentions, minor details, or things outside the domain
- **Split a page** when it exceeds ~200 lines
- **Archive a page** when fully superseded — move to `_archive/`, remove from index

## Tag Taxonomy
[Define 10-20 top-level tags for the domain. Add new tags here BEFORE using them.]
Example for AI/ML:
- Models: model, architecture, benchmark, training
- People/Orgs: person, company, lab, open-source
- Techniques: optimization, fine-tuning, inference, alignment, data
- Meta: comparison, timeline, controversy, prediction

Rule: every tag on a page must appear in this taxonomy. If a new tag is needed, add it here first.

## Update Policy
When new information conflicts with existing content:
1. Check dates — newer sources generally supersede older ones
2. If genuinely contradictory, note both positions with dates and sources
3. Mark in frontmatter: `contradictions: [page-name]`
4. Flag for user review in the lint report

## Log Entry Format
```
## [YYYY-MM-DD] <operation> | <title>
```
Operations: init, ingest, update, query, lint, audit, crystallize, archive, create

## Conventions
- `raw/` is immutable — skills never modify it
- `log.md` is append-only — never rewritten, only appended
- `index.md` is updated on every operation that adds or changes pages
- All pages use lowercase-hyphen naming (e.g., `transformer-architecture.md`)
- `overview.md` reflects the current synthesis across all sources (optional, not required)
EOF
```

- [ ] **Step 2: Write templates/index.md**

```bash
cat > templates/index.md << 'EOF'
# Wiki Index

> Content catalog. Every wiki page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: <date> | Total pages: 0

## Entities
<!-- Alphabetical within section — entries added by wiki-ingest -->

## Concepts

## Comparisons

## Queries
```

- [ ] **Step 3: Write templates/log.md**

```bash
cat > templates/log.md << 'EOF'
# Wiki Log

> Chronological record of all wiki actions. Append-only.
> Format: `## [YYYY-MM-DD] action | subject`
> Actions: init, ingest, update, query, lint, audit, crystallize, create, archive
> When this file exceeds 500 entries, rotate: rename to log-YYYY.md, start fresh.
EOF
```

- [ ] **Step 4: Commit**

```bash
git add templates/
git commit -m "feat: add Hermes-compatible SCHEMA.md, index.md, log.md templates"
```

---

### Task 4: wiki-init Skill

**Files:**
- Create: `skills/wiki-init/SKILL.md`

Source: kfchou/wiki-init adapted for Hermes directory layout (typed subdirs instead of flat `wiki/pages/`).

- [ ] **Step 1: Write skills/wiki-init/SKILL.md**

```markdown
---
name: wiki-init
description: Use when bootstrapping a new wiki vault for any knowledge domain. Creates Hermes-compatible directory structure with SCHEMA.md, typed subdirs, and templates.
---

# Wiki Init

Bootstrap a new Hermes-compatible wiki vault.

## Pre-flight

Check whether a `SCHEMA.md` already exists nearby. If yes, ask the user if they want to reinitialize or continue with the existing wiki.

## Process

### 1. Gather configuration (one question at a time)

Ask:
1. **Where should the wiki live?** (absolute path, e.g. `~/wiki`)
2. **What is the domain/purpose?** (one sentence)
3. **What types of sources will you add?** (papers, URLs, code files, transcripts, etc.)
4. **What tag taxonomy should we use?** (suggest 10-20 tags based on domain)

### 2. Create directory structure

```
<wiki-root>/
├── SCHEMA.md
├── index.md
├── log.md
├── raw/
│   ├── articles/
│   ├── papers/
│   ├── transcripts/
│   └── assets/
├── entities/
├── concepts/
├── comparisons/
└── queries/
```

Use `mkdir -p` for each directory.

### 3. Write SCHEMA.md

Copy the template from this skill's `templates/SCHEMA.md` and customize:
- Fill in the Identity section (path, domain, source types, created date)
- Set the Tag Taxonomy based on the user's domain
- Keep all conventions as-is (they're the Hermes contract)

### 4. Write index.md

```markdown
# Wiki Index — <domain>

> Content catalog. Every wiki page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: <today> | Total pages: 0

## Entities

## Concepts

## Comparisons

## Queries
```

### 5. Write log.md

```markdown
# Wiki Log

> Chronological record of all wiki actions. Append-only.
> Format: `## [YYYY-MM-DD] action | subject`
> When this file exceeds 500 entries, rotate: rename to log-YYYY.md, start fresh.

## [<today>] init | <domain>
- Domain: <domain>
- Structure created with SCHEMA.md, index.md, log.md
- Directories: raw/, entities/, concepts/, comparisons/, queries/
```

### 6. Confirm

Tell the user:
- Wiki initialized at `<path>`
- Add sources to `raw/` manually, or run `wiki-ingest` directly with a URL or file path
- Run `wiki-lint` periodically to keep the wiki healthy
- `SCHEMA.md` is how all other skills locate this wiki — do not move or delete it
- The wiki is Obsidian-compatible: open `<path>` as an Obsidian vault for graph view and wikilinks

### 7. Append to log.md

The initial log entry was already written in step 5. No additional append needed.
```

- [ ] **Step 2: Commit**

```bash
git add skills/wiki-init/
git commit -m "feat: add wiki-init skill (Hermes-compatible vault bootstrap)"
```

---

### Task 5: wiki-ingest Skill

**Files:**
- Create: `skills/wiki-ingest/SKILL.md`

Source: kfchou/wiki-ingest adapted for Hermes typed subdirs, sha256 raw sources, staged batch writes, fetch-guard integration, confidence scoring, provenance markers.

- [ ] **Step 1: Write skills/wiki-ingest/SKILL.md**

```markdown
---
name: wiki-ingest
description: Use when adding a new source to a wiki — a paper, article, URL, file, transcript, or any document. One ingest may touch 10-15 wiki pages.
---

# Wiki Ingest

Add a source to the wiki. Capture the raw source with sha256, discuss takeaways, write wiki pages, and maintain index/log.

## Pre-condition

Find `SCHEMA.md` (search from cwd upward, or in common wiki locations like `~/wiki/`). If not found, tell the user to run `wiki-init` first.
Read `SCHEMA.md` to learn: wiki root path, page frontmatter format, tag taxonomy, citation convention, log entry format.
Then read `index.md` and the last 20 lines of `log.md` to orient.

## Process

### 1. Accept the source

The source can be:
- **File path** — read it directly; copy to appropriate `raw/` subdir if not already there
- **URL** — run security check: `scripts/wiki-fetch-guard.sh "<url>"`. If it fails, tell the user why. If it passes, use `web_fetch` or `WebFetch` to get markdown, save to `raw/articles/`
- **Pasted text** — save to appropriate `raw/` subdir

### 2. Capture the raw source

Save the source to the appropriate `raw/` subdirectory:
- Web articles → `raw/articles/<descriptive-slug>.md`
- PDFs/papers → `raw/papers/<descriptive-slug>.md`
- Meeting notes/transcripts → `raw/transcripts/<descriptive-slug>.md`

Add raw frontmatter to every captured source:
```yaml
---
source_url: <url or "local">
ingested: <YYYY-MM-DD>
sha256: <compute using scripts/wiki-hash.sh on the file AFTER adding this frontmatter>
---
```

**On re-ingest of the same URL:** recompute sha256, compare to stored value. If identical, skip. If different, flag drift and update.

### 3. Read the source in full

Read all content. For long sources, read in sections. Do not skip.

### 4. Surface takeaways — BEFORE writing anything

Tell the user:
- 3-5 bullet points of key takeaways
- What entities/concepts this introduces or updates
- Whether it contradicts anything already in the wiki (check index.md and relevant pages)

Ask: **"Anything specific you want me to emphasize or de-emphasize?"**
Wait for the user's response before proceeding.

### 5. Check existing pages

Read `index.md` and use `Grep` to find existing pages for the entities/concepts mentioned in this source. This prevents duplicates.

### 6. Staged batch write — collect all page operations

Before writing anything, plan the full set of changes:
- Which new pages to create (with their `type:` — entity, concept, comparison, query, summary)
- Which existing pages to update
- What index.md and log.md changes are needed

**New page structure** (Hermes-compatible):
```
entities/<slug>.md    — for people, orgs, products, models
concepts/<slug>.md    — for topics, techniques, ideas
comparisons/<slug>.md — for side-by-side analyses
queries/<slug>.md     — for filed query results
```

**Page template:**
```yaml
---
title: <Page Title>
created: <today>
updated: <today>
type: entity | concept | comparison | query | summary
tags: [from SCHEMA.md taxonomy]
sources: [<raw-path-or-source-slug>]
confidence: medium
---
```

Set `confidence: low` for single-source pages. Set `confidence: high` only when the claim is well-supported across multiple sources.

For single-source pages with `confidence: low`, add a `## Pending Review` section:
```markdown
## Pending Review
- This page relies on a single source. Find corroborating evidence or note the limitation.
```

### 7. Write the source summary page

Create a summary page (type: `summary`) in the appropriate typed subdir. Use lowercase-hyphen slugs.

```yaml
---
title: <Title>
created: <today>
updated: <today>
type: summary
tags: [from taxonomy]
sources: [<raw/articles/slug.md>]
confidence: <based on source count>
---
```

Include:
- **Source:** `<url or file path>`
- **Summary:** 2-3 paragraph synthesis in your own words
- **Key Takeaways:** bullet points
- **Entities & Concepts:** list with `[[wikilinks]]` to their pages
- **Relation to Other Wiki Pages:** how this connects

### 8. Cite as you write

While drafting, every non-common-knowledge factual claim must carry a footnote per the Citations section in `SCHEMA.md`. Two kinds:
- Quote: `[^N]: [[<source-slug>]] <locator> — "<quote>"`
- Synthesis: `[^N]: [[<source-slug>]] <locator> [synthesis] — <description>`

If you cannot produce a citation, find one, weaken the claim, or drop it.

### 9. Update entity and concept pages

For each entity/concept touched by this source:
- **Page exists:** Read it, update relevant section, add this source to `sources:` frontmatter, bump `updated` date
- **Page doesn't exist:** Create it in the appropriate typed subdir with frontmatter

### 10. Cross-reference audit — do not skip

Scan existing pages for entities/concepts this source introduces. Add `[[new-slug]]` references where appropriate. Every new or updated page must have at least 2 outbound `[[wikilinks]]`.

On pages that synthesize 3+ sources, add provenance markers `^[raw/articles/source.md]` at the end of paragraphs whose claims come from a specific source.

### 11. Update index.md

Add new pages under the correct section (Entities, Concepts, Comparisons, Queries) in alphabetical order. Update the "Total pages" count and "Last updated" date in the header.

### 12. Append to log.md

```
## [<date>] ingest | <source title>
Pages written: <list of new pages>
Pages updated: <list of updated pages>
```

### 13. Report to user

List every file created or updated. Mention any contradictions found.

## Common Mistakes

- **Appending chronological updates instead of editing in-place** — Wiki pages are living documents. Update in-place, bump `updated` date, log the change.
- **Skipping the cross-reference audit** — A wiki's value compounds through bidirectional links.
- **Summarizing the abstract instead of synthesizing** — The Summary section should reflect your own synthesis.
- **Not running fetch-guard on URLs** — Always run `scripts/wiki-fetch-guard.sh` before fetching URLs.
- **Creating pages for passing mentions** — Follow the Page Thresholds in SCHEMA.md (2+ source mentions or central to one source).
```

- [ ] **Step 2: Commit**

```bash
git add skills/wiki-ingest/
git commit -m "feat: add wiki-ingest skill with fetch-guard, sha256, staged writes"
```

---

### Task 6: wiki-query Skill

**Files:**
- Create: `skills/wiki-query/SKILL.md`

Source: kfchou/wiki-query enhanced with 3-tier search chain from claude-wiki-verbs (adapted for Hermes directory layout).

- [ ] **Step 1: Write skills/wiki-query/SKILL.md**

```markdown
---
name: wiki-query
description: Use when asking a question against a wiki. Do not answer from general knowledge — always read the wiki pages first.
---

# Wiki Query

Ask a question. Read the wiki using multi-tier search. Synthesize with citations. Offer to file the answer back.

## Pre-condition

Find `SCHEMA.md` (search from cwd upward, or in common wiki locations). If not found, tell the user to run `wiki-init` first. Read it to get wiki root path and citation convention.
Read `index.md` and the last 10 lines of `log.md` to orient.

## Process

### 1. Read `index.md` first

Scan the full index to identify which pages are likely relevant. Do NOT answer from general knowledge — the wiki is the source of truth, even if you think you know the answer.

### 2. Multi-tier search

**Tier 1 — Wiki index** (automatic, always first):
Scan `index.md` for pages whose title, summary, or tags match the query terms. Read the top 2-6 most relevant pages in full.

**Tier 2 — File grep** (automatic if Tier 1 is insufficient):
Use `Grep` to search all `.md` files in the wiki for key terms from the query. The index summary may miss relevant content inside pages.

**Tier 3 — External web** (only if wiki is insufficient):
If the wiki has no relevant pages and the question is about a topic the wiki doesn't cover, tell the user: "The wiki has no page on X. Want me to search the web and ingest what I find?"

Never search external sources before checking the wiki. The wiki may contradict what you think you know.

### 3. Read relevant pages

Read the identified pages in full. Follow one level of `[[wikilinks]]` if they point to pages that seem relevant to the question.

### 4. Synthesize the answer

Write a response that:
- Is grounded in the wiki pages you read
- Cites inline using `[[slug]]` for every claim sourced from a specific page
- Notes agreements and disagreements between pages
- Flags gaps: "The wiki has no page on X" or "[[page]] doesn't cover Y yet"
- Suggests follow-up sources to ingest or questions to investigate

Format for the question type:
- Factual → prose with citations
- Comparison → table
- How-it-works → numbered steps
- What-do-we-know-about-X → structured summary with open questions

### 5. Always offer to save

After answering, say:
> "Worth saving as a query page?"

If yes:
- Create the page in `queries/<slug>.md` with type `query`
- Add entry to `index.md` under Queries
- Append to log.md

If no:
- Append to log.md: `## [<date>] query | <question summary> — not filed`

## Common Mistakes

- **Answering from memory** — Always read the wiki pages first. The wiki may contradict what you think you know.
- **Skipping the save offer** — Good query answers compound the wiki's value. Always offer.
- **No citations** — Every factual claim should trace back to a `[[slug]]`.
- **Searching external sources before the wiki** — The wiki is the source of truth. Check it first.
```

- [ ] **Step 2: Commit**

```bash
git add skills/wiki-query/
git commit -m "feat: add wiki-query skill with 3-tier search chain"
```

---

### Task 7: wiki-lint Skill

**Files:**
- Create: `skills/wiki-lint/SKILL.md`

Source: kfchou/wiki-lint adapted for Hermes typed subdirs + sha256 drift detection + Hermes quality signals (confidence, contested, contradictions).

- [ ] **Step 1: Write skills/wiki-lint/SKILL.md**

```markdown
---
name: wiki-lint
description: Use when auditing a wiki for health issues — broken links, orphans, stale content, contradictions, missing frontmatter, source drift. Run after every 5-10 ingests.
---

# Wiki Lint

Audit the wiki. Produce a severity-tiered report. Offer concrete fixes. Log the operation.

## Pre-condition

Find `SCHEMA.md` (search from cwd upward). If not found, tell the user to run `wiki-init` first. Read it to get wiki root path and conventions.

## Process

### 1. Build the page inventory

Read `index.md` and all files in the wiki typed subdirs (`entities/`, `concepts/`, `comparisons/`, `queries/`). Build a map of:
- All existing page slugs (filenames without `.md`)
- All `[[wikilinks]]` found in any page
- All `sources` listed in frontmatter
- All tags in use

### 2. Run all checks

**🔴 Errors (must fix)**
- **Broken links** — `[[slug]]` references where no corresponding page exists in any typed subdir
- **Missing frontmatter** — pages without required fields (title, created, updated, type, tags, sources)
- **Invalid tags** — tags not in the SCHEMA.md taxonomy

**🟡 Warnings (should fix)**
- **Orphan pages** — pages with zero inbound `[[wikilinks]]` from other pages (excluding index.md)
- **Contradictions** — pages that share entities/tags but state conflicting facts. Surface all pages with `contested: true` or `contradictions:` frontmatter
- **Stale content** — pages with `updated` >90 days older than the most recent source mentioning the same entities
- **Missing cross-references** — two pages that discuss the same entity but don't link to each other
- **Low confidence** — pages with `confidence: low` that have no Pending Review section

**🔵 Info (consider addressing)**
- **Page size** — pages over 200 lines (candidates for splitting)
- **Source drift** — for each file in `raw/` with `sha256:` frontmatter, recompute using `scripts/wiki-hash.sh` and flag mismatches
- **Missing concept pages** — `[[slug]]` references that appear 3+ times but have no dedicated page
- **Index completeness** — pages on disk not listed in index.md
- **Log rotation** — if log.md exceeds 500 entries, rotate it

### 3. Write the lint report

Always write — do not ask permission. Path: `queries/lint-<date>.md`

```yaml
---
title: Lint Report <date>
created: <date>
updated: <date>
type: query
tags: [lint, maintenance]
sources: []
---
# Lint Report — <date>

## Summary
- 🔴 Errors: N
- 🟡 Warnings: N
- 🔵 Info: N

## 🔴 Broken Links
- [[source-page]] references [[missing-slug]] — does not exist
  Fix: create the page or remove the reference

## 🟡 Orphan Pages
- [[slug]] — no inbound links
  Fix: add link from [[related-page]], or delete if no longer relevant

## 🟡 Contradictions
- [[page-a]] says: "<claim>"
- [[page-b]] says: "<contradicting claim>"
  Recommendation: <which to keep and why>

## 🟡 Stale Content
- [[page]] last updated <date>, contains "latest" — may be outdated

## 🔵 Source Drift
- raw/articles/slug.md: sha256 mismatch (stored: <old>, computed: <new>)

## 🔵 Page Size
- [[page]] is N lines (limit: 200) — consider splitting
```

Add the lint report to `index.md` under Queries.

### 4. Offer concrete fixes

For each fixable category, offer to fix with exact diffs shown before writing. Apply only after confirmation.

### 5. Append to log.md

```
## [<date>] lint | N errors, N warnings, N info
Report: [[lint-<date>]]
Fixed: <list if any>
```
```

- [ ] **Step 2: Commit**

```bash
git add skills/wiki-lint/
git commit -m "feat: add wiki-lint skill with sha256 drift detection and Hermes quality checks"
```

---

### Task 8: wiki-crystallize Skill

**Files:**
- Create: `skills/wiki-crystallize/SKILL.md`

Source: vanillaflava/llm-wiki-claude-skills crystallize concept, rewritten using Hermes field names (type not page_type, confidence not reliability, SCHEMA.md not wiki-schema.md).

- [ ] **Step 1: Write skills/wiki-crystallize/SKILL.md**

```markdown
---
name: wiki-crystallize
description: Use at the end of a productive session to distill the conversation's key insights into wiki pages. This is the primary mechanism for compounding chat knowledge into persistent wiki.
---

# Wiki Crystallize

Distill working session knowledge into wiki pages. End-of-session compounding.

## Pre-condition

Find `SCHEMA.md` (search from cwd upward). If not found, tell the user to run `wiki-init` first. Read `SCHEMA.md`, `index.md`, and the last 20 lines of `log.md` to orient.

## When to Use

- End of a productive conversation that generated new insights
- After a brainstorming session that produced a design or decision
- When the user says "save this to the wiki" or "crystallize this session"
- After solving a hard problem where the solution path is worth preserving

## Process

### 1. Identify session content

Review the conversation and extract:
- Key insights, decisions, or discoveries
- Problem-solving approaches that worked
- Information that would be painful to re-derive
- Connections between concepts that emerged during the session

Skip: routine operations, temporary debugging, trivial lookups.

### 2. Check existing wiki pages

Read `index.md` and use `Grep` to find pages related to the session topics. For each insight:
- **Existing page can absorb it:** Update the page in-place, bump `updated` date
- **No existing page, substantial insight:** Create a new page
- **Fleeting mention:** Don't create a page; add to an existing related page if one exists

### 3. Write or update wiki pages

For new pages, use the Hermes-compatible frontmatter:
```yaml
---
title: <Page Title>
created: <today>
updated: <today>
type: entity | concept | comparison | query | summary
tags: [from SCHEMA.md taxonomy]
sources: []
confidence: medium
---
```

Since crystallized pages come from a single session (one "source"), set `confidence: medium` by default. Add a `## Pending Review` section:

```markdown
## Pending Review
- This page was crystallized from a single conversation session. Verify key claims against external sources.
```

If the same page has been crystallized from multiple sessions, note the count in the page body:
```markdown
<!-- crystallize_count: N -->
```

### 4. Cross-reference

Every crystallized page must have at least 2 outbound `[[wikilinks]]` to other wiki pages. Scan existing pages and add backlinks where appropriate.

### 5. Update index.md and log.md

Add new pages to `index.md` under the correct section. Append to `log.md`:

```
## [<date>] crystallize | <session topic summary>
Pages written: <list>
Pages updated: <list>
```

### 6. Report to user

List what was saved:
- New pages created
- Existing pages updated
- A one-sentence summary of what was crystallized

## What NOT to Crystallize

- Temporary debugging steps or error messages
- Routine file operations or git commands
- Information already well-covered in existing wiki pages
- Speculative ideas without substance

## Crystallize vs Ingest

- **Ingest** processes an external source (URL, file, paper) into the wiki
- **Crystallize** processes an internal conversation into the wiki
- Both produce the same output format (Hermes-compatible wiki pages)
- Crystallized pages should be verified later via `wiki-audit` against external sources
```

- [ ] **Step 2: Commit**

```bash
git add skills/wiki-crystallize/
git commit -m "feat: add wiki-crystallize skill for session-to-wiki distillation"
```

---

### Task 9: wiki-audit Skill

**Files:**
- Create: `skills/wiki-audit/SKILL.md`

Source: kfchou/wiki-audit, already close to Hermes format. Adapted for Hermes typed subdirs and frontmatter fields.

- [ ] **Step 1: Write skills/wiki-audit/SKILL.md**

```markdown
---
name: wiki-audit
description: Use when fact-checking a single wiki page against its cited sources — verifies that every footnote supports its claim and surfaces uncited factual claims.
---

# Wiki Audit

Verify a single wiki page against its cited sources. Two phases: detect uncited factual claims, then verify cited claims against raw sources.

## Pre-condition

Find `SCHEMA.md` (search from cwd upward). If not found, tell the user to run `wiki-init` first. Read `SCHEMA.md` for the wiki root path and the Citations section.

If the user did not name a page, ask which page to audit. Accept slug, filename, or absolute path. Resolve to the correct typed subdir (e.g., `concepts/<slug>.md`). Audit one page per run.

## Process

### 1. Read the target page

Read the full page. Note:
- The frontmatter `sources:` list
- All footnote definitions (`[^N]: ...`) and references (`[^N]` in body text)

If the page has zero footnotes but contains factual content, every claim becomes an uncited finding. Still run Phase A; skip Phase B.

### 2. Phase A — Uncited claim detection

List every non-common-knowledge factual claim that lacks a footnote. For each:
- Line number
- Claim text
- Suggested source from the page's `sources:` list, or "unknown"

### 3. Phase B — Cited claim verification

For every footnote definition in the page, parse:
- The **target** — one of `[[source-slug]]`, a path under `raw/`/`assets/`, or a URL
- The **locator** (§section, p.N, timestamp, anchor, dated post)
- Either the verbatim **quote** or the `[synthesis]` description

**Resolve each target to readable content:**
- `[[source-slug]]` → read the summary page to find the raw file path in its `sources:` field, then read that raw file from `raw/`
- `raw/<path>` or `assets/<path>` → read the file directly
- `<url>` → check for cached copy in `raw/assets/`. If yes, read it. If not, mark `🚫 source-missing`

**Group resolvable footnotes by their resolved file** (multiple footnotes against the same PDF read it once).

For each footnote, assign one verdict:
- `✅ supported` — quote matches the source at the cited locator, or the `[synthesis]` description honestly summarizes the cited range
- `❌ unsupported` — quote not found at the cited locator, or claim is contradicted by the source
- `⚠️ partial` — quote is paraphrased rather than verbatim (lacks `[synthesis]` tag), or synthesis description overstates the cited range
- `🚫 source-missing` — target cannot be resolved

For ❌ and ⚠️, include what the source actually says.

### 4. Write the audit report

Always write — do not ask permission. Path: `queries/audit-<slug>-<date>.md`

```yaml
---
title: Audit Report — <slug> — <date>
created: <date>
updated: <date>
type: query
tags: [audit, maintenance]
sources: []
---
# Audit Report — [[<slug>]] — <date>

## Summary
- Cited claims verified: N
- ✅ Supported: N  ❌ Unsupported: N  ⚠️ Partial: N  🚫 Source missing: N
- 🆘 Uncited factual claims: N

## 🆘 Uncited Claims
- Line 42: "<claim>"
  Suggested source: [[<source-slug>]] or unknown
  Fix: add footnote, weaken claim, or remove

## ❌ Unsupported
- [^3]: claims "<quote>"
  Source says: "<actual text>"
  Fix: correct the claim

## ⚠️ Partial
- [^7]: [synthesis] description says "<description>"
  Source range covers less. Tighten the description.

## 🚫 Source Missing
- [^5]: <url> — no cached copy in raw/
  Fix: re-fetch source, or remove citation

## ✅ Supported
- [^1], [^2], [^4], [^6] — all verified
```

Add the report to `index.md` under Queries.

### 5. Offer concrete fixes

For each non-empty category, offer fixes one at a time. Show exact diffs before writing. Apply only after user confirmation.

### 6. Append to log.md

```
## [<date>] audit | [[<slug>]] — N supported, N unsupported, N partial, N uncited
Report: [[audit-<slug>-<date>]]
```

### 7. Report to user

One-line verdict (e.g., "5/8 cited claims verified, 2 uncited claims found") and whether any fixes were applied.
```

- [ ] **Step 2: Commit**

```bash
git add skills/wiki-audit/
git commit -m "feat: add wiki-audit skill for per-page citation verification"
```

---

### Task 10: install.sh

**Files:**
- Create: `install.sh`

Source: claude-wiki-verbs install.sh simplified for Claude Code only (no cross-tool symlinks, no qmd, no vault path prompting).

- [ ] **Step 1: Write install.sh**

```bash
#!/usr/bin/env bash
# llm-wiki skill installer for Claude Code
# Copies skill files to ~/.claude/skills/ with preflight, backup, and manifest.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
TARGET_DIR="$HOME/.claude/skills"
MANIFEST="$TARGET_DIR/.wiki-manifest.json"
UNINSTALL=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      echo "Usage: ./install.sh [--uninstall] [--force]"
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue() { printf '\033[34m%s\033[0m\n' "$*"; }

# Uninstall
if [[ $UNINSTALL -eq 1 ]]; then
  if [[ ! -f "$MANIFEST" ]]; then
    red "No manifest found. Nothing to uninstall."
    exit 1
  fi
  blue "Removing wiki skills..."
  while IFS= read -r file; do
    if [[ -f "$TARGET_DIR/$file" ]]; then
      rm "$TARGET_DIR/$file"
      green "  ✓ removed $file"
    fi
  done < <(python3 -c "import json,sys; [print(f) for f in json.load(open('$MANIFEST'))]" 2>/dev/null || true)
  rm -f "$MANIFEST"
  green "✅ Uninstall complete."
  exit 0
fi

# Preflight
blue "📦 llm-wiki skill installer"
echo

if [[ ! -d "$SKILLS_SRC" ]]; then
  red "Skills directory not found: $SKILLS_SRC"
  exit 1
fi

mkdir -p "$TARGET_DIR"

# Install each skill
installed=()
backup_ts="$(date +%Y%m%d-%H%M%S)"

for skill_dir in "$SKILLS_SRC"/*/; do
  skill_name=$(basename "$skill_dir")
  skill_file="$skill_dir/SKILL.md"

  if [[ ! -f "$skill_file" ]]; then
    continue
  fi

  target="$TARGET_DIR/$skill_name/SKILL.md"

  # Backup existing
  if [[ -f "$target" ]] && [[ $FORCE -eq 0 ]]; then
    backup="${target}.backup-${backup_ts}"
    mkdir -p "$(dirname "$backup")"
    cp "$target" "$backup"
    green "  ↩ backed up existing $skill_name"
  fi

  # Copy
  mkdir -p "$(dirname "$target")"
  cp "$skill_file" "$target"
  green "  ✓ installed $skill_name"
  installed+=("$skill_name")
done

# Write manifest
printf '%s\n' "${installed[@]}" | python3 -c "
import json, sys
skills = [line.strip() for line in sys.stdin if line.strip()]
manifest = {s: f'{s}/SKILL.md' for s in skills}
json.dump(manifest, open('$MANIFEST', 'w'), indent=2)
" 2>/dev/null

# Copy helper scripts to ~/.claude/skills/
if [[ -d "$REPO_ROOT/scripts" ]]; then
  for script in "$REPO_ROOT/scripts"/*.sh; do
    [[ -f "$script" ]] || continue
    cp "$script" "$TARGET_DIR/$(basename "$script")"
    chmod +x "$TARGET_DIR/$(basename "$script")"
    green "  ✓ installed $(basename "$script")"
  done
fi

echo
green "✅ Install complete. ${#installed[@]} skills installed."
blue "Skills: ${installed[*]}"
blue "Manifest: $MANIFEST"
blue "Uninstall: ./install.sh --uninstall"
echo
blue "Usage: Skills are available via the /wiki-init, /wiki-ingest, etc. commands in Claude Code."
```

- [ ] **Step 2: Make install.sh executable**

```bash
chmod +x install.sh
```

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: add Claude Code skill installer with preflight and manifest"
```

---

### Task 11: README.md and CLAUDE.md

**Files:**
- Create: `README.md`
- Create: `CLAUDE.md`

- [ ] **Step 1: Write README.md**

```markdown
# llm-wiki

A multi-skill Claude Code plugin implementing [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — a persistent, compounding knowledge base maintained by your LLM.

**Wire-compatible with Hermes Agent's built-in `llm-wiki` skill (v2.1.0).** A wiki built by this plugin can be maintained by Hermes, and vice versa.

## Installation

```bash
git clone https://github.com/<owner>/llm-wiki ~/repos/llm-wiki
cd ~/repos/llm-wiki
./install.sh
```

## Skills

| Skill | Description |
|-------|-------------|
| `wiki-init` | Bootstrap a new Hermes-compatible wiki vault |
| `wiki-ingest` | Add a source (paper, URL, file, transcript) to the wiki |
| `wiki-query` | Ask a question against the wiki; optionally save the answer back |
| `wiki-lint` | Health audit: contradictions, orphans, broken links, source drift |
| `wiki-crystallize` | Distill session knowledge into wiki pages |
| `wiki-audit` | Verify a page's citations against its raw sources |

## Wiki Structure

```
<wiki-root>/
├── SCHEMA.md           # Conventions, tag taxonomy, domain config
├── index.md            # Sectioned content catalog
├── log.md              # Append-only action log (rotate at 500 entries)
├── raw/                # Layer 1: Immutable source material
│   ├── articles/
│   ├── papers/
│   ├── transcripts/
│   └── assets/
├── entities/           # Layer 2: People, orgs, products
├── concepts/           # Layer 2: Topics, techniques, ideas
├── comparisons/        # Layer 2: Side-by-side analyses
└── queries/            # Layer 2: Filed query results
```

## Typical Workflow

```
wiki-init → bootstrap a new wiki
wiki-ingest → add sources one at a time (repeat)
wiki-crystallize → distill session insights at end of conversation
wiki-query → ask questions; save good answers back
wiki-lint → periodic health check (every 5-10 ingests)
wiki-audit → verify specific pages against their sources
```

## Inspired By

[Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (April 2026)

## License

MIT
```

- [ ] **Step 2: Write CLAUDE.md**

```markdown
# LLM Wiki Skill

## TL;DR
Multi-skill Claude Code plugin for building Karpathy-style interlinked markdown knowledge bases.
Output is wire-compatible with Hermes Agent llm-wiki v2.1.0.

## Skills
- `/wiki-init` — bootstrap a new wiki vault
- `/wiki-ingest` — add a source to the wiki
- `/wiki-query` — ask a question against the wiki
- `/wiki-lint` — health audit
- `/wiki-crystallize` — session → wiki page distillation
- `/wiki-audit` — citation verification per page

## Wiki Location
Set via `WIKI_PATH` env var. If unset, defaults to `~/wiki`.

## Key Rules
- `raw/` is immutable — never modify source files
- `log.md` is append-only — never rewrite
- `SCHEMA.md` defines the tag taxonomy — closed set, add new tags there first
- Every page needs 2+ outbound `[[wikilinks]]`
- Run `scripts/wiki-fetch-guard.sh` before fetching any URL
- Run `scripts/wiki-hash.sh` to compute sha256 for raw source drift detection
- Set `confidence: low` for single-source pages, `high` only when well-supported
- Use provenance markers `^[raw/articles/source.md]` on pages with 3+ sources
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: add README and CLAUDE.md with usage and skill descriptions"
```

---

### Task 12: Integration Test

**Files:**
- Test only (no new files created)

- [ ] **Step 1: Install the skills**

```bash
cd /Users/karlchow/Desktop/code/llm-wiki
./install.sh
```

Expected: 6 skills installed, scripts copied, manifest created.

- [ ] **Step 2: Verify installation**

```bash
ls ~/.claude/skills/wiki-*/SKILL.md
cat ~/.claude/skills/.wiki-manifest.json
```

Expected: 6 SKILL.md files listed, manifest contains all 6 skill names.

- [ ] **Step 3: Verify wiki-init creates Hermes-compatible structure**

```bash
# Manually verify the wiki-init skill file contains the Hermes directory layout
grep -c "entities/" skills/wiki-init/SKILL.md
grep -c "concepts/" skills/wiki-init/SKILL.md
grep -c "comparisons/" skills/wiki-init/SKILL.md
grep -c "queries/" skills/wiki-init/SKILL.md
```

Expected: All return >= 1 (references to typed subdirs).

- [ ] **Step 4: Verify wiki-ingest references fetch-guard and sha256**

```bash
grep -c "wiki-fetch-guard" skills/wiki-ingest/SKILL.md
grep -c "wiki-hash.sh" skills/wiki-ingest/SKILL.md
grep -c "confidence:" skills/wiki-ingest/SKILL.md
grep -c "staged batch" skills/wiki-ingest/SKILL.md
```

Expected: All return >= 1.

- [ ] **Step 5: Verify wiki-lint references hash script**

```bash
grep -c "wiki-hash.sh" skills/wiki-lint/SKILL.md
grep -c "source drift" skills/wiki-lint/SKILL.md
grep -c "contested" skills/wiki-lint/SKILL.md
```

Expected: All return >= 1.

- [ ] **Step 6: Verify Hermes frontmatter compatibility**

```bash
# All skills should use Hermes field names, not vanillaflava's
grep -c "page_type" skills/*/SKILL.md 2>/dev/null | grep -v ":0$" && echo "FAIL: found page_type" || echo "PASS: no page_type"
grep -c "reliability:" skills/*/SKILL.md 2>/dev/null | grep -v ":0$" && echo "FAIL: found reliability" || echo "PASS: no reliability"
grep -c "wiki-schema.md" skills/*/SKILL.md 2>/dev/null | grep -v ":0$" && echo "FAIL: found wiki-schema.md" || echo "PASS: no wiki-schema.md"
```

Expected: All PASS lines.

- [ ] **Step 7: Clean up test artifacts**

```bash
# Uninstall
./install.sh --uninstall
```

Expected: All skills removed, manifest deleted.

- [ ] **Step 8: Final commit**

```bash
git status
git add -A
git commit -m "test: verify Hermes compatibility of all skill files" || echo "Nothing to commit (clean)"
```
