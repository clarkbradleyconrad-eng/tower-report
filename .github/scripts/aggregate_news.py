import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import requests

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OUTPUT_FILE = Path(__file__).parent.parent.parent / "data" / "briefing.json"

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; TowerReport/1.0; +https://tower-report.vercel.app)"}

# ── RSS FEEDS ─────────────────────────────────────────────────────────────────
RSS_FEEDS = [
    # Google News targeted searches
    ("Google News",           "https://news.google.com/rss/search?q=Texas+Longhorns+football&hl=en-US&gl=US&ceid=US:en"),
    ("GN Recruiting",         "https://news.google.com/rss/search?q=Texas+Longhorns+football+recruiting&hl=en-US&gl=US&ceid=US:en"),
    ("GN Transfer Portal",    "https://news.google.com/rss/search?q=Texas+Longhorns+transfer+portal&hl=en-US&gl=US&ceid=US:en"),
    ("GN Arch Manning",       "https://news.google.com/rss/search?q=Arch+Manning+Texas&hl=en-US&gl=US&ceid=US:en"),
    ("GN Sarkisian",          "https://news.google.com/rss/search?q=Steve+Sarkisian+Texas+Longhorns&hl=en-US&gl=US&ceid=US:en"),
    ("GN Colin Simmons",      "https://news.google.com/rss/search?q=Colin+Simmons+Texas+Longhorns&hl=en-US&gl=US&ceid=US:en"),
    ("GN Texas SEC",          "https://news.google.com/rss/search?q=Texas+Longhorns+SEC+football&hl=en-US&gl=US&ceid=US:en"),
    ("GN Texas NIL",          "https://news.google.com/rss/search?q=Texas+Longhorns+NIL&hl=en-US&gl=US&ceid=US:en"),
    # Major sports outlets
    ("ESPN CFB",              "https://www.espn.com/espn/rss/ncf/news"),
    ("CBS Sports CFB",        "https://www.cbssports.com/rss/headlines/college-football/"),
    ("Yahoo Sports CFB",      "https://sports.yahoo.com/college-football/rss.xml"),
    ("Bleacher Report CFB",   "https://bleacherreport.com/college-football.rss"),
    # Texas-specific outlets
    ("Burnt Orange Nation",   "https://www.burntorangenation.com/rss/current"),
    ("Reddit Longhorns",      "https://www.reddit.com/r/texaslonghorns/.rss?limit=10&sort=new"),
    ("Daily Texan Sports",    "https://thedailytexan.com/category/sports/rss.xml"),
]

# ── YOUTUBE CHANNELS ──────────────────────────────────────────────────────────
# Channel IDs for RSS — no API key required
# Format: https://www.youtube.com/feeds/videos.xml?channel_id=ID
YOUTUBE_CHANNELS = [
    ("Texas Longhorns Official", "UCmXiQhDMqpHCVlBFwLSSb2A"),
    ("Burnt Orange Nation Video", "UCOEDnvPe9oCLXEa__8qSIQA"),
    ("247Sports",                 "UCRz3CIsKSTYXF7cZQHFElqA"),
    ("On3 Sports",                "UCQ6-KPsBc8TLCvMuAQoq6Bg"),
    ("ESPN College Football",     "UCiWLfSweyRNmLpgEHekhoAg"),
]

LONGHORN_KEYWORDS = [
    "texas", "longhorn", "sarkisian", "arch manning", "burnt orange",
    "austin", "dkr", "darrell k", "hook em", "sec", "colin simmons",
    "cam coleman", "raleek brown"
]


def fetch_rss(name, url, max_items=6):
    try:
        r = requests.get(url, headers=HEADERS, timeout=12)
        r.raise_for_status()
        # Handle Atom feeds (Reddit uses Atom)
        content = r.content
        root = ET.fromstring(content)
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        items = []

        # Try RSS item format first
        for item in root.findall(".//item")[:max_items]:
            title = (item.findtext("title") or "").strip()
            desc  = (item.findtext("description") or "").strip()
            if title:
                items.append({"title": title, "description": _clean(desc, 250), "source": name})

        # Fall back to Atom entry format (Reddit, some others)
        if not items:
            for entry in root.findall(".//atom:entry", ns)[:max_items]:
                title = (entry.findtext("atom:title", namespaces=ns) or "").strip()
                summary = (entry.findtext("atom:summary", namespaces=ns) or "").strip()
                if title:
                    items.append({"title": title, "description": _clean(summary, 250), "source": name})

        return items
    except Exception as e:
        print(f"[WARN] RSS {name}: {e}", file=sys.stderr)
        return []


def fetch_youtube_transcripts(max_per_channel=2):
    """Pull transcripts from recent YouTube videos on key channels."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled
    except ImportError:
        print("[WARN] youtube-transcript-api not installed — skipping YouTube", file=sys.stderr)
        return []

    transcript_items = []
    for channel_name, channel_id in YOUTUBE_CHANNELS:
        try:
            feed_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
            r = requests.get(feed_url, headers=HEADERS, timeout=12)
            if r.status_code != 200:
                continue
            root = ET.fromstring(r.content)
            ns = {
                "atom": "http://www.w3.org/2005/Atom",
                "yt":   "http://www.youtube.com/xml/schemas/2015",
            }
            video_ids = []
            titles = {}
            for entry in root.findall("atom:entry", ns)[:max_per_channel * 3]:
                vid_el = entry.find("yt:videoId", ns)
                title_el = entry.find("atom:title", ns)
                if vid_el is not None and title_el is not None:
                    vid_id = vid_el.text.strip()
                    title = title_el.text.strip()
                    # Only process if title is Longhorns-relevant
                    if any(kw in title.lower() for kw in LONGHORN_KEYWORDS):
                        video_ids.append(vid_id)
                        titles[vid_id] = title
                if len(video_ids) >= max_per_channel:
                    break

            for vid_id in video_ids:
                try:
                    transcript = YouTubeTranscriptApi.get_transcript(vid_id, languages=["en"])
                    # Grab first ~90 seconds worth (captures intro/headlines)
                    text = " ".join(t["text"] for t in transcript[:60])
                    text = re.sub(r'\s+', ' ', text).strip()
                    if len(text) > 100:
                        transcript_items.append({
                            "title": f"[VIDEO] {titles[vid_id]}",
                            "description": text[:500],
                            "source": f"YouTube · {channel_name}",
                        })
                        print(f"[INFO]   YouTube transcript: {titles[vid_id][:60]}")
                except (NoTranscriptFound, TranscriptsDisabled):
                    pass
                except Exception as e:
                    print(f"[WARN] Transcript {vid_id}: {e}", file=sys.stderr)

        except Exception as e:
            print(f"[WARN] YouTube channel {channel_name}: {e}", file=sys.stderr)

    return transcript_items


def _clean(text, max_len):
    """Strip HTML tags and truncate."""
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:max_len]


def deduplicate(items):
    """Remove near-duplicate headlines."""
    seen = set()
    out = []
    for item in items:
        key = re.sub(r'\W+', '', item["title"].lower())[:60]
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def call_claude(news_items):
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    news_text = "\n".join(
        f"- [{item['source']}] {item['title']} — {item['description'][:250]}"
        for item in news_items[:60]  # cap at 60 items to stay within token budget
    )

    prompt = f"""You are the editor of Tower Report, an AI-powered Texas Longhorns football intelligence platform. The target audience is serious fans, students, alumni, donors, and recruits who want premium, data-driven analysis — not fluff.

Here are today's news items and video transcripts about Texas Longhorns football:

{news_text}

Generate a JSON response in this EXACT format (raw JSON only, no markdown):
{{
  "briefing": [
    {{"category": "Recruiting", "text": "Sharp, specific intel sentence. Name names, cite signals.", "source": "source name"}},
    {{"category": "Roster", "text": "Sharp intel about a specific player or depth chart development.", "source": "source name"}},
    {{"category": "Portal", "text": "Sharp intel about transfer portal activity.", "source": "source name"}},
    {{"category": "Program", "text": "Sharp intel about coaching, facilities, program direction.", "source": "source name"}},
    {{"category": "NIL", "text": "Sharp intel about NIL deals, valuations, or player business.", "source": "source name"}}
  ],
  "stories": [
    {{
      "headline": "Sharp headline, max 10 words, specific not generic",
      "summary": "Two sentences. Inform a knowledgeable fan. Be direct and specific.",
      "category": "Analysis",
      "kicker": "TOWER ANALYSIS"
    }},
    {{
      "headline": "...",
      "summary": "...",
      "category": "Recruiting",
      "kicker": "RECRUITING INTEL"
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
- Be factual. Only report what is actually in the provided sources.
- If a category has no news, write: "No new [category] activity in today's sources."
- Write like The Athletic — sharp, credentialed, zero filler.
- Do NOT invent stats, names, scores, or events.
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
            "max_tokens": 1200,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=45,
    )
    response.raise_for_status()
    raw = response.json()["content"][0]["text"].strip()

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
    # ── 1. RSS feeds ──────────────────────────────────────────────────────────
    print("[INFO] Fetching RSS feeds...")
    all_items = []
    for name, url in RSS_FEEDS:
        items = fetch_rss(name, url)
        print(f"[INFO]   {name}: {len(items)} items")
        all_items.extend(items)

    # ── 2. YouTube transcripts ────────────────────────────────────────────────
    print("[INFO] Fetching YouTube transcripts...")
    yt_items = fetch_youtube_transcripts(max_per_channel=2)
    print(f"[INFO]   YouTube: {len(yt_items)} transcripts pulled")
    all_items.extend(yt_items)

    # ── 3. Deduplicate ────────────────────────────────────────────────────────
    all_items = deduplicate(all_items)
    print(f"[INFO] Total unique items: {len(all_items)}")

    if len(all_items) < 3:
        print("[WARN] Not enough news items — keeping existing briefing", file=sys.stderr)
        sys.exit(0)

    # ── 4. Call Claude ────────────────────────────────────────────────────────
    print(f"[INFO] Calling Claude API...")
    try:
        result = call_claude(all_items)
    except Exception as e:
        print(f"[ERROR] Claude API call failed: {e}", file=sys.stderr)
        existing = load_existing()
        if existing:
            existing["lastUpdated"] = datetime.now(timezone.utc).isoformat()
            save(existing)
        sys.exit(0)

    output = {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "sourceCount": len(all_items),
        "briefing": result.get("briefing", []),
        "stories": result.get("stories", []),
    }

    save(output)
    print(f"[OK] Done — {len(output['briefing'])} briefing items, {len(output['stories'])} stories from {len(all_items)} sources")


if __name__ == "__main__":
    main()
