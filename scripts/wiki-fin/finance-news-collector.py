#!/usr/bin/env python3
"""Finance digest collector with a generate-only shadow path.

Hermes still owns /root/wiki-fin. This script must not write that tree, must not
write the central vault, must not Telegram-deliver, and must not call SkillWiki MCP.
Default mode is shadow.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import sys
import concurrent.futures
from datetime import datetime, timezone
from pathlib import Path

TOPICS = [
    "hong kong", "hkex", "hang seng", "hsi",
    "asia", "shanghai", "shenzhen", "nikkei", "sensex", "nifty",
    "us stock", "s&p 500", "sp500", "nasdaq", "dow jones", "nyse", "wall street",
    "fed ", "federal reserve", "interest rate", "treasury",
    "commodity", "crude oil", "brent", "wti", "gold", "silver", "copper", "iron ore",
    "crypto", "bitcoin", "btc", "ethereum", "eth", "solana", "binance",
    "forex", "currency", "dollar", "yuan", "cny", "yen", "jpy", "euro", "eur",
]

FEEDS = [
    ("https://feeds.reuters.com/reuters/businessNews", "Reuters Business"),
    ("https://feeds.reuters.com/reuters/financialsNews", "Reuters Financials"),
    ("https://www.scmp.com/rss/91/feed", "SCMP Business"),
    ("https://coincodex.com/rss/news.php", "CoinCodex Crypto"),
    ("https://www.forexlive.com/feed/", "ForexLive"),
    ("https://feeds.marketwatch.com/marketwatch/topstories/", "MarketWatch"),
    ("https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147", "CNBC Top News"),
    ("https://www.investing.com/rss/news_301.rss", "Investing.com News"),
]

TOPIC_RE = re.compile("|".join(TOPICS), re.IGNORECASE)
FORBIDDEN_WRITE_MARKERS = (
    "/root/wiki-fin",
    "/opt/skillwiki-mcp/vault",
    "/Users/karlchow/wiki",
)

MCP_PATH_PLAN = {
    "raw_articles_preview": "preview only; wiki_capture lands in raw/transcripts/ (not Hermes raw/articles dual-write)",
    "entities": "wiki_page_publish path=entities/<slug>.md vault=wiki-fin (Slice 6b+; forbidden in shadow)",
    "concepts": "wiki_page_publish path=concepts/<slug>.md vault=wiki-fin (Slice 6b+; forbidden in shadow)",
    "log": "wiki_log_append vault=wiki-fin (Slice 6b+; forbidden in shadow)",
    "index": "projection-owned; agents must not write index.md",
    "telegram": "disabled until coordinator approves cutover",
    "git_push": "forbidden; HTTP MCP is the sole agent writer",
}


def matches_topics(text: str) -> bool:
    return bool(TOPIC_RE.search(text))


def compute_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fetch_feed(url: str, source_name: str, max_items: int = 15):
    try:
        import feedparser  # type: ignore
    except ImportError:
        print("WARN: feedparser is not installed; live RSS fetch skipped", file=sys.stderr)
        return []
    try:
        socket.setdefaulttimeout(10)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            fut = pool.submit(feedparser.parse, url)
            feed = fut.result(timeout=15)
    except concurrent.futures.TimeoutError:
        print(f"  WARN: Timed out fetching {source_name}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"  WARN: Failed to fetch {source_name}: {e}", file=sys.stderr)
        return []
    finally:
        socket.setdefaulttimeout(None)

    results = []
    for entry in feed.entries[:max_items]:
        title = entry.get("title", "").strip()
        summary = entry.get("summary", "").strip()
        link = entry.get("link", "")
        published = entry.get("published", entry.get("updated", ""))
        summary_clean = re.sub(r"<[^>]+>", "", summary)
        text = f"{title} {summary_clean}"
        if matches_topics(text):
            results.append({
                "source": source_name,
                "title": title,
                "summary": summary_clean[:500],
                "link": link,
                "published": published,
            })
    return results


def refuse_canonical(path: Path) -> None:
    resolved = str(path.resolve())
    for marker in FORBIDDEN_WRITE_MARKERS:
        if resolved == marker or resolved.startswith(marker.rstrip("/") + "/"):
            raise SystemExit(f"refusing write under vault/Hermes tree: {resolved}")


def write_preview(out_dir: Path, unique: list[dict], now: datetime, date_str: str, timestamp: str) -> Path:
    refuse_canonical(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    by_source: dict[str, list] = {}
    for article in unique:
        by_source.setdefault(article["source"], []).append(article)
    md_lines = [
        "---",
        "source_url: multi-rss-aggregation",
        f"ingested: {date_str}",
        "sha256: TBD",
        "mode: shadow",
        "---",
        "",
        f"# Finance News Digest preview — {date_str}",
        "",
        f"Collected at {now.isoformat()} | {len(unique)} articles",
        "",
        "This file is generate-only. It is not a wiki-fin canonical page.",
        "",
    ]
    for source, articles in sorted(by_source.items()):
        md_lines.append(f"## {source}")
        md_lines.append("")
        for article in articles:
            md_lines.append(f"### {article['title']}")
            if article.get("published"):
                md_lines.append(f"**Published:** {article['published']}")
            if article.get("link"):
                md_lines.append(f"**Link:** {article['link']}")
            md_lines.append("")
            if article.get("summary"):
                md_lines.append(article["summary"])
            md_lines.append("")
    md_content = "\n".join(md_lines)
    body = md_content.split("---\n", 2)[-1]
    sha = compute_sha256(body)
    md_content = md_content.replace("sha256: TBD", f"sha256: {sha}")
    preview = out_dir / f"finance-digest-preview-{date_str}-{timestamp}.md"
    preview.write_text(md_content, encoding="utf-8")
    plan_path = out_dir / "mcp-path-plan.json"
    plan_path.write_text(json.dumps(MCP_PATH_PLAN, indent=2) + "\n", encoding="utf-8")
    return preview


def load_fixture(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    articles = payload.get("articles")
    if not isinstance(articles, list):
        raise SystemExit(f"fixture missing articles list: {path}")
    return articles


def main() -> int:
    parser = argparse.ArgumentParser(description="Finance digest collector (shadow by default)")
    parser.add_argument("--mode", choices=("shadow", "canonical"), default=os.environ.get("FINANCE_DIGEST_MODE", "shadow"))
    parser.add_argument("--out-dir", default=os.environ.get("FINANCE_DIGEST_OUT_DIR", ""))
    parser.add_argument("--fixture", default=os.environ.get("FINANCE_DIGEST_FIXTURE", ""))
    args = parser.parse_args()

    if args.mode != "shadow":
        print("canonical MCP/Telegram/Hermes writes are disabled in this dispatch", file=sys.stderr)
        return 2
    if os.environ.get("FINANCE_DIGEST_CANONICAL") == "1":
        print("FINANCE_DIGEST_CANONICAL=1 is refused until Slice 6d cutover", file=sys.stderr)
        return 2
    if os.environ.get("FINANCE_DIGEST_TELEGRAM") == "1":
        print("Telegram deliver is refused in shadow mode", file=sys.stderr)
        return 2

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    timestamp = now.strftime("%Y-%m-%dT%H-%MZ")
    out_dir = Path(args.out_dir or f"/tmp/wiki-fin-shadow-{timestamp}").expanduser()
    refuse_canonical(out_dir)

    if args.fixture:
        unique = load_fixture(Path(args.fixture))
        print(f"Loaded fixture {args.fixture} ({len(unique)} articles)", file=sys.stderr)
    else:
        all_articles = []
        for url, name in FEEDS:
            print(f"Fetching: {name}...", file=sys.stderr)
            articles = fetch_feed(url, name)
            print(f"  Found {len(articles)} matching articles", file=sys.stderr)
            all_articles.extend(articles)
        seen: set[str] = set()
        unique = []
        for article in all_articles:
            key = article["title"].lower().strip()[:80]
            if key not in seen:
                seen.add(key)
                unique.append(article)

    by_source: dict[str, int] = {}
    for article in unique:
        by_source[article["source"]] = by_source.get(article["source"], 0) + 1
    summary = {
        "date": date_str,
        "timestamp": timestamp,
        "count": len(unique),
        "sources": by_source,
        "headlines": [a["title"] for a in unique[:20]],
        "telegram_lang": os.environ.get("TELEGRAM_LANG", "zh-Hant"),
        "mode": "shadow",
        "vault": "wiki-fin",
        "canonical_write": False,
        "telegram_deliver": False,
        "mcp_url": "https://wiki.karldigi.dev/mcp",
        "required_vaults": ["wiki-fin"],
        "articles": unique,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    preview = write_preview(out_dir, unique, now, date_str, timestamp)
    print(json.dumps({
        "ok": True,
        "mode": "shadow",
        "out_dir": str(out_dir),
        "summary": str(summary_path),
        "preview": str(preview),
        "count": len(unique),
        "canonical_write": False,
        "telegram_deliver": False,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
