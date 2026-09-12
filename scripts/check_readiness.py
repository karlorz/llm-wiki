#!/usr/bin/env python3
"""SkillWiki HTTP MCP plugin readiness probe.

Interface: probe(environ) -> {status, reasons, url, migrated, warnings}.
Does not write ~/.cursor/mcp.json, config.toml, or mcp.env.
Never prints SKILLWIKI_MCP_TOKEN.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Mapping

PRODUCTION_MCP_URL = "https://wiki.karldigi.dev/mcp"
TOKEN_ENV = "SKILLWIKI_MCP_TOKEN"
URL_ENV = "SKILLWIKI_MCP_URL"


def _strip(value: str | None) -> str:
    return (value or "").strip()


def probe(environ: Mapping[str, str] | None = None) -> dict:
    source = os.environ if environ is None else environ
    token = _strip(source.get(TOKEN_ENV))
    url = _strip(source.get(URL_ENV))
    warnings: list[str] = []
    reasons: list[str] = []

    if not token:
        return {
            "status": "missing_prereq",
            "reasons": [f"{TOKEN_ENV} unset"],
            "url": url or None,
            "migrated": False,
            "warnings": warnings,
        }

    migrated = False
    if not url:
        url = PRODUCTION_MCP_URL
        migrated = True
        reasons.append(f"{URL_ENV} empty; using {PRODUCTION_MCP_URL}")

    return {
        "status": "in_sync",
        "reasons": reasons,
        "url": url,
        "migrated": migrated,
        "warnings": warnings,
    }


def apply(environ: dict[str, str] | None = None) -> dict:
    """Apply the URL default to this process and Claude's env handoff only."""
    target = os.environ if environ is None else environ
    result = probe(target)
    if result["status"] != "in_sync" or not result.get("migrated"):
        return result
    url = result["url"]
    target[URL_ENV] = url
    env_file = _strip(target.get("CLAUDE_ENV_FILE"))
    if env_file:
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"export {URL_ENV}={url}\n")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="skillwiki HTTP MCP readiness probe")
    parser.add_argument("--json", action="store_true", help="print JSON verdict")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="set SKILLWIKI_MCP_URL in this child process and Claude's CLAUDE_ENV_FILE when TOKEN is set",
    )
    args = parser.parse_args(argv)
    result = apply() if args.apply else probe()
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["status"] == "in_sync" else 2


if __name__ == "__main__":
    sys.exit(main())
