#!/usr/bin/env python3
"""Verify an owned stash restore against its frozen post-rebase baseline."""
import os
import pathlib
import subprocess
import sys
import tempfile


def verify(repo, inventory, stash, head, skipped):
    def git(*args, data=None, stream=None):
        return subprocess.run(["git", "--literal-pathspecs", "-C", repo, *args], input=data, stdin=stream,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout

    def entry(tree, path):
        raw = git("ls-tree", "-z", tree, "--", path)
        if not raw:
            return None
        meta, name = raw.rstrip(b"\0").split(b"\t", 1)
        mode, kind, oid = meta.decode().split()
        if name.decode() != path or kind != "blob":
            raise ValueError("unsupported inventory entry")
        return mode, oid

    def expected(path):
        base, local, upstream = (entry(tree, path) for tree in (stash + "^1", stash, head))
        if local == base:
            return upstream
        if upstream == base or local == upstream:
            return local
        if not base or not local or not upstream:
            raise ValueError("ambiguous add/delete restore")
        if any(mode not in ("100644", "100755") for mode, _ in (base, local, upstream)):
            raise ValueError("ambiguous file-type restore")
        mode = local[0] if upstream[0] == base[0] else upstream[0]
        with tempfile.TemporaryDirectory(prefix="stash-merge-") as directory:
            files = [pathlib.Path(directory, name) for name in ("upstream", "base", "local")]
            for file, value in zip(files, (upstream, base, local)):
                if int(git("cat-file", "-s", value[1])) > 16 * 1024 * 1024:
                    raise ValueError("merge verification exceeds bounded file size")
                file.write_bytes(git("cat-file", "blob", value[1]))
            merged = subprocess.run(["git", "merge-file", "-p", *map(str, files)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if merged.returncode:
                raise ValueError("ambiguous content restore")
            return mode, git("hash-object", "--stdin", data=merged.stdout).decode().strip()

    if git("rev-parse", "HEAD").strip() != git("rev-parse", head).strip():
        raise ValueError("restore baseline moved")
    section = None
    for path in pathlib.Path(inventory).read_text().splitlines():
        if path in ("# staged", "# tracked", "# untracked"):
            section = path[2:]
            continue
        if not section or not path or path.startswith("#"):
            continue
        if pathlib.PurePosixPath(path).is_absolute() or ".." in pathlib.PurePosixPath(path).parts:
            raise ValueError("invalid inventory path")
        file = pathlib.Path(repo, path)
        if any(parent.is_symlink() for parent in file.parents if parent != pathlib.Path(repo) and pathlib.Path(repo) in parent.parents):
            raise ValueError("inventory parent changed type")
        # Unknown conflicts must never be treated as verified restoration.
        if git("ls-files", "-u", "--", path):
            raise ValueError("unresolved inventory path")
        if path in skipped:
            derived = path in ("index.md", "SCHEMA.md", "log.md") or path.endswith("/log.md") or (path.startswith("projects/") and path.count("/") == 2 and path.endswith("/knowledge.md"))
            if not derived:
                raise ValueError("non-derived inventory exemption")
            want = entry(stash, path) or entry(head, path)
        else:
            want = entry(stash + "^3", path) if section == "untracked" else expected(path)
        if want is None:
            if os.path.lexists(file):
                raise ValueError("deleted inventory path reappeared")
            continue
        mode, oid = want
        if mode == "120000":
            if not file.is_symlink():
                raise ValueError("inventory symlink type changed")
            data = os.fsencode(os.readlink(file))
        else:
            if file.is_symlink() or not file.is_file():
                raise ValueError("inventory regular file missing or type changed")
            if mode not in ("100644", "100755"):
                raise ValueError("unsupported inventory mode")
            if bool(file.stat().st_mode & 0o111) != (mode == "100755"):
                raise ValueError("inventory executable mode changed")
            data = None
        if path not in skipped:
            if data is None:
                with file.open("rb") as stream:
                    actual = git("hash-object", "--stdin", stream=stream)
            else:
                actual = git("hash-object", "--stdin", data=data)
            if actual.decode().strip() != oid:
                raise ValueError("inventory content mismatch")


if __name__ == "__main__":
    try:
        repo, inventory, stash, head, skip = sys.argv[1:]
        verify(repo, inventory, stash, head, set(skip.splitlines()))
    except (OSError, ValueError, subprocess.SubprocessError):
        print("inventory verification refused: missing, changed or ambiguous restore", file=sys.stderr)
        sys.exit(1)
