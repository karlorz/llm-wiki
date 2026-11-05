#!/usr/bin/env bash
# Real local Git graphs, no S3/SSH/Docker. Also exercise linked-worktree metadata.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -B - "$ROOT/scripts/wiki-git-repair-v3.sh" <<'PY'
import os
from pathlib import Path
import subprocess
import sys
import tempfile

helper = sys.argv[1]
def git(repo, *args, check=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
def commit(repo, name, text):
    (repo/name).write_text(text)
    git(repo, 'add', name)
    git(repo, '-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', text)
    return git(repo, 'rev-parse', 'HEAD')
def run(repo):
    return subprocess.run(['bash', helper], env={**os.environ, 'WIKI_GIT_WORKTREE':str(repo)},
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
def fixture(root):
    repo = root/'repo'; repo.mkdir()
    git(repo, 'init', '-b', 'main')
    commit(repo, 'page.md', 'base\n')
    git(root, 'clone', '--bare', str(repo), str(root/'origin.git'))
    git(repo, 'remote', 'add', 'origin', str(root/'origin.git'))
    git(repo, 'fetch', 'origin')
    return repo
def unchanged(repo, before, status):
    assert git(repo, 'rev-parse', 'HEAD') == before
    assert git(repo, 'status', '--porcelain') == status

for case in ('equal', 'ahead', 'behind', 'behind-dirty-conflict', 'diverged', 'merge', 'lock', 'detached',
             'unmerged', 'rebase-active', 'rebase-missing-todo', 'rebase-empty', 'linked-lock', 'fetch-failed'):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp); repo = fixture(root)
        if case == 'linked-lock':
            git(repo, 'worktree', 'add', '-b', 'linked', str(root/'linked'))
            repo = root/'linked'
        if case in ('ahead', 'diverged'):
            commit(repo, 'local.md', 'unpushed snapshot\n')
        if case in ('behind', 'behind-dirty-conflict', 'diverged'):
            git(root, 'clone', '-b', 'main', str(root/'origin.git'), str(root/'publisher'))
            commit(root/'publisher', 'page.md' if case == 'behind-dirty-conflict' else 'remote.md', 'published elsewhere\n')
            git(root/'publisher', 'push', 'origin', 'main')
        if case == 'behind-dirty-conflict': git(repo, 'config', 'merge.autostash', 'true')
        if case == 'detached':
            git(repo, 'checkout', '--detach')
        meta = Path(git(repo, 'rev-parse', '--absolute-git-dir'))
        if case == 'merge': (meta/'MERGE_HEAD').write_text(git(repo, 'rev-parse', 'HEAD')+'\n')
        if case in ('lock', 'linked-lock'): (meta/'index.lock').write_text('owned\n')
        if case == 'unmerged':
            blob = git(repo, 'rev-parse', 'HEAD:page.md')
            subprocess.run(['git', '-C', str(repo), 'update-index', '--index-info'],
                           input=f'0 {"0"*40}\tpage.md\n100644 {blob} 1\tpage.md\n100644 {blob} 2\tpage.md\n',
                           text=True, check=True)
        if case.startswith('rebase-'):
            (meta/'rebase-merge').mkdir()
            if case != 'rebase-missing-todo':
                (meta/'rebase-merge/git-rebase-todo').write_text(
                    'pick '+git(repo, 'rev-parse', 'HEAD')+' active\n' if case == 'rebase-active' else ' \n\t')
        if case == 'fetch-failed': git(repo, 'remote', 'set-url', 'origin', str(root/'missing.git'))
        # Preserve dirty and untracked bytes even on successful equal/ahead repair.
        (repo/'page.md').write_text('dirty S3 copy\n')
        (repo/'untracked.md').write_text('untracked S3 copy\n')
        before = git(repo, 'rev-parse', 'HEAD'); status = git(repo, 'status', '--porcelain')
        result = run(repo)
        if case in ('equal', 'ahead', 'behind', 'rebase-empty'):
            assert result.returncode == 0, (case, result.stdout)
            if case == 'behind':
                assert git(repo, 'rev-parse', 'HEAD') == git(root/'publisher', 'rev-parse', 'HEAD')
            else: unchanged(repo, before, status)
            if case == 'ahead': assert 'ahead of origin/main' in result.stdout
            if case == 'rebase-empty':
                assert not (meta/'rebase-merge').exists()
                refs = git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/vault-sync/recovery/')
                assert refs == before, refs
        else:
            assert result.returncode != 0, (case, result.stdout)
            unchanged(repo, before, status)
            assert git(repo, 'stash', 'list') == ''
            assert 'fail closed' in result.stdout, (case, result.stdout)
            if case == 'diverged': assert 'true divergence' in result.stdout and 'no reset' in result.stdout
            if case.startswith('rebase-'): assert (meta/'rebase-merge').exists()
        assert (repo/'page.md').read_text() == 'dirty S3 copy\n'
        assert (repo/'untracked.md').read_text() == 'untracked S3 copy\n'
        print('PASS: conservative Git repair '+case)
PY
