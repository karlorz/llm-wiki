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
  vault_sync_op_set_fields "$repo" "$op_id" "$key" "$value"
}

# Batch journal field updates in one rewrite.
# Usage: vault_sync_op_set_fields <repo> <op_id> <key> <value> [<key> <value> ...]
vault_sync_op_set_fields() {
  local repo="$1" op_id="$2"
  shift 2
  local file tmp updates source
  file="$(vault_sync_op_journal_path "$repo" "$op_id")" || return 1
  tmp="$(mktemp)" || return 1
  updates="$(mktemp)" || { rm -f "$tmp"; return 1; }
  while [ "$#" -ge 2 ]; do
    printf '%s=%s\n' "$1" "$2" >>"$updates" || { rm -f "$tmp" "$updates"; return 1; }
    shift 2
  done
  source="$file"
  [ -f "$source" ] || source=/dev/null
  awk -F= '
    FNR==NR {
      key=$1
      if (!(key in replacement)) order[++count]=key
      replacement[key]=substr($0, index($0,"=")+1)
      next
    }
    {
      key=$1
      if (key in replacement) {
        print key"="replacement[key]
        seen[key]=1
        next
      }
      print
    }
    END {
      for (i=1; i<=count; i++) {
        key=order[i]
        if (!(key in seen)) print key"="replacement[key]
      }
    }
  ' "$updates" "$source" >"$tmp" || { rm -f "$tmp" "$updates"; return 1; }
  rm -f "$updates"
  mv "$tmp" "$file"
}

vault_sync_op_set_phase() {
  vault_sync_op_set_field "$1" "$2" "phase" "$3"
}

vault_sync_op_create_recovery_refs() {
  local repo="$1" op_id="$2" original_head="$3" target_oid="$4"

  # Prefer transactional create (CAS: fail if ref already exists).
  if git -C "$repo" update-ref --stdin --create-reflog -m "vault-sync operation begin" >/dev/null 2>&1 <<EOF
start
create refs/vault-sync/recovery/${op_id}/original-head ${original_head}
create refs/vault-sync/recovery/${op_id}/target ${target_oid}
prepare
commit
EOF
  then
    return 0
  fi

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

# CAS-update the recovery target ref: only succeeds if current value is expected_old.
vault_sync_op_cas_recovery_target() {
  local repo="$1" op_id="$2" new_oid="$3" expected_old="$4"
  if git -C "$repo" update-ref \
    "refs/vault-sync/recovery/${op_id}/target" "$new_oid" "$expected_old" 2>/dev/null; then
    return 0
  fi
  return 1
}


vault_sync_op_begin() {
  local repo="$1" op_id="$2" branch="$3" original_head="$4" target_oid="$5"
  local lock_identity="$6" helper_version="$7" runtime_hash="$8"
  local dir file worktree_path worktree_git_dir
  dir="$(vault_sync_op_journal_dir "$repo")" || return 1
  mkdir -p "$dir" || return 1
  file="$(vault_sync_op_journal_path "$repo" "$op_id")" || return 1
  if [ -f "$file" ]; then
    return 1
  fi
  if ! vault_sync_op_create_recovery_refs "$repo" "$op_id" "$original_head" "$target_oid"; then
    return 1
  fi
  worktree_path="$(cd "$repo" && pwd -P)" || return 1
  worktree_git_dir="$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
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
worktree_path=${worktree_path}
worktree_git_dir=${worktree_git_dir}
EOF
  return 0
}

vault_sync_op_find_review_required() {
  local repo="$1" current_git_dir jdir jf op_id phase handoff journal_git_dir
  current_git_dir="$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  jdir="$(vault_sync_op_journal_dir "$repo")" || return 1
  [ -d "$jdir" ] || return 1

  for jf in "$jdir"/*.env; do
    [ -f "$jf" ] || continue
    op_id="$(basename "$jf" .env)"
    phase="$(vault_sync_op_get_field "$repo" "$op_id" phase 2>/dev/null || true)"
    handoff="$(vault_sync_op_get_field "$repo" "$op_id" handoff 2>/dev/null || true)"
    [ "$phase" = "review-required" ] && [ "$handoff" = "1" ] || continue
    journal_git_dir="$(vault_sync_op_get_field "$repo" "$op_id" worktree_git_dir 2>/dev/null || true)"
    if [ -z "$journal_git_dir" ] || [ "$journal_git_dir" = "$current_git_dir" ]; then
      printf '%s\n' "$op_id"
      return 0
    fi
  done
  return 1
}

# Mark one obsolete review-required handoff complete while preserving its audit
# trail. Caller must establish that no live owner is mutating the journal.
vault_sync_op_mark_superseded_stale_review_required() {
  local repo="$1" op_id="$2" by="${3:-vault-sync-managed-preflight}"
  local reason="$4" prior_reason="$5" now
  if [ -z "$prior_reason" ] && [ -n "$reason" ] && [ "$reason" != "superseded-stale-review-required" ]; then
    prior_reason="$reason"
  fi
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)"
  vault_sync_op_set_fields "$repo" "$op_id" \
    "phase" "complete" \
    "handoff" "1" \
    "reason" "superseded-stale-review-required" \
    "prior_reason" "$prior_reason" \
    "superseded_at" "$now" \
    "cleared_by" "$by" \
    "cleared_reason" "operator-or-preflight $now"
}

# Auto-supersede review-required handoffs whose target is already an ancestor
# of HEAD. Unrelated dirty WIP is preserved; active sequencers and unmerged
# paths fail closed. Returns nonzero while any applicable handoff remains open.
vault_sync_op_supersede_stale_review_required() {
  local repo="$1" by="${2:-vault-sync-managed-preflight}"
  local current_git_dir git_dir unmerged jdir jf op_id phase handoff journal_git_dir target unresolved
  local reason prior_reason key value

  current_git_dir="$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  git_dir="$current_git_dir"
  if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] \
    || [ -f "$git_dir/MERGE_HEAD" ] || [ -f "$git_dir/CHERRY_PICK_HEAD" ] \
    || [ -f "$git_dir/REVERT_HEAD" ]; then
    return 1
  fi
  unmerged="$(git -C "$repo" ls-files -u 2>/dev/null | head -1 || true)"
  [ -z "$unmerged" ] || return 1

  jdir="$(vault_sync_op_journal_dir "$repo")" || return 1
  [ -d "$jdir" ] || return 0
  unresolved=""
  for jf in "$jdir"/*.env; do
    [ -f "$jf" ] || continue
    op_id="$(basename "$jf" .env)"
    phase=""
    handoff=""
    journal_git_dir=""
    target=""
    reason=""
    prior_reason=""
    while IFS='=' read -r key value; do
      case "$key" in
        phase) phase="$value" ;;
        handoff) handoff="$value" ;;
        worktree_git_dir) journal_git_dir="$value" ;;
        target_oid) target="$value" ;;
        reason) reason="$value" ;;
        prior_reason) prior_reason="$value" ;;
      esac
    done <"$jf"
    [ "$phase" = "review-required" ] && [ "$handoff" = "1" ] || continue
    if [ -n "$journal_git_dir" ] && [ "$journal_git_dir" != "$current_git_dir" ]; then
      continue
    fi
    if [ -z "$target" ]; then
      [ -n "$unresolved" ] || unresolved="$op_id"
      continue
    fi
    if git -C "$repo" merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
      vault_sync_op_mark_superseded_stale_review_required \
        "$repo" "$op_id" "$by" "$reason" "$prior_reason" || return 1
    else
      [ -n "$unresolved" ] || unresolved="$op_id"
    fi
  done
  [ -z "$unresolved" ]
}

vault_sync_op_preflight_blocker() {
  local repo="$1" unmerged op_id git_dir
  unmerged="$(git -C "$repo" diff --name-only --diff-filter=U 2>/dev/null || true)"
  if [ -n "$unmerged" ]; then
    op_id="$(vault_sync_op_find_review_required "$repo" 2>/dev/null || true)"
    printf 'unmerged-paths\t%s\n' "$op_id"
    return 0
  fi

  git_dir="$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  if [ -f "$git_dir/MERGE_HEAD" ] || [ -f "$git_dir/CHERRY_PICK_HEAD" ] || [ -f "$git_dir/REVERT_HEAD" ]; then
    printf 'git-operation-in-progress\t\n'
    return 0
  fi

  op_id="$(vault_sync_op_find_review_required "$repo" 2>/dev/null || true)"
  if [ -n "$op_id" ]; then
    printf 'review-required\t%s\n' "$op_id"
    return 0
  fi
  return 1
}

vault_sync_op_record_stash() {
  vault_sync_op_set_fields "$1" "$2" \
    "owned_stash_oid" "$3" \
    "preservation_scope" "$4"
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

# Load common may_retry fields from one journal file read.
vault_sync_op_load_retry_fields() {
  local repo="$1" op_id="$2"
  local file
  file="$(vault_sync_op_journal_path "$repo" "$op_id")" || return 1
  [ -f "$file" ] || return 1
  # shellcheck disable=SC2034
  eval "$(awk -F= '
    $1=="phase" || $1=="retry_count" || $1=="handoff" || $1=="target_oid" || $1=="conflict_identity" {
      key=$1
      val=substr($0, index($0,"=")+1)
      gsub(/'\''/, "'\''\\'\'''\''", val)
      printf "_vs_jf_%s='\''%s'\''\n", key, val
    }
  ' "$file")"
}

vault_sync_op_may_retry() {
  local repo="$1" op_id="$2" live_remote_oid="$3"
  local phase retry handoff target fp onto actual

  _vs_jf_phase=""
  _vs_jf_retry_count=""
  _vs_jf_handoff=""
  _vs_jf_target_oid=""
  _vs_jf_conflict_identity=""
  vault_sync_op_load_retry_fields "$repo" "$op_id" || return 1
  phase="${_vs_jf_phase}"
  retry="${_vs_jf_retry_count}"
  handoff="${_vs_jf_handoff}"
  target="${_vs_jf_target_oid}"
  fp="${_vs_jf_conflict_identity}"

  # Fail closed: only one retry, never after handoff.
  [ "$handoff" = "0" ] || return 1
  [ "$retry" = "0" ] || return 1
  case "$phase" in
    rebasing|retrying) ;;
    *) return 1 ;;
  esac
  [ -n "$live_remote_oid" ] && [ "$live_remote_oid" != "$target" ] || return 1

  # Require stable conflict identity (empty / no sequencer → fail closed).
  [ -n "$fp" ] || return 1
  actual="$(vault_sync_op_fingerprint_repo_state "$repo")" || return 1
  [ "$fp" = "$actual" ] || return 1

  # Journal ownership of sequencer: onto must match journaled target.
  onto="$(printf '%s' "$fp" | sed -n 's/.*onto=\([^;]*\).*/\1/p')"
  [ -n "$onto" ] && [ "$onto" = "$target" ] || return 1
  return 0
}

vault_sync_op_mark_review_required() {
  vault_sync_op_set_fields "$1" "$2" \
    "phase" "review-required" \
    "handoff" "1" \
    "reason" "$3"
}

vault_sync_op_close_complete() {
  vault_sync_op_set_fields "$1" "$2" \
    "phase" "complete" \
    "handoff" "1"
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

# Verify inventory after owned-stash apply.
# - tracked/staged paths that are blobs in the stash tree must reappear.
# - When skip_content_paths is non-empty (newline-separated), those paths only
#   require presence (post-conflict auto-resolve may legitimately change content).
# - Other tracked paths must content-match the stash blob.
# - untracked inventory paths must reappear (and content-match untracked tree when present).
# Fail closed on any mismatch.
vault_sync_op_verify_inventory() {
  local repo="$1" op_id="$2" stash_oid="${3:-}" skip_content_paths="${4:-}"
  local inv section path expected_hash actual_hash unmerged skip has_u3

  inv="$(vault_sync_op_get_field "$repo" "$op_id" inventory_path)" || return 1
  [ -f "$inv" ] || return 1

  unmerged="$(git -C "$repo" diff --name-only --diff-filter=U 2>/dev/null || true)"
  has_u3=0
  if [ -n "$stash_oid" ] && git -C "$repo" rev-parse -q --verify "${stash_oid}^3" >/dev/null 2>&1; then
    has_u3=1
  fi
  section=""
  while IFS= read -r path || [ -n "$path" ]; do
    case "$path" in
      "# staged") section="staged"; continue ;;
      "# tracked") section="tracked"; continue ;;
      "# untracked") section="untracked"; continue ;;
      ""|\#*) continue ;;
    esac
    [ -n "$path" ] || continue
    [ -n "$section" ] || continue

    # Skip content checks for currently-unmerged conflict paths.
    if printf '%s\n' "$unmerged" | grep -Fxq -- "$path"; then
      continue
    fi

    skip=0
    if [ -n "$skip_content_paths" ] && printf '%s\n' "$skip_content_paths" | grep -Fxq -- "$path"; then
      skip=1
    fi

    case "$section" in
      staged|tracked)
        if [ -n "$stash_oid" ] && git -C "$repo" cat-file -e "$stash_oid:$path" 2>/dev/null; then
          if [ ! -f "$repo/$path" ] && [ ! -L "$repo/$path" ]; then
            return 1
          fi
          if [ "$skip" -eq 0 ]; then
            expected_hash="$(git -C "$repo" rev-parse "$stash_oid:$path" 2>/dev/null || echo missing)"
            actual_hash="$(git -C "$repo" hash-object -- "$repo/$path" 2>/dev/null || echo missing)"
            [ "$expected_hash" = "$actual_hash" ] || return 1
          fi
        fi
        ;;
      untracked)
        if [ ! -e "$repo/$path" ] && [ ! -L "$repo/$path" ]; then
          return 1
        fi
        if [ "$skip" -eq 0 ] && [ "$has_u3" -eq 1 ]; then
          if git -C "$repo" cat-file -e "${stash_oid}^3:$path" 2>/dev/null; then
            expected_hash="$(git -C "$repo" rev-parse "${stash_oid}^3:$path" 2>/dev/null || echo missing)"
            if [ -f "$repo/$path" ]; then
              actual_hash="$(git -C "$repo" hash-object -- "$repo/$path" 2>/dev/null || echo missing)"
              [ "$expected_hash" = "$actual_hash" ] || return 1
            fi
          fi
        fi
        ;;
    esac
  done <"$inv"
  return 0
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
