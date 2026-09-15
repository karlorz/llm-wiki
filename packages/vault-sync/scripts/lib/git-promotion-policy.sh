#!/bin/bash
# GitHub promotion policy shared by snapshot execution and CLI parity tests.
# This is intentionally narrower than S3 ownership.

snapshot_non_promotable_path() {
    local p="${1#./}"
    case "$p" in
        .skillwiki|.skillwiki/*|.claude|.claude/*|.obsidian|.obsidian/*|.antigravitycli|.antigravitycli/*|.playwright-cli|.playwright-cli/*|.superpowers|.superpowers/*|.snapshots|.snapshots/*|.git|.git/*|.drafts|.drafts/*)
            return 0 ;;
        tmp|tmp/*|logs|logs/*|meta/log-events|meta/log-events/*)
            return 0 ;;
        raw/._.DS_Store|._.DS_Store)
            return 0 ;;
        ._*)
            return 0 ;;
        .conflict*|*.conflict-*)
            return 0 ;;
    esac
    return 1
}
