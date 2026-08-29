#!/usr/bin/env python3
"""RED tests for scripts/lint-skill-descriptions.py.

Numbers match wiki concept [[concepts/codex-skill-catalog-budget]]:
180 target, 220 CI fail, unique-canonical totals.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LINTER = REPO_ROOT / "scripts" / "lint-skill-descriptions.py"


def write_skill(path: Path, name: str, description: str, folded: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if folded:
        lines = "\n".join(f"  {part}" for part in description.split(" "))
        body = f"---\nname: {name}\ndescription: >-\n{lines}\n---\n\n# {name}\n"
    else:
        body = f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"
    path.write_text(body, encoding="utf-8")


def run_linter(root: Path, layout: str, max_skill: int = 220, max_total: int = 8000) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(LINTER),
            "--root",
            str(root),
            "--layout",
            layout,
            "--max-skill-chars",
            str(max_skill),
            "--max-total-chars",
            str(max_total),
        ],
        check=False,
        capture_output=True,
        text=True,
    )


class LintSkillDescriptionBudget(unittest.TestCase):
    def test_linter_exists(self) -> None:
        self.assertTrue(LINTER.is_file(), "scripts/lint-skill-descriptions.py must exist")

    def test_180_char_description_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_skill(
                root / "skills" / "sample" / "skills" / "sample" / "SKILL.md",
                "sample",
                "x" * 180,
            )
            result = run_linter(root, "agent-skills")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_221_char_description_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_skill(
                root / "skills" / "sample" / "skills" / "sample" / "SKILL.md",
                "sample",
                "x" * 221,
            )
            result = run_linter(root, "agent-skills", max_skill=220)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("sample", result.stdout + result.stderr)

    def test_folded_yaml_counts_full_description(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            words = ["word"] * 80
            description = " ".join(words)
            self.assertGreater(len(description), 220)
            write_skill(
                root / "skills" / "folded" / "SKILL.md",
                "folded",
                description,
                folded=True,
            )
            result = run_linter(root, "agent-skills")
            self.assertNotEqual(result.returncode, 0)
            combined = result.stdout + result.stderr
            self.assertIn("folded", combined)

    def test_llm_wiki_ignores_skills_skills_mirror(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            desc = "Short wiki query skill. Use when searching the vault."
            write_skill(root / "packages" / "skills" / "wiki-query" / "SKILL.md", "wiki-query", desc)
            write_skill(
                root / "packages" / "skills" / "skills" / "wiki-query" / "SKILL.md",
                "wiki-query",
                "x" * 400,
            )
            result = run_linter(root, "llm-wiki")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_combined_total_over_cap_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_skill(
                root / "skills" / "one" / "skills" / "one" / "SKILL.md",
                "one",
                "a" * 180,
            )
            write_skill(
                root / "skills" / "two" / "skills" / "two" / "SKILL.md",
                "two",
                "b" * 180,
            )
            result = run_linter(root, "agent-skills", max_total=200)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("total", (result.stdout + result.stderr).lower())


if __name__ == "__main__":
    unittest.main()
