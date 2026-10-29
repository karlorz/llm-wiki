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
BUSY = re.compile(r"SNAPSHOT_LOCK_BUSY schema=v1 result=busy exit=75")
MAX_ATTEMPTS = 3
BATCH = 128
BUSY_EXIT = 75
BUSY_DELAY_MS = 60000
LOCK_BUSY_ERROR = "SNAPSHOT_LOCK_BUSY"
LOCK_BUSY = object()
MARKER_PREFIXES = ("ERROR:", "FAIL ", "SNAPSHOT_")
MARKER_LIMIT = 240
LOG_TS = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ")


def diagnostic_body(line):
    return LOG_TS.sub("", line.strip(), count=1)


def sanitize_marker(text):
    cleaned = "".join(ch if ch == " " or 31 < ord(ch) < 127 else " " for ch in text)
    return cleaned.strip()[:MARKER_LIMIT]


def last_snapshot_marker(text):
    for line in reversed(text.splitlines()):
        body = diagnostic_body(line)
        if body.startswith(MARKER_PREFIXES):
            return sanitize_marker(body)
    return ""


def unproven_reason(code, text=""):
    if code == "spawn":
        return "spawn_failed"
    if isinstance(code, int) and code < 0:
        return "timeout"
    matches = list(PROOF.finditer(text))
    if code == 0 and matches:
        match = matches[-1]
        if match[1] != match[2]:
            return "proof_mismatch"
    return "proof_missing"


def report_unproven(code, text=""):
    print(
        f"snapshot request unproven reason={unproven_reason(code, text)} exit={code} marker={last_snapshot_marker(text)}",
        flush=True,
    )


def remembered_failure(record):
    err = record.get("error")
    if err and err != LOCK_BUSY_ERROR:
        return err
    return record.get("last_failure")


def read_runner_output(output):
    output.seek(max(0, output.tell() - 262144))
    return output.read().decode("utf-8", errors="replace")


def snapshot_outcome(code, text):
    matches = list(PROOF.finditer(text))
    lines = text.rstrip().splitlines()
    if code == BUSY_EXIT and not matches and lines and BUSY.fullmatch(lines[-1]):
        return LOCK_BUSY
    if code == 0 and matches:
        match = matches[-1]
        if match[1] == match[2]:
            return {"head": match[1], "origin": match[2]}
    report_unproven(code, text)
    return None


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
    for key in ("error", "last_failure"):
        if key in record and type(record[key]) is not str:
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
            # The worker may run as root while MCP owns the private spool.
            # Keep every replacement readable by that owner, including retries.
            owner = path.parent.stat()
            if os.geteuid() == 0:
                os.fchown(stream.fileno(), owner.st_uid, owner.st_gid)
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
            report_unproven("spawn")
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
            return snapshot_outcome(result.returncode, read_runner_output(output))
        return snapshot_outcome(result.returncode, read_runner_output(output))


def process(root, vault_id, run=execute_snapshot, now=None, quiet_ms=5000, max_delay_ms=60000):
    injected_now = now
    clock = lambda: int(time.time() * 1000) if injected_now is None else injected_now
    now = clock()
    def fail(path, record, error):
        finished = clock()
        record.update(state="failed", error=error, last_failure=error, finished_at=finished)
        record["next_attempt"] = finished + 60000 * (2 ** max(0, record["attempt"] - 1))
        write_record(root / "receipts" / path.name, record)
        if record["attempt"] < MAX_ATTEMPTS:
            # Retain failure receipt while next timer invocation retries pending work.
            write_record(root / "pending" / path.name, record)
        path.unlink(missing_ok=True)
    def terminal(path):
        receipt = root / "receipts" / path.name
        if not receipt.exists():
            return False
        prior = read_record(receipt, vault_id)
        return prior.get("state") == "completed" or (prior.get("state") == "failed" and prior["attempt"] >= MAX_ATTEMPTS)
    def journal_deferral(path, record, next_attempt):
        # Durable running journal first; recovery completes the receipt/pending writes.
        prior = record.get("error")
        if prior and prior != LOCK_BUSY_ERROR:
            record["last_failure"] = prior
        record["attempt"] -= 1
        record.update(state="queued", error=LOCK_BUSY_ERROR, next_attempt=next_attempt)
        record.pop("finished_at", None)
        write_record(path, record)
    def finish_deferral(path, record):
        write_record(root / "receipts" / path.name, record)
        write_record(root / "pending" / path.name, record)
        path.unlink(missing_ok=True)
    def deferred(record):
        return record.get("state") == "queued" and record.get("error") == LOCK_BUSY_ERROR
    # The exclusive worker lock proves every pre-existing running claim was interrupted.
    running = [(path, read_record(path, vault_id), terminal(path)) for path in sorted((root / "running").glob("*.json"))]
    # A crash between per-record journals leaves same-run siblings still marked running.
    batches = {rec["started_at"]: rec for _, rec, is_terminal in running if not is_terminal and deferred(rec) and "started_at" in rec}
    # Journal every sibling before removing any witness, including during recovery.
    # Otherwise a second crash could lose the known-busy outcome for that batch.
    for path, rec, is_terminal in running:
        if not is_terminal and rec.get("state") == "running" and rec.get("started_at") in batches:
            journal_deferral(path, rec, batches[rec["started_at"]]["next_attempt"])
    for path, rec, is_terminal in running:
        if is_terminal:
            path.unlink()
        elif deferred(rec):
            finish_deferral(path, rec)
        else:
            fail(path, rec, "SNAPSHOT_INTERRUPTED")
    pending = []
    for path in sorted((root / "pending").glob("*.json")):
        rec = read_record(path, vault_id)
        if rec["attempt"] >= MAX_ATTEMPTS:
            rec.update(state="failed", error="SNAPSHOT_INTERRUPTED", last_failure="SNAPSHOT_INTERRUPTED", finished_at=now)
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
    if proof is LOCK_BUSY:
        next_attempt = clock() + BUSY_DELAY_MS
        for path, rec in claims:
            journal_deferral(path, rec, next_attempt)
        for path, rec in claims:
            finish_deferral(path, rec)
        return 0
    for path, rec in claims:
        if proof:
            prior = remembered_failure(rec)
            rec.update(state="completed", finished_at=clock(), **proof)
            rec.pop("error", None)
            if prior:
                rec["last_failure"] = prior
            else:
                rec.pop("last_failure", None)
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
