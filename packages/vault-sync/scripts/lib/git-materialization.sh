#!/bin/bash
# git-materialization.sh — prove a local commit's content is already present on a target ref.
#
# Bash 3.2 compatible. Source from vault-sync scripts.
#
# vault_sync_commit_materialized <commit> <target-ref> [repo]
#   Exit 0 only when every changed path is proven present in the target tree:
#   - ordinary add/modify: target blob == commit blob
#   - delete: target path absent
#   - log.md / */log.md: every added ## section body occurs byte-for-byte in target log
#   Fail closed (exit 1) on rename, binary mismatch, missing target, unsupported status,
#   partial log section match, or any unprovable change.

vault_sync_is_log_path() {
    case "$1" in
        log.md|*/log.md) return 0 ;;
        *) return 1 ;;
    esac
}

# Return 0 if file contains at least one NUL byte (binary). Do NOT use
# `grep -q $'\0'` — on macOS BSD grep that matches every non-empty file.
vault_sync_file_has_nul() {
    local f="$1"
    [ -f "$f" ] || return 1
    # Compare original to a NUL-stripped copy; differ ⇒ had NUL.
    if ! tr -d '\0' <"$f" | cmp -s - "$f"; then
        return 0
    fi
    return 1
}

# Extract Markdown sections starting at ^##  from stdin; print each section
# separated by a form-feed so callers can compare complete bodies.
vault_sync_extract_h2_sections() {
    awk '
        BEGIN { sec = ""; insec = 0 }
        /^## / {
            if (insec && sec != "") {
                printf "%s\f", sec
            }
            sec = $0 "\n"
            insec = 1
            next
        }
        insec {
            sec = sec $0 "\n"
        }
        END {
            if (insec && sec != "") {
                printf "%s\f", sec
            }
        }
    '
}

# Return 0 if every added ## section in new_file appears byte-for-byte in target_file.
vault_sync_log_sections_materialized() {
    local new_file="$1"
    local target_file="$2"
    local old_file="${3:-}"
    local new_secs target_text sec old_secs sec_file rc

    if [ ! -f "$new_file" ] || [ ! -f "$target_file" ]; then
        return 1
    fi

    new_secs="$(vault_sync_extract_h2_sections < "$new_file")"
    target_text="$(cat "$target_file")"
    old_secs=""
    if [ -n "$old_file" ] && [ -f "$old_file" ]; then
        old_secs="$(vault_sync_extract_h2_sections < "$old_file")"
    fi

    # Write sections to a temp file and iterate without a pipeline subshell
    # so a missing section can fail the function itself (Bash 3.2-safe).
    sec_file="$(mktemp)" || return 1
    printf '%s' "$new_secs" > "$sec_file"
    rc=0
    while IFS= read -r -d $'\f' sec || [ -n "${sec:-}" ]; do
        [ -n "${sec:-}" ] || continue
        if [ -n "$old_secs" ]; then
            case "$old_secs" in
                *"$sec"*) continue ;;
            esac
        fi
        case "$target_text" in
            *"$sec"*) ;;
            *) rc=1; break ;;
        esac
    done < "$sec_file"
    rm -f "$sec_file"
    return $rc
}

# Prove commit is fully materialized on target-ref.
vault_sync_commit_materialized() {
    local commit="$1"
    local target_ref="$2"
    local repo="${3:-.}"
    local parent status path tmpdir old_blob new_blob target_blob
    local commit_sha target_sha
    local changed=0

    if [ -z "$commit" ] || [ -z "$target_ref" ]; then
        return 1
    fi
    if ! git -C "$repo" rev-parse -q --verify "$commit^{commit}" >/dev/null 2>&1; then
        return 1
    fi
    if ! git -C "$repo" rev-parse -q --verify "$target_ref^{commit}" >/dev/null 2>&1; then
        return 1
    fi

    parent="$(git -C "$repo" rev-parse "${commit}^" 2>/dev/null || true)"
    if [ -z "$parent" ]; then
        return 1
    fi

    while IFS= read -r line; do
        [ -n "$line" ] || continue
        changed=1
        status="${line%%	*}"
        path="${line#*	}"
        case "$status" in
            R*|C*)
                return 1
                ;;
            A|M|D|T)
                ;;
            *)
                return 1
                ;;
        esac

        case "$path" in
            *$'\t'*) return 1 ;;
        esac

        if vault_sync_is_log_path "$path"; then
            if [ "$status" = "D" ]; then
                if git -C "$repo" cat-file -e "$target_ref:$path" 2>/dev/null; then
                    return 1
                fi
                continue
            fi
            tmpdir="$(mktemp -d)" || return 1
            old_blob="$tmpdir/old"
            new_blob="$tmpdir/new"
            target_blob="$tmpdir/target"
            if [ "$status" = "A" ]; then
                : > "$old_blob"
            else
                if ! git -C "$repo" show "$parent:$path" >"$old_blob" 2>/dev/null; then
                    rm -rf "$tmpdir"
                    return 1
                fi
            fi
            if ! git -C "$repo" show "$commit:$path" >"$new_blob" 2>/dev/null; then
                rm -rf "$tmpdir"
                return 1
            fi
            if ! git -C "$repo" show "$target_ref:$path" >"$target_blob" 2>/dev/null; then
                rm -rf "$tmpdir"
                return 1
            fi
            # Real binary/NUL check (not BSD-grep $'\0', which false-positives on text).
            if vault_sync_file_has_nul "$new_blob" || vault_sync_file_has_nul "$target_blob"; then
                rm -rf "$tmpdir"
                return 1
            fi
            if ! vault_sync_log_sections_materialized "$new_blob" "$target_blob" "$old_blob"; then
                rm -rf "$tmpdir"
                return 1
            fi
            rm -rf "$tmpdir"
            continue
        fi

        case "$status" in
            D)
                if git -C "$repo" cat-file -e "$target_ref:$path" 2>/dev/null; then
                    return 1
                fi
                ;;
            A|M|T)
                if ! git -C "$repo" cat-file -e "$commit:$path" 2>/dev/null; then
                    return 1
                fi
                if ! git -C "$repo" cat-file -e "$target_ref:$path" 2>/dev/null; then
                    return 1
                fi
                commit_sha="$(git -C "$repo" rev-parse "$commit:$path" 2>/dev/null)" || return 1
                target_sha="$(git -C "$repo" rev-parse "$target_ref:$path" 2>/dev/null)" || return 1
                if [ "$commit_sha" != "$target_sha" ]; then
                    return 1
                fi
                ;;
        esac
    done < <(git -C "$repo" diff-tree --no-commit-id --name-status -r "$parent" "$commit" 2>/dev/null)

    # Empty commit (no path changes): nothing to replay, treat as materialized.
    return 0
}

vault_sync_list_materialized_commits() {
    local base_ref="$1"
    local target_ref="$2"
    local out_file="$3"
    local repo="${4:-.}"
    local sha

    : > "$out_file"
    while IFS= read -r sha; do
        [ -n "$sha" ] || continue
        if vault_sync_commit_materialized "$sha" "$target_ref" "$repo"; then
            # Store full SHA for robust matching in the sequence editor.
            git -C "$repo" rev-parse "$sha" >> "$out_file" 2>/dev/null || printf '%s\n' "$sha" >> "$out_file"
        fi
    done < <(git -C "$repo" rev-list --reverse "${base_ref}..HEAD" 2>/dev/null)
    return 0
}

# Drop matching pick lines entirely (portable; avoids relying on `drop` verb).
# Usage: vault_sync_sequence_editor_drop <drop-list-file> <todo-file>
vault_sync_sequence_editor_drop() {
    local drop_list="$1"
    local todo_file="$2"
    local tmp line rest sha full

    tmp="$(mktemp)" || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "pick "*|"p "*)
                rest="${line#* }"
                sha="${rest%% *}"
                full=""
                # Match if any full SHA in drop list starts with the todo short/long sha,
                # or the todo sha starts with a drop-list entry.
                if [ -s "$drop_list" ]; then
                    while IFS= read -r full || [ -n "$full" ]; do
                        [ -n "$full" ] || continue
                        case "$full" in
                            "$sha"*)
                                # omit this pick line (drop)
                                continue 2
                                ;;
                        esac
                        case "$sha" in
                            "$full"*)
                                continue 2
                                ;;
                        esac
                    done < "$drop_list"
                fi
                printf '%s\n' "$line" >> "$tmp"
                ;;
            *)
                printf '%s\n' "$line" >> "$tmp"
                ;;
        esac
    done < "$todo_file"
    mv "$tmp" "$todo_file"
}
