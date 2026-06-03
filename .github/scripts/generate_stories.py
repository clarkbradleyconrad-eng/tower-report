"""
Tower Report — Story Generator
Runs daily. Does two things:
  1. Auto-generates 3 full articles from today's news (data/briefing.json)
  2. Processes any URLs the user dropped in data/story-queue.json
All output saved to data/stories.json for the stories page to render.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ROOT = Path(__file__).parent.parent.parent
BRIEFING_FILE  = ROOT / "data" / "briefing.json"
QUEUE_FILE     = ROOT / "data" / "story-queue.json"
STORIES_FILE   = ROOT / "data" / "stories.json"

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; TowerReport/1.0)"}
MAX_STORIES_KEPT = 30   # rolling window — oldest fall off


# ── Helpers ───────────────────────────────────────────────────────────────────

def slugify(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:60]

def today_label():
    return datetime.now(timezone.utc).strftime("%b %-d, %Y")

def today_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")

def load_json(path, default):
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return default

def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


# ── Claude API ────────────────────────────────────────────────────────────────

def call_claude(prompt, max_tokens=1800):
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=60,
    )
    r.raise_for_status()
    raw = r.json()["content"][0]["text"].strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
        raw = raw.rsplit("```", 1)[0]
    return raw


# ── Scrape a URL ──────────────────────────────────────────────────────────────

def scrape_url(url):
    """Return (title, body_text) from any article URL."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        soup = BeautifulSoup(r.content, "lxml")
        # Remove nav/footer/ads
        for tag in soup(["nav", "footer", "aside", "script", "style", "figure"]):
            tag.decompose()
        title = (soup.find("h1") or soup.find("title") or soup.new_tag("x"))
        title = title.get_text(strip=True)
        # Grab all paragraph text
        paragraphs = [p.get_text(strip=True) for p in soup.find_all("p") if len(p.get_text(strip=True)) > 40]
        body = " ".join(paragraphs[:40])  # first ~40 paragraphs
        return title, body[:4000]
    except Exception as e:
        print(f"[WARN] Could not scrape {url}: {e}", file=sys.stderr)
        return None, None


# ── Write a story from raw source material ────────────────────────────────────

def write_story(topic, source_material, category="Analysis"):
    prompt = f"""You are a senior writer for Tower Report — a premium Texas Longhorns football intelligence platform with the voice of The Athletic meets PFF. Your readers are serious fans, alumni, donors, and recruits. They want sharp analysis, real context, and no filler.

Write a full article based on the source material below.

TOPIC / ANGLE: {topic}

SOURCE MATERIAL:
{source_material[:3000]}

Return a JSON object in this exact format (raw JSON, no markdown):
{{
  "headline": "Sharp headline, max 12 words, specific not generic",
  "kicker": "ONE OF: TOWER ANALYSIS | RECRUITING INTEL | PORTAL REPORT | FILM ROOM | PROGRAM | SEC INTEL | NIL WATCH | DRAFT WATCH",
  "category": "{category}",
  "summary": "Two sharp sentences. The deck a reader sees before clicking. No fluff.",
  "body": "Full article, 450-600 words. Use short paragraphs (2-3 sentences max). No headers or bullet points — flowing prose. Write with authority. Name names. Use context. First paragraph must hook immediately. End with a forward-looking sentence.",
  "takeaways": ["Key point 1 in one sentence", "Key point 2 in one sentence", "Key point 3 in one sentence"],
  "tags": ["Tag1", "Tag2", "Tag3"]
}}

Rules:
- Only report what is supported by the source material
- Be specific: name players, positions, situations — never generic
- Write like a credentialed beat writer, not a press release
- Raw JSON only"""

    raw = call_claude(prompt, max_tokens=1800)
    data = json.loads(raw)
    return data


# ── Auto-generate stories from today's briefing ───────────────────────────────

def generate_auto_stories(briefing_data):
    stories_out = []
    briefing = briefing_data.get("briefing", [])
    news_stories = briefing_data.get("stories", [])

    if not briefing and not news_stories:
        return []

    # Build source material from the morning briefing
    source = "\n".join(
        f"[{item['category']}] {item['text']} (via {item['source']})"
        for item in briefing
    )

    # One full article per story card already identified
    for item in news_stories[:3]:
        topic = f"{item['headline']} — {item.get('summary','')}"
        try:
            story = write_story(topic, source + "\n\nFocus angle: " + item['headline'], category=item.get("category","Analysis"))
            story["id"] = slugify(story["headline"])
            story["date"] = today_label()
            story["dateISO"] = today_iso()
            story["source"] = "auto"
            story["featured"] = False
            stories_out.append(story)
            print(f"[OK] Auto-story: {story['headline'][:70]}")
        except Exception as e:
            print(f"[WARN] Auto-story failed: {e}", file=sys.stderr)

    # Mark the first auto-story as featured
    if stories_out:
        stories_out[0]["featured"] = True

    return stories_out


# ── Process user URL queue ────────────────────────────────────────────────────

def process_queue(queue_data):
    stories_out = []
    queue = queue_data.get("queue", [])
    processed_ids = set(queue_data.get("processed", []))
    newly_processed = []

    for item in queue:
        url = item.get("url", "").strip()
        notes = item.get("notes", "")
        item_id = slugify(url)

        if item_id in processed_ids:
            continue  # already done

        print(f"[INFO] Processing URL: {url}")
        title, body = scrape_url(url)
        if not body:
            print(f"[WARN] Could not scrape {url} — skipping", file=sys.stderr)
            continue

        topic = notes if notes else title or url
        source_material = f"Title: {title}\n\nArticle content:\n{body}"

        # Detect category from notes
        cat = "Analysis"
        for keyword, label in [("recruit", "Recruiting"), ("portal", "Portal"), ("film", "Film Room"), ("nil", "NIL"), ("draft", "Draft Watch")]:
            if keyword in (notes + url).lower():
                cat = label
                break

        try:
            story = write_story(topic, source_material, category=cat)
            story["id"] = slugify(story["headline"])
            story["date"] = today_label()
            story["dateISO"] = today_iso()
            story["source"] = "url-queue"
            story["sourceUrl"] = url
            story["featured"] = False
            stories_out.append(story)
            newly_processed.append(item_id)
            print(f"[OK] Queue story: {story['headline'][:70]}")
        except Exception as e:
            print(f"[WARN] Queue story failed for {url}: {e}", file=sys.stderr)

    # Update the queue's processed list
    queue_data["processed"] = list(processed_ids | set(newly_processed))
    save_json(QUEUE_FILE, queue_data)

    return stories_out


# ── Merge into rolling stories.json ──────────────────────────────────────────

def merge_stories(new_stories, existing_data):
    existing = existing_data.get("stories", [])
    existing_ids = {s["id"] for s in existing}

    # Prepend new stories (newest first), avoid duplicates
    combined = []
    for s in new_stories:
        if s["id"] not in existing_ids:
            combined.append(s)
            existing_ids.add(s["id"])

    combined.extend(existing)

    # Keep rolling window
    combined = combined[:MAX_STORIES_KEPT]

    # Ensure exactly one featured story (most recent)
    for s in combined:
        s["featured"] = False
    if combined:
        combined[0]["featured"] = True

    return {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "stories": combined,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    briefing_data  = load_json(BRIEFING_FILE, {})
    queue_data     = load_json(QUEUE_FILE, {"queue": [], "processed": []})
    existing_data  = load_json(STORIES_FILE, {"stories": []})

    new_stories = []

    # 1. Process user URL queue first (priority)
    print("[INFO] Processing story queue...")
    queue_stories = process_queue(queue_data)
    new_stories.extend(queue_stories)
    print(f"[INFO] Queue: {len(queue_stories)} stories written")

    # 2. Auto-generate from today's briefing
    print("[INFO] Auto-generating stories from briefing...")
    auto_stories = generate_auto_stories(briefing_data)
    new_stories.extend(auto_stories)
    print(f"[INFO] Auto: {len(auto_stories)} stories written")

    if not new_stories:
        print("[WARN] No new stories generated today")
        sys.exit(0)

    # 3. Merge into rolling archive
    output = merge_stories(new_stories, existing_data)
    save_json(STORIES_FILE, output)
    print(f"[OK] stories.json updated — {len(output['stories'])} total stories")


if __name__ == "__main__":
    main()
