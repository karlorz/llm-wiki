# Save SkillWiki images and attachments

Use this runbook when the user asks to save a generated image, screenshot,
design mockup, attachment, picture, or Markdown image into the wiki.

HTTP MCP Markdown capture and binary bundle transport are different supported
capabilities. The connected MCP advertises no binary-upload tool. That is
expected. It is not evidence that SkillWiki cannot save images.

Do not invent commands. Confirm the live CLI before acting:

```sh
skillwiki --version
skillwiki clip-outbox --help
skillwiki clip-outbox status
skillwiki doctor
```

Historical "planned" or "disabled by default" labels do not override the help
and status of the installed CLI.

## Live clip-outbox commands

Quote these from current `skillwiki clip-outbox --help` (v0.10.113 source in
`packages/cli/src/cli.ts`). Re-read help if a newer CLI disagrees.

| Subcommand | Help text | Agent may run? |
|---|---|---|
| `status` | show whether the clip-outbox channel is configured | Yes |
| `watch` | run the enabled dedicated outbox worker using macOS FSEvents | No, unless the user explicitly asks to operate that worker |
| `mirror-watch` | copy admitted raw/articles and raw/assets from storage into the frozen mirror using MCP SSE | No, unless the user explicitly asks to operate that listener |
| `install-or-migrate` | refresh the packaged launchd plist without enabling the channel | No, unless the user explicitly asks to operate infrastructure |

Do not run `watch`, `mirror-watch`, or `install-or-migrate` unless the user explicitly asks to operate that infrastructure.

`status` with the channel off prints `clip channel not configured` and
`enabled: false`. `status` with the channel on prints
`clip-outbox enabled root=<outbox> mode=event-watch` plus journal rows.

Doctor clip rows on an MCP-only leaf print `MCP-only leaf — check skipped`.
That host has Markdown MCP only. It is not a binary ingress.

Operator enablement lives in `packages/cli/docs/clip-outbox.md`. Do not follow
that file as an unattended enablement checklist.

## Routing cases

| Request | Host facts | Report and do |
|---|---|---|
| Generated PNG, screenshot, design mockup, or attachment | MCP has no binary-upload tool; `clip-outbox status` is enabled | Discover this route without a user hint. Stage the bundle in the dedicated outbox root from status. Never `~/wiki`. |
| Same request | MCP-only leaf; doctor clip rows `MCP-only leaf — check skipped`; no supported binary ingress | Report that exact limitation. Do not rclone, copy credentials, write the frozen wiki, or invent an upload service. |
| Same request | `clip channel not configured`, or doctor `production clip watcher not loaded and enabled` | Stop at that prerequisite. Do not set `clip_outbox.enabled`, load launchd, or run `install-or-migrate` / `watch` as a fallback. |
| Journal `notify-pending`, or object receipts without `central-visible` | Transfer in flight | Report **transfer pending**, not complete. |
| Existing central Markdown uses `/Users/...`, `file://`, or another host-local image path | Note is already in the wiki | That reference is not a portable attachment. |
| Enabled outbox finishes | Journal `central-visible`; MCP `wiki_read_page` has `s3_verified=true`; mirror SHA-256 matches the original bytes | Report those verified stages. Keep image bytes. Expect a sibling `note.md`. |
| Reader on another device | Visual check not done | Distinguish ordinary Markdown `![](url)` from Obsidian `![[raw/assets/...]]`. Do not claim rendering. |

## Bundle layout

Parse the outbox root from `skillwiki clip-outbox status` (`root=` in
`humanHint`). The worker admits Markdown under `raw/articles/` and local
binaries under `raw/assets/` of that dedicated vault. It is not `~/wiki`.

Stage:

```
<root>/raw/assets/<slug>/<file>.png
<root>/raw/articles/<slug>.md
```

The article must reference the image with a vault-relative embed or markdown
image whose target is `raw/assets/...`. Supported image kinds are png, jpeg,
gif, and webp. Host-absolute paths (`/Users/...`, `/home/...`, `file://`) are
not portable and the localizer holds them as unsafe.

Example article body:

```markdown
---
source_url:
ingested: YYYY-MM-DD
kind: note
---
# Title

![[raw/assets/<slug>/<file>.png]]
```

The worker localizes, seals snapshots outside raw, and preserves existing local
asset paths. It does not rewrite the input article. Published keys include a
date plus capture identity. It also uploads sibling
`raw/assets/<captureId>/note.md` that embeds each asset. Never use a `.txt`
sidecar as the only index.

After central visibility, a maintained work item may cite the vault-relative
embed through permitted Markdown MCP (`wiki_workitem_write`). That is still
not a binary MCP upload.

Leave completed raw captures immutable. Later results become a new capture or a
permitted maintained work-item update.

## Progress labels

Use these labels. Do not collapse them into "saved".

| Label | Evidence |
|---|---|
| local archive saved | Bytes written under the dedicated outbox `raw/articles/` and `raw/assets/` |
| bundle staged | Journal `sealed` (snapshots under the configured state root) |
| transfer acknowledged | Journal `assets-verified` / `article-verified` (create-only PUT receipts) |
| centrally visible | Journal `central-visible` after the ready hint accounts for every path |
| central note verified | MCP `wiki_read_page` on the article and `raw/assets/<captureId>/note.md` with `s3_verified=true` |
| mirrored binary hash verified | Frozen-mirror file SHA-256 equals the original image. The worker never infers `mirrored`. |
| reader rendering verified | A person checked display in a reader. Ordinary Markdown needs a resolvable URL; `![[raw/assets/...]]` needs a compatible resolver. |

`notify-pending` means the ready hint is not yet adopted. A queued HTTP 202 is
not central visibility.

## Authority boundary

Markdown writes stay on permitted MCP tools (`wiki_capture`,
`wiki_log_append`, `wiki_workitem_write`, `wiki_page_publish`).

Binary saving uses only an existing enabled clip-outbox ingress. Never write
binaries into the frozen wiki, never `rclone` / wiki-push as a writer, never
copy clip credentials, and never stand up another upload service.

If the route is missing, disabled, or unauthorized, report that limitation and
stop.
