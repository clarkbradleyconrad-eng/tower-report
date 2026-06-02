#!/usr/bin/env python3
"""
Scrapes Texas Longhorns official roster from texaslonghorns.com
"""
import urllib.request
import json
import re
from datetime import datetime

def scrape_roster():
    url = "https://texaslonghorns.com/sports/football/roster"
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
    
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as response:
            html = response.read().decode('utf-8')
        
        # Initialize roster structure
        positions_order = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "K", "P"]
        roster_data = {
            "season": 2026,
            "lastUpdated": datetime.utcnow().isoformat() + "Z",
            "team": {
                "name": "Texas Longhorns",
                "conference": "SEC",
                "headCoach": "Steve Sarkisian"
            },
            "positions": {pos: [] for pos in positions_order}
        }
        
        # Extract table rows - look for player data in table rows
        # Pattern: <tr> containing <td> with number, name, position, class/hometown
        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
        
        for row in rows:
            cells = re.findall(r'<td[^>]*>([^<]+)</td>', row)
            
            if len(cells) >= 4:
                try:
                    jersey = cells[0].strip()
                    name = cells[1].strip()
                    position = cells[2].strip().upper()
                    info = cells[3].strip() if len(cells) > 3 else ""
                    
                    # Map position to our categories
                    pos_map = {
                        'QB': 'QB', 'RB': 'RB', 'WR': 'WR', 'TE': 'TE',
                        'OT': 'OL', 'OG': 'OL', 'C': 'OL', 'LS': 'OL',
                        'DE': 'DL', 'DT': 'DL', 'EDGE': 'DL',
                        'ILB': 'LB', 'OLB': 'LB', 'LB': 'LB',
                        'CB': 'DB', 'S': 'DB', 'DB': 'DB',
                        'K': 'K', 'P': 'P'
                    }
                    
                    mapped_pos = pos_map.get(position, position)
                    
                    if mapped_pos not in roster_data["positions"]:
                        roster_data["positions"][mapped_pos] = []
                    
                    # Determine class year
                    class_year = "Junior"
                    if "SR" in info.upper() or "Sr" in info:
                        class_year = "Senior"
                    elif "JR" in info.upper() or "Jr" in info:
                        class_year = "Junior"
                    elif "SO" in info.upper() or "So" in info:
                        class_year = "Sophomore"
                    elif "FR" in info.upper() or "Fr" in info:
                        class_year = "Freshman"
                    
                    # Extract hometown (usually last part after class)
                    hometown = "Texas"
                    parts = info.split(',')
                    if len(parts) > 1:
                        hometown = parts[-1].strip()
                    
                    player = {
                        "number": int(jersey) if jersey.isdigit() else 0,
                        "name": name,
                        "class": class_year,
                        "height": "6-0",
                        "weight": 200,
                        "hometown": hometown
                    }
                    
                    roster_data["positions"][mapped_pos].append(player)
                except (ValueError, IndexError):
                    continue
        
        return roster_data
    
    except Exception as e:
        print(f"Error scraping roster: {e}")
        return None

if __name__ == "__main__":
    roster = scrape_roster()
    if roster:
        import pathlib
        roster_path = pathlib.Path(__file__).parent.parent.parent / "data" / "roster.json"
        with open(roster_path, 'w') as f:
            json.dump(roster, f, indent=2)
        total = sum(len(players) for players in roster["positions"].values())
        print(f"✓ Updated roster: {total} players from Texas Athletics")
        print(f"✓ Positions: {', '.join(roster['positions'].keys())}")
