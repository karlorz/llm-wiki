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

test_dirty_tree_pull_restores_edit
test_stale_rebase_state_is_cleaned_before_pull
test_untracked_remote_duplicate_is_removed_before_pull
test_divergent_untracked_remote_overlap_is_preserved_before_pull
test_non_archive_log_append_conflict_is_union_resolved
test_mixed_log_and_non_log_conflict_falls_through_safely
test_pull_fails_if_tracked_markdown_contains_conflict_markers
test_stash_pop_regenerates_project_knowledge_conflict

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
