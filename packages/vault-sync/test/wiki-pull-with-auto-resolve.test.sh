#!/bin/bash
# Regression tests for packages/vault-sync/scripts/wiki-pull-with-auto-resolve.sh.

set -u

SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/scripts/wiki-pull-with-auto-resolve.sh"
PASS=0
FAIL=0

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected '%s', got '%s'\n" "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

git_commit() {
  local repo="$1" msg="$2"
  git -C "$repo" add -A >/dev/null
  git -C "$repo" -c user.name=test -c user.email=test@test commit -m "$msg" >/dev/null
}

make_repo() {
  local root="$1"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  git init --bare "$remote" >/dev/null
  mkdir -p "$vault"
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null
  printf '%s\n' "$vault"
}

add_remote_commit() {
  local root="$1"
  local file="$2"
  local content="$3"
  local msg="$4"
  local remote_work="$root/remote-work-$msg"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  mkdir -p "$remote_work/$(dirname "$file")"
  printf '%s\n' "$content" > "$remote_work/$file"
  git_commit "$remote_work" "$msg"
  git -C "$remote_work" push origin main >/dev/null
}

test_dirty_tree_pull_restores_edit() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  add_remote_commit "$root" "remote.md" "remote" "remote"
  printf 'local dirty\n' > "$vault/note.md"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "dirty-tree pull exits successfully" "$rc" "0"
  assert_eq "local branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
  assert_eq "dirty tracked edit is restored" "$(cat "$vault/note.md")" "local dirty"
  assert_eq "remote commit is present" "$(cat "$vault/remote.md" 2>/dev/null || true)" "remote"

  rm -rf "$root"
}

test_stale_rebase_state_is_cleaned_before_pull() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  add_remote_commit "$root" "remote.md" "remote" "remote-stale"
  mkdir -p "$vault/.git/rebase-merge"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "stale rebase cleanup exits successfully" "$rc" "0"
  assert_eq "stale rebase directory removed" "$(test -d "$vault/.git/rebase-merge" && echo present || echo absent)" "absent"
  assert_eq "stale-cleaned branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
  assert_eq "remote commit after stale cleanup is present" "$(cat "$vault/remote.md" 2>/dev/null || true)" "remote"

  rm -rf "$root"
}

test_untracked_remote_duplicate_is_removed_before_pull() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  mkdir -p "$vault/projects/demo"
  printf 'promoted by s3\n' > "$vault/projects/demo/new-note.md"
  add_remote_commit "$root" "projects/demo/new-note.md" "promoted by s3" "remote-s3-note"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "untracked duplicate pull exits successfully" "$rc" "0"
  assert_eq "untracked duplicate branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
  assert_eq "promoted note is present after pull" "$(cat "$vault/projects/demo/new-note.md" 2>/dev/null || true)" "promoted by s3"
  assert_eq "worktree is clean after duplicate removal" "$(git -C "$vault" status --porcelain | wc -l | tr -d ' ')" "0"

  rm -rf "$root"
}

test_divergent_untracked_remote_overlap_is_preserved_before_pull() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  mkdir -p "$vault/projects/demo"
  printf 'local draft\n' > "$vault/projects/demo/new-note.md"
  add_remote_commit "$root" "projects/demo/new-note.md" "remote snapshot" "remote-s3-divergent-note"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  local preserved_count preserved_content
  preserved_count="$(find "$home" -type f -path '*/vault-sync/untracked-collisions/*/projects/demo/new-note.md' 2>/dev/null | wc -l | tr -d ' ')"
  preserved_content="$(find "$home" -type f -path '*/vault-sync/untracked-collisions/*/projects/demo/new-note.md' -exec cat {} \; 2>/dev/null)"

  assert_eq "divergent untracked overlap pull exits successfully" "$rc" "0"
  assert_eq "divergent overlap branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
  assert_eq "remote snapshot wins in active worktree" "$(cat "$vault/projects/demo/new-note.md" 2>/dev/null || true)" "remote snapshot"
  assert_eq "local divergent draft is preserved once" "$preserved_count" "1"
  assert_eq "preserved divergent draft keeps local content" "$preserved_content" "local draft"
  assert_eq "worktree is clean after preserving divergent overlap" "$(git -C "$vault" status --porcelain | wc -l | tr -d ' ')" "0"

  rm -rf "$root"
}

test_non_archive_log_append_conflict_is_union_resolved() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  printf 'base log\n' > "$vault/log.md"
  git_commit "$vault" "add log"
  git -C "$vault" push origin main >/dev/null

  printf 'base log\nremote log entry\n' > "$root/remote-log-content"
  add_remote_commit "$root" "log.md" "$(cat "$root/remote-log-content")" "remote-log-append"

  printf 'base log\nlocal log entry\n' > "$vault/log.md"
  git_commit "$vault" "dev-loop: local log append"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "non-archive log append pull exits successfully" "$rc" "0"
  assert_eq "non-archive log append branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
  assert_eq "remote log entry is preserved" "$(grep -c 'remote log entry' "$vault/log.md" | tr -d ' ')" "1"
  assert_eq "local log entry is preserved" "$(grep -c 'local log entry' "$vault/log.md" | tr -d ' ')" "1"
  assert_eq "log conflict markers absent" "$(grep -Ec '^(<<<<<<<|=======|>>>>>>>)' "$vault/log.md" | tr -d ' ')" "0"

  rm -rf "$root"
}

test_mixed_log_and_non_log_conflict_falls_through_safely() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  printf 'base log\n' > "$vault/log.md"
  printf 'base note\n' > "$vault/note.md"
  git_commit "$vault" "add log and note"
  git -C "$vault" push origin main >/dev/null

  add_remote_commit "$root" "log.md" "base log
remote log entry" "remote-log-append"
  add_remote_commit "$root" "note.md" "base note
remote note change" "remote-note-edit"

  printf 'base log\nlocal log entry\n' > "$vault/log.md"
  printf 'base note\nlocal note change\n' > "$vault/note.md"
  git_commit "$vault" "dev-loop: local appends"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  # Non-archive commit with mixed log+non-log conflict must surface as
  # MANUAL-RESOLVE-NEEDED (exit 1), not silently union-merge log.md while
  # leaving note.md conflicted. The union resolver must decline the whole
  # set when any path is not a log.md.
  assert_eq "mixed log+non-log conflict surfaces as manual" "$rc" "1"
  assert_eq "log.md left conflicted (not partially union-merged)" "$(git -C "$vault" status --short log.md | cut -c1-2)" "UU"
  assert_eq "note.md left conflicted" "$(git -C "$vault" status --short note.md | cut -c1-2)" "UU"

  rm -rf "$root"
}

test_pull_fails_if_tracked_markdown_contains_conflict_markers() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  add_remote_commit "$root" "bad.md" "<<<<<<< HEAD
remote side
=======
local side
>>>>>>> branch" "remote-conflict-marker-content"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "pull with tracked conflict markers fails" "$rc" "1"
  assert_eq "conflict marker file is present for inspection" "$(test -f "$vault/bad.md" && echo present || echo absent)" "present"

  rm -rf "$root"
}

test_pull_allows_markdown_equals_separator() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  add_remote_commit "$root" "separator.md" "$(printf 'Heading\n\n%s\n\nnot a conflict block\n' '=======')" "remote-separator-content"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "pull with standalone separator exits successfully" "$rc" "0"
  assert_eq "separator file is present" "$(test -f "$vault/separator.md" && echo present || echo absent)" "present"

  rm -rf "$root"
}

test_stash_pop_regenerates_project_knowledge_conflict() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  mkdir -p "$vault/projects/demo/requirements"
  cat > "$vault/projects/demo/knowledge.md" <<'EOF'
# Knowledge Index: demo

Autogenerated by `skillwiki project-index` on 2026-07-08.

## requirement

- [[projects/demo/requirements/base]] — Base Report
EOF
  cat > "$vault/projects/demo/requirements/base.md" <<'EOF'
---
title: Base Report
---

# Base Report
EOF
  git_commit "$vault" "add demo knowledge"
  git -C "$vault" push origin main >/dev/null

  local remote_work="$root/remote-work-knowledge"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  cat > "$remote_work/projects/demo/requirements/remote.md" <<'EOF'
---
title: Remote Report
---

# Remote Report
EOF
  cat > "$remote_work/projects/demo/knowledge.md" <<'EOF'
# Knowledge Index: demo

Autogenerated by `skillwiki project-index` on 2026-07-08.

## requirement

- [[projects/demo/requirements/base]] — Base Report
- [[projects/demo/requirements/remote]] — Remote Report
EOF
  git_commit "$remote_work" "remote generated knowledge"
  git -C "$remote_work" push origin main >/dev/null

  cat > "$vault/projects/demo/requirements/local.md" <<'EOF'
---
title: Local Report
---

# Local Report
EOF
  cat > "$vault/projects/demo/knowledge.md" <<'EOF'
# Knowledge Index: demo

Autogenerated by `skillwiki project-index` on 2026-07-08.

## requirement

- [[projects/demo/requirements/base]] — Base Report
- [[projects/demo/requirements/local]] — Local Report
EOF

  local stub_bin="$root/bin"
  mkdir -p "$stub_bin"
  cat > "$stub_bin/skillwiki" <<'EOF'
#!/bin/bash
set -eu
if [ "$1" != "project-index" ]; then
  exit 2
fi
slug="$2"
vault="$3"
out="$vault/projects/$slug/knowledge.md"
{
  printf '# Knowledge Index: %s\n\n' "$slug"
  printf 'Autogenerated by `skillwiki project-index` on 2026-07-08.\n\n'
  printf '## requirement\n\n'
  for f in "$vault/projects/$slug/requirements"/*.md; do
    [ -e "$f" ] || continue
    base="${f%.md}"
    rel="${base#$vault/}"
    title="$(awk '
      /^title:/ {
        sub(/^title:[[:space:]]*/, "");
        gsub(/^"|"$/, "");
        print;
        exit
      }
    ' "$f")"
    [ -n "$title" ] || title="$(basename "$base")"
    printf -- '- [[%s]] — %s\n' "$rel" "$title"
  done
} > "$out"
EOF
  chmod +x "$stub_bin/skillwiki"

  HOME="$home" PATH="$stub_bin:$PATH" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "generated knowledge stash-pop conflict exits successfully" "$rc" "0"
  assert_eq "generated knowledge branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
  assert_eq "remote generated entry is preserved" "$(grep -c 'Remote Report' "$vault/projects/demo/knowledge.md" | tr -d ' ')" "1"
  assert_eq "local generated entry is preserved" "$(grep -c 'Local Report' "$vault/projects/demo/knowledge.md" | tr -d ' ')" "1"
  assert_eq "generated knowledge conflict markers absent" "$(grep -Ec '^(<<<<<<<|=======|>>>>>>>)' "$vault/projects/demo/knowledge.md" | tr -d ' ')" "0"
  assert_eq "generated knowledge worktree has no unmerged paths" "$(git -C "$vault" diff --name-only --diff-filter=U | wc -l | tr -d ' ')" "0"

  rm -rf "$root"
}


test_stale_sequencer_preserves_advanced_tip() {
  # Reproduce 2026-07-11: orig-head at A, tip advanced to B, clean worktree,
  # leftover rebase-merge. Cleanup must keep B (not abort-reset to A).
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  local commit_a commit_b
  commit_a="$(git -C "$vault" rev-parse HEAD)"

  printf 'local advance\n' > "$vault/local-advance.md"
  git_commit "$vault" "local tip advance"
  commit_b="$(git -C "$vault" rev-parse HEAD)"

  add_remote_commit "$root" "remote.md" "remote" "remote-after-stale"

  # Fabricate stale sequencer: orig-head=A, tip=B, clean tree.
  mkdir -p "$vault/.git/rebase-merge"
  printf '%s\n' "$commit_a" > "$vault/.git/rebase-merge/orig-head"
  printf 'refs/heads/main\n' > "$vault/.git/rebase-merge/head-name"
  printf '%s\n' "$commit_a" > "$vault/.git/rebase-merge/onto"

  local tip_before
  tip_before="$(git -C "$vault" rev-parse HEAD)"
  assert_eq "precondition tip is B" "$tip_before" "$commit_b"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  local tip_after
  tip_after="$(git -C "$vault" rev-parse HEAD)"

  assert_eq "stale sequencer cleanup exits successfully" "$rc" "0"
  assert_eq "stale sequencer directory removed" "$(test -d "$vault/.git/rebase-merge" && echo present || echo absent)" "absent"
  assert_eq "advanced tip content preserved" "$(test -f "$vault/local-advance.md" && echo present || echo absent)" "present"
  assert_eq "tip is not reset to orig-head A" "$( [ "$tip_after" = "$commit_a" ] && echo reset_to_a || echo kept )" "kept"
  assert_eq "remote commit integrated" "$(cat "$vault/remote.md" 2>/dev/null || true)" "remote"
  local recovery_count
  recovery_count="$(git -C "$vault" for-each-ref --format='%(refname)' refs/vault-sync/recovery/ 2>/dev/null | wc -l | tr -d ' ')"
  assert_eq "recovery ref created" "$( [ "$recovery_count" -ge 1 ] && echo yes || echo no )" "yes"

  rm -rf "$root"
}

test_active_rebase_is_refused() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  printf 'base\n' > "$vault/conflict.md"
  git_commit "$vault" "add conflict base"
  git -C "$vault" push origin main >/dev/null

  local remote_work="$root/remote-active"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  printf 'base\nremote line\n' > "$remote_work/conflict.md"
  git_commit "$remote_work" "remote conflict edit"
  git -C "$remote_work" push origin main >/dev/null

  printf 'base\nlocal line\n' > "$vault/conflict.md"
  git_commit "$vault" "local conflict edit"

  git -C "$vault" fetch origin >/dev/null 2>&1
  # Intentionally ignore rebase failure (expected conflict); do NOT enable set -e.
  git -C "$vault" rebase origin/main >/dev/null 2>&1 || true

  local rebase_head_before unmerged_before
  rebase_head_before="$(git -C "$vault" rev-parse REBASE_HEAD 2>/dev/null || echo none)"
  unmerged_before="$(git -C "$vault" diff --name-only --diff-filter=U | tr '\n' ' ' | sed 's/ *$//')"

  assert_eq "precondition has REBASE_HEAD" "$( [ "$rebase_head_before" != "none" ] && echo yes || echo no )" "yes"
  assert_eq "precondition has UU path" "$(echo "$unmerged_before" | grep -c conflict.md | tr -d ' ')" "1"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  local rebase_head_after unmerged_after
  rebase_head_after="$(git -C "$vault" rev-parse REBASE_HEAD 2>/dev/null || echo none)"
  unmerged_after="$(git -C "$vault" diff --name-only --diff-filter=U | tr '\n' ' ' | sed 's/ *$//')"

  assert_eq "active rebase refusal exits nonzero" "$rc" "1"
  assert_eq "REBASE_HEAD unchanged" "$rebase_head_after" "$rebase_head_before"
  assert_eq "unmerged path unchanged" "$unmerged_after" "$unmerged_before"
  assert_eq "rebase-merge still present" "$(test -d "$vault/.git/rebase-merge" && echo present || echo absent)" "present"

  git -C "$vault" rebase --abort >/dev/null 2>&1 || true
  rm -rf "$root"
}

test_snapshot_materialized_commit_is_dropped_without_log_dup() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  mkdir -p "$vault/projects/demo/work/2026-07-11-item"
  printf '# base log\n\n' > "$vault/log.md"
  git_commit "$vault" "seed log"
  git -C "$vault" push origin main >/dev/null

  cat > "$vault/projects/demo/work/2026-07-11-item/spec.md" <<'EOF'
---
title: Item
status: in-progress
---

# Item
EOF
  cat > "$vault/log.md" <<'EOF'
# base log

## 2026-07-11 local work

Local authored section body.
EOF
  git_commit "$vault" "dev-loop: local work item"
  local local_sha
  local_sha="$(git -C "$vault" rev-parse HEAD)"

  local remote_work="$root/remote-snap"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  mkdir -p "$remote_work/projects/demo/work/2026-07-11-item"
  cat > "$remote_work/projects/demo/work/2026-07-11-item/spec.md" <<'EOF'
---
title: Item
status: in-progress
---

# Item
EOF
  cat > "$remote_work/log.md" <<'EOF'
# base log

## 2026-07-11 local work

Local authored section body.

## 2026-07-11 remote snapshot

Remote-only section.
EOF
  git_commit "$remote_work" "Snapshot 2026-07-11T12:00:00Z"
  git -C "$remote_work" push origin main >/dev/null

  # Precondition: materialization proof must succeed against remote tip (drives real helper).
  git -C "$vault" fetch origin main >/dev/null 2>&1
  # shellcheck source=/dev/null
  . "$(cd "$(dirname "$SCRIPT_UNDER_TEST")" && pwd)/lib/git-materialization.sh"
  if vault_sync_commit_materialized "$local_sha" "origin/main" "$vault"; then
    assert_eq "precondition local commit is fully materialized on origin/main" "proven" "proven"
  else
    assert_eq "precondition local commit is fully materialized on origin/main" "not_proven" "proven"
  fi

  # Capture pull log path used by platform helper under HOME
  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  local left_right local_section_count remote_section_count pull_log drop_lines
  left_right="$(git -C "$vault" rev-list --left-right --count HEAD...origin/main 2>/dev/null || echo 'err')"
  local_section_count="$(grep -c 'Local authored section body' "$vault/log.md" | tr -d ' ')"
  remote_section_count="$(grep -c 'Remote-only section' "$vault/log.md" | tr -d ' ')"
  pull_log="$(find "$home" -type f -name 'wiki-pull.log' 2>/dev/null | head -1)"
  drop_lines=0
  if [ -n "$pull_log" ] && [ -f "$pull_log" ]; then
    drop_lines="$(grep -c "DROP materialized commit $local_sha" "$pull_log" 2>/dev/null | tr -d ' ')"
  fi

  assert_eq "materialized pull exits successfully" "$rc" "0"
  assert_eq "no local/remote content divergence (ahead behind)" "$left_right" $'0\t0'
  assert_eq "local log section once" "$local_section_count" "1"
  assert_eq "remote log section once" "$remote_section_count" "1"
  assert_eq "work item present" "$(test -f "$vault/projects/demo/work/2026-07-11-item/spec.md" && echo present || echo absent)" "present"
  assert_eq "no conflict markers in log" "$(grep -Ec '^(<<<<<<<|=======|>>>>>>>)' "$vault/log.md" | tr -d ' ')" "0"
  # Require the materialization drop path — log-union alone must not satisfy this fixture.
  assert_eq "pull log records DROP materialized for local commit" "$( [ "${drop_lines:-0}" -ge 1 ] && echo yes || echo no )" "yes"
  # Dropped commit must not remain as an ancestor of HEAD (rebase todo omitted it).
  assert_eq "local commit not replayed onto HEAD" \
    "$(git -C "$vault" merge-base --is-ancestor "$local_sha" HEAD 2>/dev/null && echo ancestor || echo dropped)" \
    "dropped"
  assert_eq "HEAD equals origin/main after drop" \
    "$(git -C "$vault" rev-parse HEAD)" \
    "$(git -C "$vault" rev-parse origin/main)"

  rm -rf "$root"
}


test_partial_match_commit_is_not_dropped() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  mkdir -p "$vault/projects/demo"
  printf '# base log\n\n' > "$vault/log.md"
  printf 'shared\n' > "$vault/projects/demo/same.md"
  printf 'local-only-base\n' > "$vault/projects/demo/diff.md"
  git_commit "$vault" "seed partial"
  git -C "$vault" push origin main >/dev/null

  printf 'shared\n' > "$vault/projects/demo/same.md"
  printf 'local unique body\n' > "$vault/projects/demo/diff.md"
  cat > "$vault/log.md" <<'EOF'
# base log

## 2026-07-11 partial

Full local section that remote will only half-match.
EOF
  git_commit "$vault" "dev-loop: partial local"

  local remote_work="$root/remote-partial"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  mkdir -p "$remote_work/projects/demo"
  printf 'shared\n' > "$remote_work/projects/demo/same.md"
  printf 'remote unique body\n' > "$remote_work/projects/demo/diff.md"
  cat > "$remote_work/log.md" <<'EOF'
# base log

## 2026-07-11 partial

Full local section that remote will only
EOF
  git_commit "$remote_work" "Snapshot partial remote"
  git -C "$remote_work" push origin main >/dev/null

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  local has_local_unique left_right
  has_local_unique="$(grep -c 'local unique body' "$vault/projects/demo/diff.md" 2>/dev/null | tr -d ' ')"
  left_right="$(git -C "$vault" rev-list --left-right --count HEAD...origin/main 2>/dev/null || echo 'x')"

  if [ "$rc" -eq 0 ] && [ "$has_local_unique" = "0" ] && [ "$left_right" = "0	0" ]; then
    assert_eq "partial match must not silent-drop local content" "silent_drop" "protected"
  else
    assert_eq "partial match protected (retained or stopped)" "protected" "protected"
  fi

  git -C "$vault" rebase --abort >/dev/null 2>&1 || true
  rm -rf "$root"
}

test_raw_path_difference_is_not_dropped() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  mkdir -p "$vault/raw/articles"
  printf 'local raw body v1\n' > "$vault/raw/articles/note.md"
  git_commit "$vault" "seed raw"
  git -C "$vault" push origin main >/dev/null

  printf 'local raw body v2 unique\n' > "$vault/raw/articles/note.md"
  git_commit "$vault" "local raw edit"

  local remote_work="$root/remote-raw"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  mkdir -p "$remote_work/raw/articles"
  printf 'remote raw body different\n' > "$remote_work/raw/articles/note.md"
  git_commit "$remote_work" "Snapshot raw remote"
  git -C "$remote_work" push origin main >/dev/null

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  # Differing raw blobs must never be treated as fully materialized.
  # Accept stop (exit 1) or retain local unique / conflict — never silent full sync that loses uniqueness without review.
  local content left_right
  content="$(cat "$vault/raw/articles/note.md" 2>/dev/null || true)"
  left_right="$(git -C "$vault" rev-list --left-right --count HEAD...origin/main 2>/dev/null || echo 'x')"

  if [ "$rc" -eq 0 ] && [ "$content" = "remote raw body different" ] && [ "$left_right" = "0	0" ]; then
    # Snapshot auto-resolve --ours may keep local during conflict; if remote won via drop, fail.
    # Check whether local commit was dropped: if tip equals origin and content is remote-only, that is a silent materialization drop of differing raw — fail.
    assert_eq "raw difference must not be fully materialized-dropped" "silent_drop" "protected"
  else
    assert_eq "raw difference retained or stopped" "protected" "protected"
  fi

  git -C "$vault" rebase --abort >/dev/null 2>&1 || true
  rm -rf "$root"
}


test_aa_log_only_conflict_is_union_resolved() {
  # Add/add (AA) on */log.md has no stage-1 base. Union must still succeed with
  # empty base so work-item logs are not left MANUAL when only logs conflict.
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  git -C "$vault" push origin main >/dev/null

  # Divergent add of the same new log path on both sides
  local remote_work="$root/remote-aa"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  mkdir -p "$remote_work/projects/demo/work/item"
  cat > "$remote_work/projects/demo/work/item/log.md" <<'EOF'
# Work Log

## 2026-07-11 remote

Remote log section body.
EOF
  git_commit "$remote_work" "remote add work log"
  git -C "$remote_work" push origin main >/dev/null

  mkdir -p "$vault/projects/demo/work/item"
  cat > "$vault/projects/demo/work/item/log.md" <<'EOF'
# Work Log

## 2026-07-11 local

Local log section body.
EOF
  git_commit "$vault" "local add work log"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "AA log-only pull exits successfully" "$rc" "0"
  assert_eq "AA log-only branch not behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo x)" "0"
  assert_eq "remote log section preserved" "$(grep -c 'Remote log section body' "$vault/projects/demo/work/item/log.md" | tr -d ' ')" "1"
  assert_eq "local log section preserved" "$(grep -c 'Local log section body' "$vault/projects/demo/work/item/log.md" | tr -d ' ')" "1"
  assert_eq "AA log no conflict markers" "$(grep -Ec '^(<<<<<<<|=======|>>>>>>>)' "$vault/projects/demo/work/item/log.md" | tr -d ' ')" "0"
  assert_eq "AA log no unmerged paths" "$(git -C "$vault" diff --name-only --diff-filter=U | wc -l | tr -d ' ')" "0"
  # Prove empty-base path was used (pull log)
  local pull_log
  pull_log="$(find "$home" -type f -name 'wiki-pull.log' 2>/dev/null | head -1)"
  assert_eq "pull log records empty-base AA union" \
    "$( [ -n "$pull_log" ] && grep -c 'empty base for add/add' "$pull_log" | tr -d ' ' || echo 0 )" \
    "1"

  rm -rf "$root"
}

test_aa_log_mixed_with_plan_still_manual() {
  # AA log + AA plan must still fail closed (no silent plan body merge).
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  local remote_work="$root/remote-aa-mix"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  mkdir -p "$remote_work/projects/demo/work/item"
  printf '# Work Log\n\n## remote\n\nR\n' > "$remote_work/projects/demo/work/item/log.md"
  printf '# Plan remote\n' > "$remote_work/projects/demo/work/item/plan.md"
  git_commit "$remote_work" "remote aa log+plan"
  git -C "$remote_work" push origin main >/dev/null

  mkdir -p "$vault/projects/demo/work/item"
  printf '# Work Log\n\n## local\n\nL\n' > "$vault/projects/demo/work/item/log.md"
  printf '# Plan local\n' > "$vault/projects/demo/work/item/plan.md"
  git_commit "$vault" "local aa log+plan"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "AA mixed log+plan surfaces manual" "$rc" "1"
  assert_eq "plan still unmerged" "$(git -C "$vault" status --short projects/demo/work/item/plan.md | cut -c1-2)" "AA"
  # Log may still be unmerged because union declines the whole set
  assert_eq "log still unmerged in mixed set" \
    "$(git -C "$vault" diff --name-only --diff-filter=U | grep -c 'log.md' | tr -d ' ')" "1"

  git -C "$vault" rebase --abort >/dev/null 2>&1 || true
  rm -rf "$root"
}

test_intervening_stash_does_not_steal_restore() {
  local root home vault
  root="$(mktemp -d)"
  home="$root/home"
  vault="$(make_repo "$root")"
  add_remote_commit "$root" "remote.md" "remote" "remote-int"
  printf 'local dirty\n' > "$vault/note.md"

  # Pre-seed an older stash that must not be applied/dropped by unqualified pop
  printf 'other\n' > "$vault/other.md"
  git -C "$vault" add other.md
  git -C "$vault" stash push -m "user-stash-before" >/dev/null
  # note.md remains dirty tracked
  printf 'local dirty\n' > "$vault/note.md"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?
  assert_eq "pull with prior stash succeeds" "$rc" "0"
  assert_eq "dirty edit restored" "$(cat "$vault/note.md")" "local dirty"
  # User stash still present (list length >= 1 with user-stash-before)
  assert_eq "user stash still listed" \
    "$(git -C "$vault" stash list | grep -c 'user-stash-before' | tr -d ' ')" "1"
  rm -rf "$root"
}

test_untracked_dirty_is_preserved_when_in_scope() {
  local root home vault
  root="$(mktemp -d)"
  home="$root/home"
  vault="$(make_repo "$root")"
  add_remote_commit "$root" "remote.md" "remote" "remote-u"
  printf 'tracked dirty\n' > "$vault/note.md"
  printf 'untracked keep\n' > "$vault/local-only.md"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?
  assert_eq "pull with untracked succeeds" "$rc" "0"
  assert_eq "tracked dirty restored" "$(cat "$vault/note.md")" "tracked dirty"
  assert_eq "untracked preserved" "$(cat "$vault/local-only.md" 2>/dev/null || true)" "untracked keep"
  rm -rf "$root"
}

test_dirty_tree_pull_restores_edit
test_stale_rebase_state_is_cleaned_before_pull
test_stale_sequencer_preserves_advanced_tip
test_active_rebase_is_refused
test_snapshot_materialized_commit_is_dropped_without_log_dup
test_partial_match_commit_is_not_dropped
test_raw_path_difference_is_not_dropped
test_untracked_remote_duplicate_is_removed_before_pull
test_divergent_untracked_remote_overlap_is_preserved_before_pull
test_non_archive_log_append_conflict_is_union_resolved
test_mixed_log_and_non_log_conflict_falls_through_safely
test_pull_fails_if_tracked_markdown_contains_conflict_markers
test_pull_allows_markdown_equals_separator
test_stash_pop_regenerates_project_knowledge_conflict
test_aa_log_only_conflict_is_union_resolved
test_aa_log_mixed_with_plan_still_manual
test_intervening_stash_does_not_steal_restore
test_untracked_dirty_is_preserved_when_in_scope

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
