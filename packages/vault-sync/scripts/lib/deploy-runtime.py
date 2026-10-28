#!/usr/bin/env python3
"""Upgrade installed helpers without touching configuration or scheduler state.

Each entry point execs an immutable payload path, so an in-flight helper and
its late-loaded libraries stay on the same release across subsequent upgrades.
Legacy directory migration refuses while an installed helper is running.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile


def deploy(root, share, role, version, commit, host, dry_run=False):
    root, share = Path(root).resolve(), Path(share).resolve()
    current = share / "bin"
    if not current.is_dir() or not (share / "runtime-manifest.json").is_file():
        raise ValueError("runtime-only requires an existing installation and manifest")
    if dry_run:
        print("runtime-only: stage immutable payload, validate, back up and switch bin; preserve configuration and scheduler")
        return
    lock = share / ".runtime-upgrade.lock"
    lock.mkdir()  # No age-based reclamation of another deployer's lock.
    release = None
    backup = None
    swapped = False
    old_link = os.readlink(current) if current.is_symlink() else None
    manifest = share / "runtime-manifest.json"
    old_manifest = manifest.read_bytes()
    try:
        # Existing old-style entry points cannot pin their late-loaded libs.
        # Refuse migration until they finish; never stop or start a content job.
        processes = subprocess.check_output(["ps", "-axww", "-o", "args="], text=True)
        if not current.is_symlink() and any(str(current) + "/" in line for line in processes.splitlines()):
            raise ValueError("installed helper is active; retry runtime upgrade after it exits")
        releases = share / "runtime-releases"
        releases.mkdir(exist_ok=True)
        release = Path(tempfile.mkdtemp(prefix="runtime-", dir=releases))
        payload = release / "payload"
        shutil.copytree(root / "scripts", payload, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy2(root / "skills/vault-presync/wiki-sync.sh", payload / "wiki-sync.sh")
        # Keep auxiliary installed files while replacing package-owned helpers.
        for source in current.iterdir():
            if source.name in ("lib", "payload", "runtime-manifest.json", "previous-runtime-manifest.json"):
                continue
            if source.is_file():
                shutil.copy2(source, release / source.name)
        shutil.copytree(payload / "lib", release / "lib")
        for file in payload.rglob("*"):
            if file.suffix == ".sh":
                subprocess.run(["bash", "-n", str(file)], check=True)
            elif file.suffix == ".py":
                compile(file.read_bytes(), str(file), "exec")
        for file in payload.glob("*.sh"):
            file.chmod(0o755)
            # Quote absolute immutable path using shell single-quote escaping.
            quoted = "'" + str(file).replace("'", "'\\''") + "'"
            launcher = release / file.name
            launcher.write_text("#!/bin/sh\nexec /bin/bash " + quoted + ' "$@"\n')
            launcher.chmod(0o755)
        for file in payload.glob("*.py"):
            # Python entry points must retain __file__ in the immutable payload
            # so fixed sibling helpers cannot drift during another upgrade.
            launcher = release / file.name
            launcher.write_text("#!/usr/bin/env python3\nimport runpy\nrunpy.run_path(" + repr(str(file)) + ", run_name='__main__')\n")
            launcher.chmod(0o755)
        files = {"bin/" + str(p.relative_to(release)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in sorted(release.rglob("*")) if p.is_file()}
        agents = Path.home() / "Library/LaunchAgents"
        for p in sorted(agents.glob("com.karlchow.wiki-*.plist")):
            files["LaunchAgents/" + p.name] = hashlib.sha256(p.read_bytes()).hexdigest()
        new_manifest = dict(schema_version=1, package_version=version, package_commit=commit,
                            installer_version=version, installed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                            role=role, host_id=host, files=files)
        (release / "runtime-manifest.json").write_text(json.dumps(new_manifest, indent=2) + "\n")
        (release / "previous-runtime-manifest.json").write_bytes(old_manifest)
        if os.environ.get("VS_RUNTIME_TEST_FAIL") == "before-switch":
            raise ValueError("injected pre-switch failure")
        candidate = share / ".bin-next"
        candidate.symlink_to(release)
        if old_link is None:
            backup = share / ("bin-backup-" + release.name)
            current.rename(backup)
            # A legacy runner that opened its script during staging must finish
            # against the old libraries; refuse before exposing new libraries.
            processes = subprocess.check_output(["ps", "-axww", "-o", "args="], text=True)
            if any(str(current) + "/" in line for line in processes.splitlines()):
                raise ValueError("legacy helper started during staging; runtime restored, retry later")
        os.replace(candidate, current)
        swapped = True
        if os.environ.get("VS_RUNTIME_TEST_FAIL") == "after-switch":
            raise ValueError("injected post-switch failure")
        staged_manifest = share / ".runtime-manifest-next.json"
        staged_manifest.write_bytes((release / "runtime-manifest.json").read_bytes())
        os.replace(staged_manifest, manifest)
        for relative, digest in files.items():
            if relative.startswith("bin/") and hashlib.sha256((share / relative).read_bytes()).hexdigest() != digest:
                raise ValueError("installed runtime hash mismatch")
        print("runtime-only installed " + version + "; rollback=" + str(backup or old_link))
    except BaseException:
        if swapped:
            current.unlink()
        if backup is not None and backup.exists():
            backup.rename(current)
        elif swapped and old_link is not None:
            current.symlink_to(old_link)
        manifest.write_bytes(old_manifest)
        if release is not None:
            shutil.rmtree(release)
        raise
    finally:
        (share / ".bin-next").unlink(missing_ok=True)
        (share / ".runtime-manifest-next.json").unlink(missing_ok=True)
        lock.rmdir()


if __name__ == "__main__":
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt("runtime upgrade interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        deploy(*sys.argv[1:7], dry_run=sys.argv[7:] == ["--dry-run"])
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print("runtime-only refused: " + str(error), file=sys.stderr)
        sys.exit(1)
