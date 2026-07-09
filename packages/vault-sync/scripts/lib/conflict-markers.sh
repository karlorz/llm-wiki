#!/bin/sh
# conflict-markers.sh — Detect complete Git conflict-marker blocks in Markdown.
#
# Scans *.md under a vault root, ignoring fenced code blocks. Writes findings
# as path:line: conflict marker block starts here. No ripgrep dependency.

vault_sync_scan_conflict_markers() {
    local root="$1"
    local out_file="$2"
    local rel file

    : >"$out_file" || return 1
    (
        cd "$root" || exit 2
        find . \
            -path './.git' -prune -o \
            -path './.obsidian' -prune -o \
            -path './.skillwiki' -prune -o \
            -path './.claude' -prune -o \
            -path './.antigravitycli' -prune -o \
            -path './.playwright-cli' -prune -o \
            -type f -name '*.md' -print
    ) | while IFS= read -r file; do
        rel="${file#./}"
        awk -v path="$rel" '
          BEGIN {
            in_fence = 0
            open_line = 0
            sep_line = 0
          }
          /^```/ || /^~~~/ {
            in_fence = !in_fence
            next
          }
          in_fence {
            next
          }
          /^<<<<<<< / {
            open_line = NR
            sep_line = 0
            next
          }
          /^=======$/ {
            if (open_line > 0) {
              sep_line = NR
            }
            next
          }
          /^>>>>>>> / {
            if (open_line > 0 && sep_line > 0) {
              printf "%s:%d: conflict marker block starts here\n", path, open_line
            }
            open_line = 0
            sep_line = 0
            next
          }
        ' "$root/$rel" >>"$out_file"
    done

    [ ! -s "$out_file" ]
}

vault_sync_log_conflict_marker_findings() {
    local findings_file="$1"
    local log_file="$2"
    if [ -s "$findings_file" ]; then
        cat "$findings_file" >>"$log_file"
    fi
}
