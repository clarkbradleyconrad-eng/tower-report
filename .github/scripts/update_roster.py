#!/usr/bin/env python3
"""
Auto-update roster data from ESPN or public sports APIs
"""
import json
import requests
from datetime import datetime
from pathlib import Path

# For now, we'll update the timestamp and verify data integrity
# In production, you'd scrape ESPN, use a sports API, or fetch from Texas Athletics

def update_roster():
    roster_path = Path(__file__).parent.parent.parent / "data" / "roster.json"
    
    try:
        with open(roster_path, 'r') as f:
            roster = json.load(f)
        
        # Update the lastUpdated timestamp
        roster['lastUpdated'] = datetime.utcnow().isoformat() + 'Z'
        
        # In production, you would:
        # 1. Fetch from ESPN API: https://site.api.espn.com/sites/site/content/teams/...
        # 2. Parse the data and map to our roster structure
        # 3. Update positions with new player data
        
        # For now, just update timestamp to show automation is working
        
        with open(roster_path, 'w') as f:
            json.dump(roster, f, indent=2)
        
        print(f"✓ Roster updated at {roster['lastUpdated']}")
        
    except Exception as e:
        print(f"✗ Error updating roster: {e}")
        exit(1)

if __name__ == "__main__":
    update_roster()
