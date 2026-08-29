#!/usr/bin/env python3
"""Lint SKILL.md description length for the Codex catalog budget.

Source of truth: wiki concept [[concepts/codex-skill-catalog-budget]]
  - 180 character authoring target
  - CI fail above 220 characters per unique canonical skill
  - Combined unique-canonical cap split per repo (pass --max-total-chars)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SKIP_PARTS = {".git", "archive", "dist", "node_modules", "raw"}
DEFAULT_MAX_SKILL = 220


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--layout", choices=("agent-skills", "llm-wiki"), required=True)
    parser.add_argument("--max-skill-chars", type=int, default=DEFAULT_MAX_SKILL)
    parser.add_argument("--max-total-chars", type=int, required=True)
    return parser.parse_args()


def extract_description(text: str) -> str | None:
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    lines = parts[1].lstrip("\n").splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("description:"):
            continue
        raw = line[len("description:") :].strip()
        if raw in {">", ">-", "|", "|-"}:
            block: list[str] = []
            for follow in lines[i + 1 :]:
                if follow.startswith("  ") or follow.startswith("\t"):
                    block.append(follow.strip())
                elif follow.strip() == "":
                    continue
                else:
                    break
            joined = " ".join(part for part in block if part)
            return re.sub(r"\s+", " ", joined).strip()
        if (raw.startswith('"') and raw.endswith('"')) or (
            raw.startswith("'") and raw.endswith("'")
        ):
            return raw[1:-1]
        return raw
    return None


def skipped(path: Path) -> bool:
    return any(part in SKIP_PARTS for part in path.parts)


def iter_skill_files(root: Path, layout: str) -> list[Path]:
    files: list[Path] = []
    if layout == "agent-skills":
        # Nested canonical first so first-wins in canonical_records prefers it.
        files.extend(root.glob("skills/*/skills/*/SKILL.md"))
        files.extend(root.glob("skills/*/SKILL.md"))
    else:
        files.extend(root.glob("packages/skills/*/SKILL.md"))
        files.extend(root.glob("packages/vault-sync/skills/*/SKILL.md"))
    return [p for p in files if p.is_file() and not skipped(p)]


def canonical_records(root: Path, layout: str) -> list[tuple[str, str, Path]]:
    by_name: dict[str, tuple[str, Path]] = {}
    for path in iter_skill_files(root, layout):
        text = path.read_text(encoding="utf-8")
        description = extract_description(text)
        if description is None:
            continue
        name_match = re.search(r"^name:\s*(.+)$", text, re.M)
        name = name_match.group(1).strip().strip("\"'") if name_match else path.parent.name
        if name not in by_name:
            by_name[name] = (description, path)
    return [(name, desc, path) for name, (desc, path) in sorted(by_name.items())]


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    records = canonical_records(root, args.layout)
    errors: list[str] = []
    total = 0
    for name, description, path in records:
        length = len(description)
        total += length
        if length > args.max_skill_chars:
            rel = path.relative_to(root)
            errors.append(
                f"{name}: {length} chars (max {args.max_skill_chars}) in {rel}"
            )
    if total > args.max_total_chars:
        errors.append(
            f"unique-canonical total {total} chars exceeds max total {args.max_total_chars}"
        )
    if errors:
        print("skill description budget failed:")
        for item in errors:
            print(f"  {item}")
        print(f"counted {len(records)} unique skills, {total} description chars")
        return 1
    print(
        f"ok: {len(records)} unique skills, {total} description chars "
        f"(max skill {args.max_skill_chars}, max total {args.max_total_chars})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
