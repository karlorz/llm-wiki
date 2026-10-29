import importlib.util
import io
import json
import os
import subprocess
import time
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[1] / "scripts/wiki-snapshot-requests.py")
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

class Requests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = w.safe_state(str(Path(self.tmp.name).resolve()) + "/state", str(Path(self.tmp.name).resolve()) + "/vault")
    def tearDown(self):
        self.tmp.cleanup()
    def add(self, area="pending", attempt=0):
        key = str(uuid.uuid4())
        rec = dict(request_id=key, vault_id="central", state="queued", attempt=attempt, created_at=0, next_attempt=0)
        w.write_record(self.root / area / (key + ".json"), rec)
        return key
    def receipt(self, key):
        return json.loads((self.root / "receipts" / (key + ".json")).read_text())
    def test_root_replacements_keep_spool_owner(self):
        real_chown = os.fchown
        with patch.object(w.os, "geteuid", return_value=0), patch.object(w.os, "fchown", wraps=real_chown) as chown:
            key = self.add()
            w.process(self.root, "central", lambda: dict(head="a"*40, origin="a"*40), now=100000)
        self.assertGreaterEqual(chown.call_count, 3)
        expected = (self.root / "receipts").stat()
        actual = (self.root / "receipts" / (key + ".json")).stat()
        self.assertEqual((actual.st_uid, actual.st_gid), (expected.st_uid, expected.st_gid))
        self.assertEqual(actual.st_mode & 0o777, 0o600)
    def test_coalesces_and_keeps_concurrent_arrivals(self):
        a, b = self.add(), self.add()
        late = []
        def run():
            late.append(self.add())
            return dict(head="a"*40, origin="a"*40)
        self.assertEqual(w.process(self.root,"central",run,now=100000), 0)
        self.assertEqual(self.receipt(a)["state"], "completed")
        self.assertEqual(self.receipt(b)["state"], "completed")
        self.assertTrue((self.root / "pending" / (late[0]+".json")).exists())
    def test_failure_backoff_cap_and_interrupted_recovery(self):
        key=self.add("running",1)
        w.process(self.root,"central",lambda:None,now=100000)
        self.assertEqual(self.receipt(key)["error"],"SNAPSHOT_INTERRUPTED")
        self.assertEqual(self.receipt(key)["attempt"],1)
        w.process(self.root,"central",lambda:None,now=200000)
        self.assertEqual(self.receipt(key)["attempt"],2)
        w.process(self.root,"central",lambda:None,now=400000)
        self.assertEqual(self.receipt(key)["attempt"],3)
        w.process(self.root,"central",lambda: self.fail("retry cap"),now=1000000)
        self.assertFalse(list((self.root/"pending").glob("*.json")))
    def test_exit_zero_requires_this_invocation_matching_proof(self):
        prefix="SNAPSHOT_COMPLETE schema=v1 outcome=pushed result=success ts=2026-10-28T00:00:00Z head="
        for text, code, valid in [("skip",0,False),(prefix+"a"*40+" origin="+"b"*40,0,False),(prefix+"a"*40+" origin="+"a"*40,1,False),(prefix+"a"*40+" origin="+"a"*40,0,True)]:
            with patch.object(w.subprocess,"Popen",self.popen_fake(text,code)):
                self.assertEqual(w.execute_snapshot() is not None,valid)
    def test_completion_and_retry_use_post_run_clock(self):
        key = self.add()
        with patch.object(w.time, "time", side_effect=[100, 150]):
            w.process(self.root, "central", lambda: dict(head="a"*40, origin="a"*40))
        self.assertEqual(self.receipt(key)["started_at"], 100000)
        self.assertEqual(self.receipt(key)["finished_at"], 150000)
        key = self.add()
        with patch.object(w.time, "time", side_effect=[200, 250]):
            w.process(self.root, "central", lambda: None)
        self.assertEqual(self.receipt(key)["finished_at"], 250000)
        self.assertEqual(self.receipt(key)["next_attempt"], 310000)
    def test_rejects_invalid_numbers_and_attempts(self):
        key = self.add()
        path = self.root / "pending" / (key + ".json")
        original = json.loads(path.read_text())
        for field in ("attempt", "created_at", "next_attempt", "started_at", "finished_at"):
            invalid = [True, False, float("nan"), float("inf"), 10**400, -1, "1", None]
            if field == "attempt":
                invalid += [1.5, 1.0, w.MAX_ATTEMPTS + 1]
            for value in invalid:
                with self.subTest(field=field, value=value):
                    path.write_text(json.dumps(dict(original, **{field: value})))
                    with self.assertRaises(ValueError):
                        w.read_record(path, "central")
    def test_timeout_kills_runner_and_grandchild(self):
        # Replace only the installed sibling location; execute a real process tree.
        runner = Path(self.tmp.name) / "wiki-snapshot.sh"
        marker = Path(self.tmp.name) / "escaped"
        pidfile = Path(self.tmp.name) / "child.pid"
        runner.write_text('#!/bin/sh\n(sleep 1; touch "' + str(marker) + '") &\necho $! > "' + str(pidfile) + '"\nwait\n')
        runner.chmod(0o700)
        real_popen = subprocess.Popen
        leaders = []
        def start(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            leaders.append(process)
            deadline = time.monotonic() + 5
            while not pidfile.exists():
                if process.poll() is not None or time.monotonic() >= deadline:
                    process.kill()
                    process.wait()
                    self.fail("runner never spawned grandchild")
                time.sleep(0.01)
            return process
        with patch.object(w, "__file__", str(Path(self.tmp.name) / "worker.py")), patch.object(w.subprocess, "Popen", start):
            self.assertIsNone(w.execute_snapshot(timeout=0.25))
        self.assertEqual(leaders[0].returncode, -9)
        with self.assertRaises(ChildProcessError):
            os.waitpid(leaders[0].pid, os.WNOHANG)  # leader already reaped
        time.sleep(1.1)
        self.assertTrue(pidfile.exists())
        self.assertFalse(marker.exists(), "grandchild survived timeout")
    def pending(self, key):
        return json.loads((self.root / "pending" / (key + ".json")).read_text())
    def popen_fake(self, text, code):
        def run(*args, **kwargs):
            kwargs["stdout"].write(text.encode())
            return type("Result",(),{"returncode":code, "wait":lambda self, **kw: code})()
        return run
    def test_repeated_busy_defers_without_spending_attempts(self):
        key = self.add()
        now = 100000
        for _ in range(6):
            self.assertEqual(w.process(self.root, "central", lambda: w.LOCK_BUSY, now=now), 0)
            receipt, pending = self.receipt(key), self.pending(key)
            self.assertEqual((receipt["state"], receipt["error"], receipt["attempt"]), ("queued", "SNAPSHOT_LOCK_BUSY", 0))
            self.assertEqual((pending["state"], pending["error"], pending["attempt"]), ("queued", "SNAPSHOT_LOCK_BUSY", 0))
            self.assertEqual((receipt["next_attempt"], pending["next_attempt"]), (now + 60000, now + 60000))
            self.assertFalse(list((self.root / "running").glob("*.json")))
            w.process(self.root, "central", lambda: self.fail("not due before +60s"), now=now + 59999)
            now += 60000
        self.assertEqual(w.process(self.root, "central", lambda: dict(head="a"*40, origin="a"*40), now=now), 0)
        self.assertEqual((self.receipt(key)["state"], self.receipt(key)["attempt"]), ("completed", 1))
        self.assertNotIn("error", self.receipt(key))
        self.assertNotIn("last_failure", self.receipt(key))
    def test_busy_preserves_real_prior_failures_and_cap(self):
        key = self.add()
        w.process(self.root, "central", lambda: None, now=100000)
        self.assertEqual(self.receipt(key)["state"], "failed")
        for now in (200000, 300000, 400000, 500000):
            w.process(self.root, "central", lambda: w.LOCK_BUSY, now=now)
            receipt = self.receipt(key)
            self.assertEqual((receipt["state"], receipt["error"], receipt["attempt"]), ("queued", "SNAPSHOT_LOCK_BUSY", 1))
            self.assertEqual(receipt["last_failure"], "SNAPSHOT_COMPLETION_UNPROVEN")
        w.process(self.root, "central", lambda: None, now=600000)
        self.assertEqual((self.receipt(key)["state"], self.receipt(key)["attempt"]), ("failed", 2))
        w.process(self.root, "central", lambda: w.LOCK_BUSY, now=800000)
        self.assertEqual(self.receipt(key)["attempt"], 2)
        w.process(self.root, "central", lambda: None, now=900000)
        self.assertEqual((self.receipt(key)["state"], self.receipt(key)["attempt"]), ("failed", 3))
        self.assertFalse(list((self.root / "pending").glob("*.json")))
        w.process(self.root, "central", lambda: self.fail("terminal request revived"), now=10**7)
    def test_crash_during_deferral_neither_counts_failure_nor_double_refunds(self):
        for crash_after in (2, 3, 4):
            with self.subTest(crash_after=crash_after):
                key = self.add(attempt=1)
                real_write, calls = w.write_record, []
                def crash(path, record):
                    real_write(path, record)
                    calls.append(path)
                    if len(calls) == crash_after:
                        raise KeyboardInterrupt()
                with patch.object(w, "write_record", crash), self.assertRaises(KeyboardInterrupt):
                    w.process(self.root, "central", lambda: w.LOCK_BUSY, now=100000)
                self.assertEqual(self.pending_or_running_attempt(key), 1)
                w.process(self.root, "central", lambda: self.fail("deferred request not due"), now=130000)
                receipt, pending = self.receipt(key), self.pending(key)
                self.assertEqual((receipt["state"], receipt["error"], receipt["attempt"]), ("queued", "SNAPSHOT_LOCK_BUSY", 1))
                self.assertEqual((pending["state"], pending["error"], pending["attempt"]), ("queued", "SNAPSHOT_LOCK_BUSY", 1))
                self.assertFalse(list((self.root / "running").glob("*.json")))
                w.process(self.root, "central", lambda: dict(head="a"*40, origin="a"*40), now=200000)
                self.assertEqual((self.receipt(key)["state"], self.receipt(key)["attempt"]), ("completed", 2))
    def pending_or_running_attempt(self, key):
        for area in ("running", "pending"):
            path = self.root / area / (key + ".json")
            if path.exists():
                return json.loads(path.read_text())["attempt"]
    def test_recovery_journals_batch_before_removing_its_busy_witness(self):
        keys = sorted([self.add("running", 2) for _ in range(3)])
        for i, key in enumerate(keys):
            path = self.root / "running" / (key + ".json")
            rec = json.loads(path.read_text())
            rec.update(state="running", started_at=100000)
            if i == 0:
                rec.update(state="queued", error="SNAPSHOT_LOCK_BUSY", attempt=1, next_attempt=160000)
            w.write_record(path, rec)
        real_unlink = Path.unlink
        def crash_after_first_removal(path, *args, **kwargs):
            real_unlink(path, *args, **kwargs)
            if path == self.root / "running" / (keys[0] + ".json"):
                raise KeyboardInterrupt()
        with patch.object(Path, "unlink", crash_after_first_removal), self.assertRaises(KeyboardInterrupt):
            w.process(self.root, "central", lambda: self.fail("not due"), now=130000)
        w.process(self.root, "central", lambda: self.fail("not due"), now=130000)
        for key in keys:
            rec = self.receipt(key)
            self.assertEqual((rec["state"], rec["attempt"], rec["error"]), ("queued", 1, "SNAPSHOT_LOCK_BUSY"))
        self.assertFalse(list((self.root / "running").glob("*.json")))
    def test_real_interruption_stays_bounded_and_counted(self):
        key = self.add("running", 1)
        w.process(self.root, "central", lambda: self.fail("backoff"), now=100000)
        receipt = self.receipt(key)
        self.assertEqual((receipt["state"], receipt["error"], receipt["attempt"]), ("failed", "SNAPSHOT_INTERRUPTED", 1))
    def test_deferred_journal_never_revives_terminal_or_completed_requests(self):
        for receipt in (dict(state="failed", error="SNAPSHOT_INTERRUPTED", attempt=3), dict(state="completed", attempt=1)):
            with self.subTest(receipt=receipt["state"]):
                key = str(uuid.uuid4())
                base = dict(request_id=key, vault_id="central", created_at=0, next_attempt=0)
                w.write_record(self.root / "receipts" / (key + ".json"), dict(base, **receipt))
                w.write_record(self.root / "running" / (key + ".json"), dict(base, state="queued", error="SNAPSHOT_LOCK_BUSY", attempt=2))
                w.process(self.root, "central", lambda: self.fail("revived"), now=100000)
                self.assertFalse(list((self.root / "pending").glob("*.json")))
                self.assertFalse(list((self.root / "running").glob("*.json")))
                self.assertEqual(self.receipt(key)["state"], receipt["state"])
    def test_busy_requires_both_marker_and_exit_75(self):
        marker = "SNAPSHOT_LOCK_BUSY schema=v1 result=busy exit=75\n"
        proof = "SNAPSHOT_COMPLETE schema=v1 outcome=pushed result=success ts=2026-10-28T00:00:00Z head=" + "a"*40 + " origin=" + "a"*40 + "\n"
        cases = [
            ("log\n" + marker, 75, w.LOCK_BUSY),
            (marker, 1, None), (marker, 0, None), (marker, 76, None),
            ("lock held\n", 75, None), ("", 75, None),
            ("SNAPSHOT_LOCK_BUSY schema=v1 result=busy exit=76\n", 75, None),
            ("SNAPSHOT_LOCK_BUSY schema=v2 result=busy exit=75\n", 75, None),
            (marker + "later output\n", 75, None),
            (proof + marker, 75, None),
            ("x" + marker, 75, None),
        ]
        for text, code, expected in cases:
            with self.subTest(text=text, code=code), patch.object(w.subprocess, "Popen", self.popen_fake(text, code)):
                self.assertEqual(w.execute_snapshot(), expected)
    def test_recovered_unproven_keeps_last_failure(self):
        key = self.add()
        w.process(self.root, "central", lambda: None, now=100000)
        self.assertEqual((self.receipt(key)["state"], self.receipt(key)["error"], self.receipt(key)["attempt"]), ("failed", "SNAPSHOT_COMPLETION_UNPROVEN", 1))
        self.assertEqual(self.receipt(key)["last_failure"], "SNAPSHOT_COMPLETION_UNPROVEN")
        w.process(self.root, "central", lambda: dict(head="a"*40, origin="a"*40), now=200000)
        receipt = self.receipt(key)
        self.assertEqual((receipt["state"], receipt["attempt"]), ("completed", 2))
        self.assertNotIn("error", receipt)
        self.assertEqual(receipt["last_failure"], "SNAPSHOT_COMPLETION_UNPROVEN")
    def test_completed_last_failure_uses_latest_genuine_class(self):
        key = self.add("running", 1)
        w.process(self.root, "central", lambda: None, now=100000)
        self.assertEqual((self.receipt(key)["error"], self.receipt(key)["last_failure"]), ("SNAPSHOT_INTERRUPTED", "SNAPSHOT_INTERRUPTED"))
        w.process(self.root, "central", lambda: w.LOCK_BUSY, now=200000)
        self.assertEqual((self.receipt(key)["error"], self.receipt(key)["last_failure"], self.receipt(key)["attempt"]), ("SNAPSHOT_LOCK_BUSY", "SNAPSHOT_INTERRUPTED", 1))
        w.process(self.root, "central", lambda: None, now=300000)
        self.assertEqual((self.receipt(key)["error"], self.receipt(key)["last_failure"], self.receipt(key)["attempt"]), ("SNAPSHOT_COMPLETION_UNPROVEN", "SNAPSHOT_COMPLETION_UNPROVEN", 2))
        w.process(self.root, "central", lambda: dict(head="a"*40, origin="a"*40), now=500000)
        receipt = self.receipt(key)
        self.assertEqual((receipt["state"], receipt["attempt"]), ("completed", 3))
        self.assertNotIn("error", receipt)
        self.assertEqual(receipt["last_failure"], "SNAPSHOT_COMPLETION_UNPROVEN")
    def capture_execute(self, text, code):
        buf = io.StringIO()
        with patch.object(w.subprocess, "Popen", self.popen_fake(text, code)), redirect_stdout(buf):
            result = w.execute_snapshot()
        return result, buf.getvalue()
    def test_unproven_runner_journals_timestamped_fail_marker(self):
        text = (
            "2026-10-28 21:50:23 delete-intent: no-resurrect pass complete\n"
            "2026-10-28 21:50:26 ERROR: projection worktree parity mismatch expected_index_sha256=abc\n"
            "2026-10-28 21:50:26 FAIL projection candidate verification; snapshot promotion refused\n"
        )
        result, out = self.capture_execute(text, 1)
        self.assertIsNone(result)
        line = out.strip()
        self.assertTrue(line.startswith("snapshot request unproven reason=proof_missing exit=1 marker="))
        self.assertIn("FAIL projection candidate verification; snapshot promotion refused", line)
        self.assertNotIn("2026-10-28 21:50:26 FAIL", line)
        self.assertNotIn("delete-intent", line)
    def test_proven_busy_and_success_stay_quiet(self):
        marker = "SNAPSHOT_LOCK_BUSY schema=v1 result=busy exit=75\n"
        proof = "SNAPSHOT_COMPLETE schema=v1 outcome=pushed result=success ts=2026-10-28T00:00:00Z head=" + "a"*40 + " origin=" + "a"*40 + "\n"
        result, out = self.capture_execute("2026-10-28 21:50:00 ERROR: Another instance\n" + marker, 75)
        self.assertIs(result, w.LOCK_BUSY)
        self.assertEqual(out, "")
        result, out = self.capture_execute(proof, 0)
        self.assertEqual(result, {"head": "a"*40, "origin": "a"*40})
        self.assertEqual(out, "")
    def test_marker_sanitizes_controls_and_bounds_length(self):
        payload = "FAIL " + ("x" * 300) + "\x1b[31msecret\x07"
        result, out = self.capture_execute("2026-10-28 21:50:26 " + payload + "\n", 1)
        self.assertIsNone(result)
        marker = out.strip().split("marker=", 1)[1]
        self.assertLessEqual(len(marker), 240)
        self.assertFalse(any(ord(ch) < 32 or ord(ch) == 127 for ch in marker))
        self.assertTrue(marker.startswith("FAIL "))
    def test_invalid_busy_pair_counts_as_genuine_failure(self):
        key = self.add()
        with patch.object(w.subprocess, "Popen", self.popen_fake("SNAPSHOT_LOCK_BUSY schema=v1 result=busy exit=75\n", 1)):
            w.process(self.root, "central", w.execute_snapshot, now=100000)
        receipt = self.receipt(key)
        self.assertEqual((receipt["state"], receipt["error"], receipt["attempt"]), ("failed", "SNAPSHOT_COMPLETION_UNPROVEN", 1))
    def test_installed_sibling_lock_busy_exit_is_recognized(self):
        runner = Path(self.tmp.name) / "wiki-snapshot.sh"
        runner.write_text('#!/bin/sh\necho "ERROR: Another instance"\necho "SNAPSHOT_LOCK_BUSY schema=v1 result=busy exit=75"\nexit 75\n')
        runner.chmod(0o700)
        with patch.object(w, "__file__", str(Path(self.tmp.name) / "worker.py")):
            self.assertEqual(w.execute_snapshot(), w.LOCK_BUSY)
        runner.write_text('#!/bin/sh\necho "flock: bad file descriptor"\nexit 71\n')
        with patch.object(w, "__file__", str(Path(self.tmp.name) / "worker.py")):
            self.assertIsNone(w.execute_snapshot())
    def test_interruption_before_last_claim_becomes_terminal(self):
        key=self.add(attempt=3)
        w.process(self.root,"central",lambda:self.fail("cap"),now=100000)
        self.assertEqual(self.receipt(key)["state"],"failed")
        self.assertFalse(list((self.root/"pending").glob("*.json")))
    def test_unsafe_state_and_record_symlinks(self):
        with self.assertRaises(ValueError): w.safe_state(self.tmp.name+"/vault/state",self.tmp.name+"/vault")
        key=str(uuid.uuid4()); path=self.root/"pending"/(key+".json"); path.symlink_to("/etc/passwd")
        with self.assertRaises(OSError): w.read_record(path,"central")

if __name__ == "__main__": unittest.main()
