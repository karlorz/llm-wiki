#!/bin/bash
# Regression tests for packages/vault-sync/skills/vault-presync/wiki-sync.sh

set -u

PRESYNC="$(cd "$(dirname "$0")/.." && pwd)/skills/vault-presync/wiki-sync.sh"
PULL_HELPER="$(cd "$(dirname "$0")/.." && pwd)/scripts/wiki-pull-with-auto-resolve.sh"
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

# Stub skillwiki for lint-delta so execute path is not blocked.
make_skillwiki_stub() {
  local bin_dir="$1"
  local mode="${2:-inherited}"  # inherited | new | malformed | missing
  mkdir -p "$bin_dir"
  cat > "$bin_dir/skillwiki" <<EOF
#!/bin/bash
set -u
if [ "\${1:-}" = "path" ]; then
  echo '{"ok":true,"data":{"path":"'"\${WIKI_DIR:-}"'"}}'
  exit 0
fi
if [ "\${1:-}" = "sync" ] && [ "\${2:-}" = "lint-delta" ]; then
  case "$mode" in
    inherited)
      cat <<'JSON'
{"ok":true,"data":{"full_errors":3,"base_errors":3,"new_errors":0,"resolved_errors":0,"humanHint":"inherited only"}}
JSON
      exit 0
      ;;
    new)
      cat <<'JSON'
{"ok":true,"data":{"full_errors":4,"base_errors":3,"new_errors":1,"resolved_errors":0,"humanHint":"new error"}}
JSON
      exit 2
      ;;
    malformed)
      echo 'not-json'
      exit 0
      ;;
    *)
      echo '{"ok":false}'
      exit 1
      ;;
  esac
fi
if [ "\${1:-}" = "lint" ]; then
  echo '{"ok":true,"data":{"summary":{"errors":0,"warnings":0,"info":0}}}'
  exit 0
fi
exit 0
EOF
  chmod +x "$bin_dir/skillwiki"
}

test_presync_parity_with_pull_helper() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  mkdir -p "$home"
  local vault_a vault_b
  vault_a="$(make_repo "$root")"

  # Divergent fixture: local work + remote snapshot
  mkdir -p "$vault_a/projects/demo"
  printf 'local-a\n' > "$vault_a/projects/demo/a.md"
  git_commit "$vault_a" "local a"
  git -C "$vault_a" push origin main >/dev/null

  # Clone B from same remote as independent working copy
  git clone --branch main "$root/origin.git" "$root/wiki-b" >/dev/null
  vault_b="$root/wiki-b"
  git -C "$vault_b" -c user.name=test -c user.email=test@test checkout main >/dev/null

  # Remote advance
  local remote_work="$root/remote-work"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  printf 'remote-b\n' > "$remote_work/projects/demo/b.md"
  mkdir -p "$remote_work/projects/demo"
  git_commit "$remote_work" "remote b"
  git -C "$remote_work" push origin main >/dev/null

  # Local advance on A (not pushed)
  printf 'local-c\n' > "$vault_a/projects/demo/c.md"
  git_commit "$vault_a" "local c"

  # Same local advance on B
  printf 'local-c\n' > "$vault_b/projects/demo/c.md"
  git_commit "$vault_b" "local c"

  local stub="$root/bin"
  make_skillwiki_stub "$stub" inherited

  # Run pull helper on A
  HOME="$home" PATH="$stub:$PATH" WIKI_DIR="$vault_a" bash "$PULL_HELPER" origin main >/dev/null 2>&1
  local rc_a=$?

  # Run presync execute on B
  # Force WIKI detection via skillwiki path stub + env
  HOME="$home" PATH="$stub:$PATH" WIKI_DIR="$vault_b" bash "$PRESYNC" --execute >/dev/null 2>&1
  local rc_b=$?

  local tree_a tree_b ab_a ab_b markers_a markers_b
  tree_a="$(git -C "$vault_a" rev-parse 'HEAD^{tree}')"
  tree_b="$(git -C "$vault_b" rev-parse 'HEAD^{tree}')"
  ab_a="$(git -C "$vault_a" rev-list --left-right --count HEAD...origin/main)"
  ab_b="$(git -C "$vault_b" rev-list --left-right --count HEAD...origin/main)"
  markers_a="$(git -C "$vault_a" grep -nE '^(<<<<<<<|=======|>>>>>>>)' 2>/dev/null | wc -l | tr -d ' ')"
  markers_b="$(git -C "$vault_b" grep -nE '^(<<<<<<<|=======|>>>>>>>)' 2>/dev/null | wc -l | tr -d ' ')"

  assert_eq "pull helper exits 0" "$rc_a" "0"
  assert_eq "presync execute exits 0" "$rc_b" "0"
  assert_eq "final trees equal" "$tree_a" "$tree_b"
  assert_eq "ahead/behind equal" "$ab_a" "$ab_b"
  assert_eq "no conflict markers in A" "$markers_a" "0"
  assert_eq "no conflict markers in B" "$markers_b" "0"

  rm -rf "$root"
}

test_presync_stash_name_peer_detectable() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  mkdir -p "$home"
  local vault
  vault="$(make_repo "$root")"

  # Make dirty tracked edit so helper (not wiki-sync) stashes during pull
  printf 'dirty\n' > "$vault/note.md"
  # Need to be behind so pull path runs
  local remote_work="$root/remote-work"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  printf 'remote\n' > "$remote_work/remote.md"
  git_commit "$remote_work" "remote"
  git -C "$remote_work" push origin main >/dev/null

  local stub="$root/bin"
  make_skillwiki_stub "$stub" inherited

  # Unit-test message format (helper naming retained for peer tooling docs)
  local msg
  msg="$(
    WIKI_DIR="$vault" SKILLWIKI_SESSION_ID=sess1 bash <<'EOS'
set -euo pipefail
WIKI_DIR="${WIKI_DIR}"
make_wiki_sync_stash_msg() {
    local summary="${1:-pre-pull}"
    local session_id cwd_hash iso
    session_id="${SKILLWIKI_SESSION_ID:-${CLAUDE_SESSION_ID:-local}}"
    cwd_hash="$(printf '%s' "$WIKI_DIR" | shasum -a 256 2>/dev/null | cut -c1-8)"
    iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'wiki-sync:%s:%s:%s:%s' "$session_id" "$cwd_hash" "$iso" "$summary"
}
make_wiki_sync_stash_msg pre-pull
EOS
  )"

  assert_eq "stash message matches peer parser" \
    "$(printf '%s' "$msg" | grep -E '^wiki-sync:[^:]+:[^:]+:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z:pre-pull$' >/dev/null && echo yes || echo no)" \
    "yes"

  # wiki-sync must not call unqualified git stash pop (helper owns stash lifecycle)
  assert_eq "wiki-sync has no unqualified stash pop" \
    "$(grep -cE 'git stash pop' "$PRESYNC" || true)" "0"
  assert_eq "wiki-sync has no pre-stash push of dirty tree" \
    "$(grep -cE 'git stash push' "$PRESYNC" || true)" "0"

  # Also verify real execute creates/consumes without error and dirty edit restored
  HOME="$home" PATH="$stub:$PATH" WIKI_DIR="$vault" SKILLWIKI_SESSION_ID=sess1 \
    bash "$PRESYNC" --execute >/dev/null 2>&1
  rc=$?
  assert_eq "presync with dirty tree exits 0" "$rc" "0"
  assert_eq "dirty edit restored" "$(cat "$vault/note.md")" "dirty"
  assert_eq "remote present" "$(cat "$vault/remote.md" 2>/dev/null || true)" "remote"
  # No leftover wiki-sync-named stashes from double-stash path
  assert_eq "no leftover wiki-sync named stash" \
    "$(git -C "$vault" stash list | grep -c 'wiki-sync:' | tr -d ' ' || true)" "0"

  rm -rf "$root"
}

test_presync_lint_delta_inherited_proceeds() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  mkdir -p "$home"
  local vault
  vault="$(make_repo "$root")"
  local stub="$root/bin"
  make_skillwiki_stub "$stub" inherited

  out="$(HOME="$home" PATH="$stub:$PATH" WIKI_DIR="$vault" bash "$PRESYNC" --execute 2>&1)"
  rc=$?
  assert_eq "inherited-only lint delta allows execute" "$rc" "0"
  assert_eq "prints full/base/new/resolved" \
    "$(printf '%s' "$out" | grep -c 'full=3 base=3 new=0 resolved=0' | tr -d ' ')" "1"

  rm -rf "$root"
}

test_presync_lint_delta_new_blocks() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  mkdir -p "$home"
  local vault
  vault="$(make_repo "$root")"
  local stub="$root/bin"
  make_skillwiki_stub "$stub" new

  HOME="$home" PATH="$stub:$PATH" WIKI_DIR="$vault" bash "$PRESYNC" --execute >/dev/null 2>&1
  rc=$?
  assert_eq "new lint errors block execute" "$rc" "1"

  rm -rf "$root"
}

test_presync_lint_delta_malformed_blocks() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  mkdir -p "$home"
  local vault
  vault="$(make_repo "$root")"
  local stub="$root/bin"
  make_skillwiki_stub "$stub" malformed

  HOME="$home" PATH="$stub:$PATH" WIKI_DIR="$vault" bash "$PRESYNC" --execute >/dev/null 2>&1
  rc=$?
  assert_eq "malformed lint-delta blocks execute" "$rc" "1"

  rm -rf "$root"
}

test_presync_parity_with_pull_helper
test_presync_stash_name_peer_detectable
test_presync_lint_delta_inherited_proceeds
test_presync_lint_delta_new_blocks
test_presync_lint_delta_malformed_blocks

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
