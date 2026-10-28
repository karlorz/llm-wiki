#!/usr/bin/env python3
"""Opt-in sibling worker. Never invoked by the MCP daemon. Timer retries are bounded."""
import fcntl
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
import time

ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
PROOF = re.compile(r"SNAPSHOT_COMPLETE schema=v1 outcome=(?:pushed|no-change) result=success ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z head=([0-9a-f]{40}|[0-9a-f]{64}) origin=([0-9a-f]{40}|[0-9a-f]{64})(?:\s|$)")
MAX_ATTEMPTS = 3
BATCH = 128


def safe_state(value, vault):
    root = Path(value)
    if not root.is_absolute() or not vault or not Path(vault).is_absolute():
        raise ValueError("UNSAFE_SNAPSHOT_STATE")
    root = Path(os.path.abspath(root))
    vault = Path(os.path.abspath(vault))
    if root == vault or vault in root.parents or root in vault.parents:
        raise ValueError("UNSAFE_SNAPSHOT_STATE")
    for path in [root, *root.parents, vault, *vault.parents]:
        if path.is_symlink():
            raise ValueError("UNSAFE_SNAPSHOT_STATE")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ("pending", "running", "receipts"):
        path = root / name
        if path.is_symlink():
            raise ValueError("UNSAFE_SNAPSHOT_STATE")
        path.mkdir(mode=0o700, exist_ok=True)
    return root


def read_record(path, vault_id):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or os.fstat(stream.fileno()).st_size > 16384:
            raise ValueError("INVALID_RECORD")
        record = json.load(stream)
    if not isinstance(record, dict):
        raise ValueError("INVALID_RECORD")
    if not ID.fullmatch(path.stem) or record.get("request_id") != path.stem or record.get("vault_id") != vault_id:
        raise ValueError("INVALID_RECORD")
    if type(record.get("attempt")) is not int or not 0 <= record["attempt"] <= MAX_ATTEMPTS:
        raise ValueError("INVALID_RECORD")
    for key in ("created_at", "next_attempt", "started_at", "finished_at"):
        if key in record or key in ("created_at", "next_attempt"):
            value = record.get(key)
            try:
                valid = type(value) in (int, float) and value >= 0 and math.isfinite(value)
            except OverflowError:
                valid = False
            if not valid:
                raise ValueError("INVALID_RECORD")
    return record


def write_record(path, record):
    fd, temp = tempfile.mkstemp(prefix=".record-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def execute_snapshot(timeout=900):
    # Fixed installed sibling script; neither queue data nor MCP input selects commands.
    script = Path(__file__).resolve().with_name("wiki-snapshot.sh")
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.Popen([str(script)], stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError:
            return None
        try:
            result.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # The fixed runner spawns git/rclone/shell descendants. Kill the whole
            # isolated process group before reaping its leader, even outside systemd.
            try:
                os.killpg(result.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            result.wait()
            return None
        output.seek(max(0, output.tell() - 262144))
        text = output.read().decode("utf-8", errors="replace")
    matches = list(PROOF.finditer(text))
    if result.returncode != 0 or not matches:
        return None
    match = matches[-1]
    if match[1] != match[2]:
        return None
    return {"head": match[1], "origin": match[2]}


def process(root, vault_id, run=execute_snapshot, now=None, quiet_ms=5000, max_delay_ms=60000):
    injected_now = now
    clock = lambda: int(time.time() * 1000) if injected_now is None else injected_now
    now = clock()
    def fail(path, record, error):
        finished = clock()
        record.update(state="failed", error=error, finished_at=finished)
        record["next_attempt"] = finished + 60000 * (2 ** max(0, record["attempt"] - 1))
        write_record(root / "receipts" / path.name, record)
        if record["attempt"] < MAX_ATTEMPTS:
            # Retain failure receipt while next timer invocation retries pending work.
            write_record(root / "pending" / path.name, record)
        path.unlink(missing_ok=True)
    # The exclusive worker lock proves every pre-existing running claim was interrupted.
    for path in sorted((root / "running").glob("*.json")):
        rec = read_record(path, vault_id)
        receipt = root / "receipts" / path.name
        if receipt.exists() and read_record(receipt, vault_id).get("state") == "completed":
            path.unlink()
        else:
            fail(path, rec, "SNAPSHOT_INTERRUPTED")
    pending = []
    for path in sorted((root / "pending").glob("*.json")):
        rec = read_record(path, vault_id)
        if rec["attempt"] >= MAX_ATTEMPTS:
            rec.update(state="failed", error="SNAPSHOT_INTERRUPTED", finished_at=now)
            write_record(root / "receipts" / path.name, rec)
            path.unlink()
            continue
        if rec["next_attempt"] <= now:
            pending.append((path, rec))
        if len(pending) >= BATCH:
            break
    if not pending:
        return 0
    oldest = min(rec["created_at"] for _, rec in pending)
    newest = max(rec["created_at"] for _, rec in pending)
    if now - newest < quiet_ms and now - oldest < max_delay_ms:
        return 0
    claims = []
    for path, rec in pending:
        running = root / "running" / path.name
        rec.update(state="running", attempt=rec["attempt"] + 1, started_at=now)
        # Persist increment before moving, so interruption cannot reset retry accounting.
        write_record(path, rec)
        os.replace(path, running)
        claims.append((running, rec))
    for area in ("pending", "running"):
        directory_fd = os.open(root / area, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    proof = run()
    for path, rec in claims:
        if proof:
            rec.update(state="completed", finished_at=clock(), **proof)
            rec.pop("error", None)
            write_record(root / "receipts" / path.name, rec)
            path.unlink()
        else:
            fail(path, rec, "SNAPSHOT_COMPLETION_UNPROVEN")
    return 0 if proof else 1


def main():
    if os.environ.get("SKILLWIKI_SNAPSHOT_REQUESTS_ENABLED") != "true":
        return 0
    root = safe_state(os.environ["SKILLWIKI_SNAPSHOT_STATE_DIR"], os.environ["WIKI_DIR"])
    safe_state(str(root), os.environ.get("WIKI_GIT_WORKTREE", os.environ.get("SNAPSHOT_WORKTREE", "/root/wiki-git")))
    vault_id = os.environ.get("SKILLWIKI_SNAPSHOT_VAULT_ID", "central")
    fd = os.open(root / "worker.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w"):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        return process(root, vault_id)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        print("snapshot request worker refused unsafe or invalid state", flush=True)
        raise SystemExit(1)
