import importlib.util
import json
import os
import subprocess
import time
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
        def fake(text, code):
            def run(*args, **kwargs):
                kwargs["stdout"].write(text.encode())
                return type("Result",(),{"returncode":code, "wait":lambda self, **kw: code})()
            return run
        prefix="SNAPSHOT_COMPLETE schema=v1 outcome=pushed result=success ts=2026-10-28T00:00:00Z head="
        for text, code, valid in [("skip",0,False),(prefix+"a"*40+" origin="+"b"*40,0,False),(prefix+"a"*40+" origin="+"a"*40,1,False),(prefix+"a"*40+" origin="+"a"*40,0,True)]:
            with patch.object(w.subprocess,"Popen",fake(text,code)):
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
