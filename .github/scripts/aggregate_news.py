import json
import os
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import requests

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OUTPUT_FILE = Path(__file__).parent.parent.parent / "data" / "briefing.json"

RSS_FEEDS = [
    ("Google News", "https://news.google.com/rss/search?q=Texas+Longhorns+football&hl=en-US&gl=US&ceid=US:en"),
    ("ESPN CFB",    "https://www.espn.com/espn/rss/ncf/news"),
    ("Google News Recruiting", "https://news.google.com/rss/search?q=Texas+Longhorns+football+recruiting&hl=en-US&gl=US&ceid=US:en"),
]

HEADERS = {"User-Agent": "TowerReport/1.0 (+https://tower-report.vercel.app)"}


def fetch_rss(name, url, max_items=8):
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        items = []
        for item in root.findall(".//item")[:max_items]:
            title = (item.findtext("title") or "").strip()
            desc  = (item.findtext("description") or "").strip()
            link  = (item.findtext("link") or "").strip()
            pub   = (item.findtext("pubDate") or "").strip()
            if title:
                items.append({"title": title, "description": desc[:300], "source": name, "link": link, "pubDate": pub})
        return items
    except Exception as e:
        print(f"[WARN] Could not fetch {name}: {e}", file=sys.stderr)
        return []


def call_claude(news_items):
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    news_text = "\n".join(
        f"- [{item['source']}] {item['title']} — {item['description'][:200]}"
        for item in news_items
    )

    prompt = f"""You are the editor of Tower Report, an AI-powered Texas Longhorns football intelligence platform.

Given these recent news items about Texas Longhorns football:

{news_text}

Generate a JSON response in this exact format (no markdown, just raw JSON):
{{
  "briefing": [
    {{"category": "Recruiting", "text": "One sharp intel sentence about recruiting news.", "source": "source name"}},
    {{"category": "Roster", "text": "One sharp intel sentence about roster/player news.", "source": "source name"}},
    {{"category": "Portal", "text": "One sharp intel sentence about transfer portal news.", "source": "source name"}},
    {{"category": "Program", "text": "One sharp intel sentence about the program/coaching/facilities.", "source": "source name"}},
    {{"category": "NIL", "text": "One sharp intel sentence about NIL or player business news.", "source": "source name"}}
  ],
  "stories": [
    {{
      "headline": "Compelling headline (max 10 words)",
      "summary": "Two clear sentences that inform a serious fan.",
      "category": "Analysis",
      "kicker": "TOWER ANALYSIS"
    }},
    {{
      "headline": "...",
      "summary": "...",
      "category": "Recruiting",
      "kicker": "RECRUITING"
    }},
    {{
      "headline": "...",
      "summary": "...",
      "category": "Program",
      "kicker": "PROGRAM"
    }}
  ]
}}

Rules:
- Be factual. Only report what is in the news items provided.
- If a category has no relevant news, write a brief status note (e.g. "No new portal activity reported today.").
- Headlines should be sharp and specific — like The Athletic, not like a press release.
- Do NOT make up stats, names, or events not present in the source material.
- Output ONLY the raw JSON object, nothing else."""

    response = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=30,
    )
    response.raise_for_status()
    raw = response.json()["content"][0]["text"].strip()

    # Strip markdown code fences if Claude wraps in them
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
        raw = raw.rsplit("```", 1)[0]

    return json.loads(raw)


def load_existing():
    if OUTPUT_FILE.exists():
        with open(OUTPUT_FILE) as f:
            return json.load(f)
    return None


def save(data):
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(data, f, indent=2)
    print(f"[OK] Saved briefing to {OUTPUT_FILE}")


def main():
    print("[INFO] Fetching news feeds...")
    all_items = []
    for name, url in RSS_FEEDS:
        items = fetch_rss(name, url)
        print(f"[INFO]   {name}: {len(items)} items")
        all_items.extend(items)

    if len(all_items) < 3:
        print("[WARN] Not enough news items — keeping existing briefing", file=sys.stderr)
        sys.exit(0)

    print(f"[INFO] Calling Claude API with {len(all_items)} news items...")
    try:
        result = call_claude(all_items)
    except Exception as e:
        print(f"[ERROR] Claude API call failed: {e}", file=sys.stderr)
        # Update timestamp on existing data so the site shows it tried
        existing = load_existing()
        if existing:
            existing["lastUpdated"] = datetime.now(timezone.utc).isoformat()
            save(existing)
        sys.exit(0)

    output = {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "briefing": result.get("briefing", []),
        "stories": result.get("stories", []),
    }

    save(output)
    print(f"[OK] Briefing updated: {len(output['briefing'])} intel items, {len(output['stories'])} stories")


if __name__ == "__main__":
    main()
