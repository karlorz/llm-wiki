#!/bin/sh
# git-case.sh — Detect case-only path collisions before unattended git writes.
#
# Case-insensitive filesystems cannot represent two paths that differ only by
# letter case. If Linux commits such a tree, macOS checkouts can become
# permanently dirty and unable to rebase. These helpers return nonzero and print
# conflicting pairs when a repo contains such paths.

git_case_index_conflicts() {
  git ls-files 2>/dev/null | awk '
    {
      key = tolower($0)
      if (seen[key] && seen[key] != $0) {
        print seen[key] " <-> " $0
        bad = 1
      } else if (!seen[key]) {
        seen[key] = $0
      }
    }
    END { exit bad ? 1 : 0 }
  '
}

git_case_worktree_conflicts() {
  find . -type f \
    ! -path './.git/*' \
    ! -path './.snapshots/*' \
    -print 2>/dev/null |
    sed 's#^\./##' |
    awk '
      {
        key = tolower($0)
        if (seen[key] && seen[key] != $0) {
          print seen[key] " <-> " $0
          bad = 1
        } else if (!seen[key]) {
          seen[key] = $0
        }
      }
      END { exit bad ? 1 : 0 }
    '
}

git_case_conflicts() {
  _git_case_tmp="${TMPDIR:-/tmp}/vault-sync-case-conflicts.$$"
  : >"$_git_case_tmp"

  git_case_index_conflicts >>"$_git_case_tmp" || true
  git_case_worktree_conflicts >>"$_git_case_tmp" || true

  if [ -s "$_git_case_tmp" ]; then
    sort -u "$_git_case_tmp"
    rm -f "$_git_case_tmp"
    return 1
  fi

  rm -f "$_git_case_tmp"
  return 0
}

git_case_assert_clean() {
  _git_case_label="${1:-repository}"
  _git_case_conflicts="$(git_case_conflicts)"
  _git_case_rc=$?
  if [ "$_git_case_rc" -ne 0 ]; then
    printf 'FATAL: case-only path collision in %s\n' "$_git_case_label" >&2
    printf '%s\n' "$_git_case_conflicts" >&2
    return 1
  fi
  return 0
}
