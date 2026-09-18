#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLLECTOR = ROOT / "scripts/wiki-fin/finance-news-collector.py"
FIXTURE = ROOT / "scripts/wiki-fin/fixtures/sample-headlines.json"


def run(args, env=None):
    return subprocess.run(
        [sys.executable, str(COLLECTOR), *args],
        cwd=str(ROOT),
        env={**os.environ, **(env or {})},
        capture_output=True,
        text=True,
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "shadow"
        proc = run(["--mode", "shadow", "--out-dir", str(out), "--fixture", str(FIXTURE)])
        if proc.returncode != 0:
            print(proc.stderr)
            print(proc.stdout)
            return 1
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        assert payload["canonical_write"] is False
        assert payload["telegram_deliver"] is False
        summary = json.loads((out / "summary.json").read_text())
        assert summary["vault"] == "wiki-fin"
        assert summary["count"] == 2
        assert (out / "mcp-path-plan.json").exists()
        forbidden = run(["--mode", "canonical", "--out-dir", str(out), "--fixture", str(FIXTURE)])
        assert forbidden.returncode == 2
        telegram = run(
            ["--mode", "shadow", "--out-dir", str(out), "--fixture", str(FIXTURE)],
            env={"FINANCE_DIGEST_TELEGRAM": "1"},
        )
        assert telegram.returncode == 2
        vault_out = Path(tmp) / "opt-vault"
        # refuse_canonical only matches exact forbidden prefixes; simulate central vault path
        fake_central = Path("/opt/skillwiki-mcp/vault")
        if fake_central.exists():
            refused = run(["--mode", "shadow", "--out-dir", str(fake_central), "--fixture", str(FIXTURE)])
            assert refused.returncode != 0
        print("PASS wiki-fin collector shadow")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
