#!/usr/bin/env python3
"""
Auto-update Texas Longhorns roster from texaslonghorns.com
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROSTER_URL = "https://texaslonghorns.com/sports/football/roster"
ROSTER_PATH = Path(__file__).parent.parent.parent / "data" / "roster.json"

POSITION_MAP = {
    "QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE",
    "OL": "OL", "OT": "OL", "OG": "OL", "C": "OL", "G": "OL", "T": "OL",
    "DL": "DL", "DE": "DL", "DT": "DL", "NT": "DL", "EDGE": "DL",
    "LB": "LB", "ILB": "LB", "OLB": "LB",
    "DB": "DB", "CB": "DB", "S": "DB", "SS": "DB", "FS": "DB",
    "K": "K", "P": "P", "LS": "DS", "DS": "DS",
    "ATH": "ATH", "RB/WR": "RB/WR",
}


def fetch_roster():
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }
    r = requests.get(ROSTER_URL, headers=headers, timeout=30)
    r.raise_for_status()
    return r.text


def parse_roster(html):
    soup = BeautifulSoup(html, "lxml")
    players = []

    # Texas Athletics uses a roster table — find all player rows
    rows = soup.select("tr.roster__player, tr[data-id], .roster-player")
    if not rows:
        rows = soup.select("table tr")

    # Detect column order from header row
    col_order = None
    for row in rows:
        cells = row.find_all(["td", "th"])
        texts = [c.get_text(strip=True).upper() for c in cells]
        if texts and texts[0] in ("#", "NO", "NUMBER", "NUM"):
            # Map header text to index
            col_order = {t: i for i, t in enumerate(texts)}
            break

    # Default column layout used by Texas Athletics: #, Name, Class, Pos, Hometown
    num_col = col_order.get("#", col_order.get("NO", 0)) if col_order else 0
    name_col = col_order.get("NAME", 1) if col_order else 1
    cls_col = col_order.get("CLASS", col_order.get("YR", col_order.get("YEAR", 2))) if col_order else 2
    pos_col = col_order.get("POS", col_order.get("POSITION", 3)) if col_order else 3
    ht_col = col_order.get("HT", col_order.get("HEIGHT", None)) if col_order else None
    wt_col = col_order.get("WT", col_order.get("WEIGHT", None)) if col_order else None
    home_col = col_order.get("HOMETOWN", col_order.get("HOME", 4)) if col_order else 4

    for row in rows:
        cells = row.find_all(["td", "th"])
        texts = [c.get_text(strip=True) for c in cells]

        if not texts or texts[0].upper() in ("#", "NO", "NUMBER", "NUM"):
            continue

        num_text = texts[num_col].lstrip("#").strip() if num_col < len(texts) else ""
        if not re.match(r"^\d{1,2}$", num_text):
            continue

        def col(idx):
            if idx is None or idx >= len(texts):
                return None
            return texts[idx] or None

        number = int(num_text)
        name = col(name_col) or ""
        yr = col(cls_col) or ""
        pos_raw = (col(pos_col) or "").upper()
        ht_val = col(ht_col)
        wt_val = col(wt_col)
        hometown = col(home_col) or ""

        pos = POSITION_MAP.get(pos_raw, pos_raw or "ATH")
        ht = ht_val if ht_val and re.match(r"\d+-\d+", ht_val) else None
        wt = int(wt_val) if wt_val and re.match(r"^\d{2,3}$", wt_val) else None

        players.append({
            "number": number,
            "name": name,
            "position": pos,
            "class": yr,
            "height": ht,
            "weight": wt,
            "hometown": hometown,
        })

    return players


def build_roster_json(players):
    positions = {}
    for p in players:
        pos = p.pop("position")
        positions.setdefault(pos, []).append(p)

    for pos in positions:
        positions[pos].sort(key=lambda x: x["number"])

    return {
        "season": 2026,
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "team": {
            "name": "Texas Longhorns",
            "conference": "SEC",
            "headCoach": "Steve Sarkisian",
        },
        "positions": positions,
    }


def load_existing():
    if ROSTER_PATH.exists():
        with open(ROSTER_PATH) as f:
            return json.load(f)
    return None


def save(roster):
    ROSTER_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(ROSTER_PATH, "w") as f:
        json.dump(roster, f, indent=2)


def main():
    print(f"Fetching roster from {ROSTER_URL}...")
    try:
        html = fetch_roster()
    except Exception as e:
        print(f"ERROR fetching roster: {e}", file=sys.stderr)
        existing = load_existing()
        if existing:
            existing["lastUpdated"] = datetime.now(timezone.utc).isoformat()
            save(existing)
            print("Kept existing roster, updated timestamp.")
        sys.exit(1)

    players = parse_roster(html)

    if len(players) < 10:
        print(
            f"WARNING: only {len(players)} players parsed — page structure may have changed.",
            file=sys.stderr,
        )
        print("Keeping existing roster data.")
        existing = load_existing()
        if existing:
            existing["lastUpdated"] = datetime.now(timezone.utc).isoformat()
            save(existing)
        sys.exit(0)

    roster = build_roster_json(players)
    total = sum(len(v) for v in roster["positions"].values())
    save(roster)
    print(f"Roster updated: {total} players across {len(roster['positions'])} position groups.")
    print(f"Last updated: {roster['lastUpdated']}")


if __name__ == "__main__":
    main()
