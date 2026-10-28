#!/bin/bash
# Cross-process directory/flock compatibility, including hosts without flock.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 - "$SCRIPT_DIR/../scripts/lib/lockfile.sh" <<'PY'
import fcntl
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile

lib = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    # Use native flock where installed; otherwise exercise identical kernel
    # flock semantics through fcntl on macOS test hosts.
    flock = root / "flock"
    flock.write_text('#!' + sys.executable + '\nimport fcntl,sys\ntry: fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n')
    flock.chmod(0o700)
    native_flock = shutil.which('flock')
    env = dict(os.environ, PATH=os.environ['PATH'] if native_flock else str(root) + os.pathsep + os.environ['PATH'])
    lock = root / "pull.lock"
    directory = Path(str(lock) + '.d')
    def shell(code, **kwargs):
        return subprocess.run(['bash', '-c', '. "$1"; shift; ' + code, 'test', lib, str(lock)], env=env, check=False, **kwargs)
    # TS's ownerless directory mutex held in this (separate) process must block
    # shell even when flock is installed and the flock itself is available.
    directory.mkdir()
    assert shell('lockfile_acquire "$1" 0').returncode == 1
    assert directory.is_dir()
    directory.rmdir()
    with lock.open('w') as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert shell('lockfile_acquire "$1"').returncode == 1
        assert not directory.exists(), 'failed flock leaked directory'
    assert shell('lockfile_acquire "$1"; rc=$?; lockfile_release "$1"; exit "$rc"').returncode == 0
    assert not directory.exists()
    # A known-live shell lock remains held regardless of supplied age, and a
    # second shell cannot release it. Explicit release drops both primitives.
    ready = root / 'ready'
    release = root / 'release'
    holder = subprocess.Popen(['bash', '-c', '. "$1"; lockfile_acquire "$2"; touch "$3"; while [ ! -f "$4" ]; do sleep .02; done; lockfile_release "$2"', 'holder', lib, str(lock), str(ready), str(release)], env=env)
    try:
        import time
        deadline = time.monotonic() + 5
        while not ready.exists():
            assert time.monotonic() < deadline, 'holder did not acquire'
            time.sleep(.02)
        assert shell('platform_stat_ctime() { echo 0; }; lockfile_acquire "$1" 0').returncode == 1
        assert shell('lockfile_release "$1"').returncode == 0
        assert directory.is_dir()
        with lock.open('w') as probe:
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                raise AssertionError('shell did not retain flock')
    finally:
        release.touch()
        holder.wait(timeout=5)
    assert not directory.exists()
    assert shell('lockfile_acquire "$1"; printf replacement > "$1.d/owner"; lockfile_release "$1"; test -d "$1.d"').returncode == 0
    print('PASS: directory blocks shell with flock installed; held flock cannot be bypassed; live and replacement owners protected; release frees both primitives')
PY
