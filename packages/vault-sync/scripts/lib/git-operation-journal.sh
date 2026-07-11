#!/bin/bash
# git-operation-journal.sh — helper-owned vault-sync operation journal.
# Bash 3.2 compatible. Source from vault-sync scripts.

vault_sync_op_journal_dir() {
  local repo="${1:-.}"
  local path
  path="$(git -C "$repo" rev-parse --git-path vault-sync/operations 2>/dev/null)" || return 1
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s\n' "$repo/$path" ;;
  esac
}

vault_sync_op_journal_path() {
  local repo="$1" op_id="$2"
  local dir
  dir="$(vault_sync_op_journal_dir "$repo")" || return 1
  printf '%s/%s.env\n' "$dir" "$op_id"
}

vault_sync_op_get_field() {
  local repo="$1" op_id="$2" key="$3"
  local file
  file="$(vault_sync_op_journal_path "$repo" "$op_id")" || return 1
  [ -f "$file" ] || return 1
  # Line-oriented key=value; print value after first '=' (values may contain '=').
  awk -F= -v k="$key" '$1==k {print substr($0, index($0,"=")+1); exit}' "$file"
}

vault_sync_op_set_field() {
  local repo="$1" op_id="$2" key="$3" value="$4"
  local file tmp
  file="$(vault_sync_op_journal_path "$repo" "$op_id")" || return 1
  tmp="$(mktemp)" || return 1
  if [ -f "$file" ]; then
    awk -F= -v k="$key" -v v="$value" '
      BEGIN{found=0}
      $1==k {print k"="v; found=1; next}
      {print}
      END{if(!found) print k"="v}
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
}

vault_sync_op_set_phase() {
  vault_sync_op_set_field "$1" "$2" "phase" "$3"
}

vault_sync_op_create_recovery_refs() {
  local repo="$1" op_id="$2" original_head="$3" target_oid="$4"
  local stdin

  # Prefer transactional create (CAS: fail if ref already exists).
  stdin="$(mktemp)" || return 1
  cat >"$stdin" <<EOF
start
create refs/vault-sync/recovery/${op_id}/original-head ${original_head}
create refs/vault-sync/recovery/${op_id}/target ${target_oid}
prepare
commit
EOF
  if git -C "$repo" update-ref --stdin --create-reflog -m "vault-sync operation begin" <"$stdin" >/dev/null 2>&1; then
    rm -f "$stdin"
    return 0
  fi
  rm -f "$stdin"

  # Fallback: create-only update-ref (empty oldoid means must not exist).
  if ! git -C "$repo" update-ref \
    "refs/vault-sync/recovery/${op_id}/original-head" "$original_head" "" 2>/dev/null; then
    return 1
  fi
  if ! git -C "$repo" update-ref \
    "refs/vault-sync/recovery/${op_id}/target" "$target_oid" "" 2>/dev/null; then
    # Best-effort rollback of the first ref if second create fails.
    git -C "$repo" update-ref -d "refs/vault-sync/recovery/${op_id}/original-head" 2>/dev/null || true
    return 1
  fi
  return 0
}

vault_sync_op_begin() {
  local repo="$1" op_id="$2" branch="$3" original_head="$4" target_oid="$5"
  local lock_identity="$6" helper_version="$7" runtime_hash="$8"
  local dir file
  dir="$(vault_sync_op_journal_dir "$repo")" || return 1
  mkdir -p "$dir" || return 1
  file="$(vault_sync_op_journal_path "$repo" "$op_id")" || return 1
  if [ -f "$file" ]; then
    return 1
  fi
  if ! vault_sync_op_create_recovery_refs "$repo" "$op_id" "$original_head" "$target_oid"; then
    return 1
  fi
  cat >"$file" <<EOF
operation_id=${op_id}
phase=prepared
retry_count=0
original_branch=${branch}
original_head=${original_head}
target_oid=${target_oid}
owned_stash_oid=
preservation_scope=none
lock_identity=${lock_identity}
helper_version=${helper_version}
deployed_runtime_hash=${runtime_hash}
conflict_identity=
handoff=0
reason=
EOF
  return 0
}

vault_sync_op_record_stash() {
  vault_sync_op_set_field "$1" "$2" "owned_stash_oid" "$3" || return 1
  vault_sync_op_set_field "$1" "$2" "preservation_scope" "$4"
}

vault_sync_op_record_inventory() {
  local repo="$1" op_id="$2" inv="$3"
  local dir dest
  dir="$(vault_sync_op_journal_dir "$repo")" || return 1
  dest="$dir/${op_id}.inventory"
  cp "$inv" "$dest" || return 1
  vault_sync_op_set_field "$repo" "$op_id" "inventory_path" "$dest"
}

vault_sync_op_fingerprint_repo_state() {
  local repo="$1"
  local git_dir rebase_dir onto orig stopped head_name rebase_head index_tree porcelain
  local unmerged_paths unmerged_content path blob

  git_dir="$(git -C "$repo" rev-parse --git-dir)" || return 1
  case "$git_dir" in
    /*) ;;
    *) git_dir="$repo/$git_dir" ;;
  esac

  rebase_dir=""
  if [ -d "$git_dir/rebase-merge" ]; then
    rebase_dir="$git_dir/rebase-merge"
  elif [ -d "$git_dir/rebase-apply" ]; then
    rebase_dir="$git_dir/rebase-apply"
  fi

  onto=""
  orig=""
  stopped=""
  head_name=""
  if [ -n "$rebase_dir" ]; then
    [ -f "$rebase_dir/onto" ] && onto="$(tr -d '[:space:]' <"$rebase_dir/onto")"
    if [ -f "$rebase_dir/orig-head" ]; then
      orig="$(tr -d '[:space:]' <"$rebase_dir/orig-head")"
    elif [ -f "$rebase_dir/orig_head" ]; then
      orig="$(tr -d '[:space:]' <"$rebase_dir/orig_head")"
    fi
    [ -f "$rebase_dir/stopped-sha" ] && stopped="$(tr -d '[:space:]' <"$rebase_dir/stopped-sha")"
    [ -f "$rebase_dir/head-name" ] && head_name="$(tr -d '[:space:]' <"$rebase_dir/head-name")"
  fi

  rebase_head="$(git -C "$repo" rev-parse -q --verify REBASE_HEAD 2>/dev/null || true)"
  index_tree="$(git -C "$repo" write-tree 2>/dev/null || echo none)"
  porcelain="$(git -C "$repo" status --porcelain=v1 --untracked-files=all 2>/dev/null | shasum -a 256 | awk '{print $1}')"

  # Include worktree content of unmerged paths so human edits to conflicted
  # files change the fingerprint (porcelain alone does not hash file bodies).
  unmerged_paths="$(git -C "$repo" diff --name-only --diff-filter=U 2>/dev/null || true)"
  unmerged_content=""
  if [ -n "$unmerged_paths" ]; then
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      if [ -f "$repo/$path" ]; then
        # hash-object needs a filesystem path; -C does not re-root relative paths.
        blob="$(git -C "$repo" hash-object -- "$repo/$path" 2>/dev/null || echo missing)"
      else
        blob="missing"
      fi
      unmerged_content="${unmerged_content}${path}=${blob};"
    done <<EOF
$unmerged_paths
EOF
  fi
  unmerged_content="$(printf '%s' "$unmerged_content" | shasum -a 256 | awk '{print $1}')"

  printf 'onto=%s;orig=%s;stopped=%s;head_name=%s;rebase_head=%s;index_tree=%s;porcelain=%s;unmerged=%s\n' \
    "$onto" "$orig" "$stopped" "$head_name" "$rebase_head" "$index_tree" "$porcelain" "$unmerged_content"
}

vault_sync_op_record_conflict_identity() {
  local repo="$1" op_id="$2"
  local fp
  fp="$(vault_sync_op_fingerprint_repo_state "$repo")" || return 1
  vault_sync_op_set_field "$repo" "$op_id" "conflict_identity" "$fp"
}

vault_sync_op_conflict_identity_unchanged() {
  local repo="$1" op_id="$2"
  local expected actual
  expected="$(vault_sync_op_get_field "$repo" "$op_id" "conflict_identity")" || return 1
  [ -n "$expected" ] || return 1
  actual="$(vault_sync_op_fingerprint_repo_state "$repo")" || return 1
  [ "$expected" = "$actual" ]
}

vault_sync_op_may_retry() {
  local repo="$1" op_id="$2" live_remote_oid="$3"
  local phase retry handoff target fp onto

  phase="$(vault_sync_op_get_field "$repo" "$op_id" phase)" || return 1
  retry="$(vault_sync_op_get_field "$repo" "$op_id" retry_count)" || return 1
  handoff="$(vault_sync_op_get_field "$repo" "$op_id" handoff)" || return 1
  target="$(vault_sync_op_get_field "$repo" "$op_id" target_oid)" || return 1

  # Fail closed: only one retry, never after handoff.
  [ "$handoff" = "0" ] || return 1
  [ "$retry" = "0" ] || return 1
  case "$phase" in
    rebasing|retrying) ;;
    *) return 1 ;;
  esac
  [ -n "$live_remote_oid" ] && [ "$live_remote_oid" != "$target" ] || return 1

  # Require stable conflict identity (empty / no sequencer → fail closed).
  vault_sync_op_conflict_identity_unchanged "$repo" "$op_id" || return 1

  # Journal ownership of sequencer: onto must match journaled target.
  fp="$(vault_sync_op_get_field "$repo" "$op_id" conflict_identity)" || return 1
  onto="$(printf '%s' "$fp" | sed -n 's/.*onto=\([^;]*\).*/\1/p')"
  [ -n "$onto" ] && [ "$onto" = "$target" ] || return 1
  return 0
}

vault_sync_op_mark_review_required() {
  vault_sync_op_set_phase "$1" "$2" "review-required" || return 1
  vault_sync_op_set_field "$1" "$2" "handoff" "1" || return 1
  vault_sync_op_set_field "$1" "$2" "reason" "$3"
}

vault_sync_op_close_complete() {
  vault_sync_op_set_phase "$1" "$2" "complete" || return 1
  vault_sync_op_set_field "$1" "$2" "handoff" "1"
}

# Dirty-state helpers used by pull integration
vault_sync_op_write_inventory() {
  local repo="$1" out="$2"
  {
    echo "# staged"
    git -C "$repo" diff --cached --name-only
    echo "# tracked"
    git -C "$repo" diff --name-only
    echo "# untracked"
    git -C "$repo" ls-files --others --exclude-standard
  } >"$out"
}

vault_sync_op_stash_push_owned() {
  # Usage: vault_sync_op_stash_push_owned <repo> <message> <include_untracked:0|1>
  # Prints stash OID on stdout; returns 0 on success.
  local repo="$1" msg="$2" include_u="$3"
  local after

  if [ "$include_u" = "1" ]; then
    git -C "$repo" stash push -u -m "$msg" >/dev/null 2>&1 || return 1
  else
    git -C "$repo" stash push -m "$msg" >/dev/null 2>&1 || return 1
  fi
  after="$(git -C "$repo" rev-parse -q --verify refs/stash 2>/dev/null || true)"
  [ -n "$after" ] || return 1
  printf '%s\n' "$after"
}

vault_sync_op_stash_apply_owned() {
  local repo="$1" oid="$2"
  git -C "$repo" stash apply "$oid"
}

vault_sync_op_stash_drop_owned() {
  # Drop only the stash list entry that still resolves to oid.
  # Bash 3.2-safe: avoid process substitution.
  local repo="$1" oid="$2"
  local entry sha list

  list="$(git -C "$repo" stash list --format='%gd' 2>/dev/null || true)"
  [ -n "$list" ] || return 1
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    sha="$(git -C "$repo" rev-parse "$entry" 2>/dev/null || true)"
    if [ "$sha" = "$oid" ]; then
      git -C "$repo" stash drop "$entry"
      return $?
    fi
  done <<EOF
$list
EOF
  return 1
}
