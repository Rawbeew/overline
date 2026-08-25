"""
sportybet-proxy.py v2 — Simplified, robust SportyBet data proxy
Navigates to SportyBet in real Chromium, waits for match content to render,
then extracts fixtures + odds from the DOM.

Run: python sportybet-proxy.py
Port: 8191
"""

from flask import Flask, request, jsonify
from playwright.sync_api import sync_playwright
import json

import re

def parse_sportybet_matches(raw_text):
    """
    Parse SportyBet page text into structured match objects.
    
    The text format looks like:
    11:00  
    ID: 17724
    	
    Cardiff City
    Norwich
    	
    2.92
    3.85
    2.40
    3
    1.96
    1.89
    +345
    
    Returns list of:
    {
        "time": "11:00",
        "event_id": "17724", 
        "home_team": "Cardiff City",
        "away_team": "Norwich",
        "odds_home": 2.92,
        "odds_draw": 3.85,
        "odds_away": 2.40,
        "ou_line": "3",
        "over_odds": 1.96,
        "under_odds": 1.89,
        "league": "...",
        "date": "25/08 Tuesday",
    }
    """
    matches = []
    lines = [l.strip() for l in raw_text.split("\n") if l.strip()]
    
    current_league = ""
    current_date = ""
    i = 0
    
    while i < len(lines):
        line = lines[i]
        
        # Detect league headers (lines before market type listings)
        if any(kw in line for kw in ["3 Way & O/U", "Double Chance", "GG/NG"]):
            # Look back for league name
            for j in range(max(0, i-5), i):
                prev = lines[j]
                league_keywords = ["england", "spain", "germany", "italy",
                              "france", "brazil", "denmark", "international", "champions", "premier",
                              "la liga", "serie a", "bundesliga", "ligue 1", "brasileiro", "friendly"]
            if any(kw in prev.lower() for kw in league_keywords):
                    current_league = prev
                    break
        
        # Detect date headers like "25/08 Tuesday"
        date_match = re.match(r'(\d{2}/\d{2})\s+(\w+)', line)
        if date_match:
            current_date = f"{date_match.group(1)} {date_match.group(2)}"
        
        # Detect time + event ID pattern
        if line and ":" in line and len(line) <= 8 and line.replace(":", "").isdigit():
            # This is a time like "11:00" or "12:30"
            match_time = line
            
            # Look ahead for event ID
            event_id = None
            if i + 1 < len(lines) and lines[i+1].startswith("ID:"):
                event_id = lines[i+1].replace("ID:", "").strip()
                i += 1
            
            # Look ahead for team names (two consecutive non-empty, non-numeric lines)
            home_team = None
            away_team = None
            j = i + 1
            
            # Skip empty/tab lines
            while j < len(lines) and lines[j] in ("\t", ""):
                j += 1
            if j < len(lines):
                home_team = lines[j]
                j += 1
            while j < len(lines) and lines[j] in ("\t", ""):
                j += 1
            if j < len(lines):
                away_team = lines[j]
                j += 1
            
            # Look ahead for odds (three decimal numbers)
            odds = []
            ou_line = None
            over_odds = under_odds = None
            
            while j < len(lines) and len(odds) < 6:
                val = lines[j]
                try:
                    num = float(val)
                    odds.append(num)
                except ValueError:
                    if val in ("+", "-") or val.startswith("+"):
                        break  # end of this match block
                j += 1
            
            if home_team and away_team and len(odds) >= 3:
                match_obj = {
                    "time": match_time,
                    "event_id": event_id,
                    "home_team": home_team,
                    "away_team": away_team,
                    "league": current_league,
                    "date": current_date,
                }
                
                # First three numbers are 1X2 odds
                if len(odds) >= 3:
                    match_obj["odds_home"] = odds[0]
                    match_obj["odds_draw"] = odds[1]
                    match_obj["odds_away"] = odds[2]
                
                # Fourth might be O/U line
                if len(odds) >= 4:
                    ou_line = str(odds[3])
                    match_obj["ou_line"] = ou_line
                
                # Fifth and sixth are over/under odds
                if len(odds) >= 6:
                    match_obj["over_odds"] = odds[4]
                    match_obj["under_odds"] = odds[5]
                
                matches.append(match_obj)
        
        i += 1
    
    return matches


app = Flask(__name__)

SPORTYBET_TOKEN = None

@app.route("/health")
def health():
    return jsonify({"ok": True, "proxy": "sportybet", "version": "2.0"})

def scrape_matches(page):
    """Extract all visible match data from the current page."""
    return page.evaluate("""() => {
        const matches = [];
        
        // Get all text nodes and find ones containing "vs" or team patterns
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );
        
        let node;
        const seenTexts = new Set();
        const oddsPattern = /\\d+\\.\\d{2}/g;
        
        while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (text.includes(' vs ') || text.includes(' - ')) {
                // Look for odds numbers near this text
                const parent = node.parentElement;
                if (!parent) continue;
                
                // Check parent and siblings for odds
                const container = parent.closest('[class]') || parent.parentElement;
                if (!container) continue;
                
                const containerText = container.innerText;
                if (containerText.length > 200) continue;  // too big, probably a section
                
                const key = text.slice(0, 50);
                if (seenTexts.has(key)) continue;
                seenTexts.add(key);
                
                // Extract odds numbers (decimal format like 1.85, 2.30)
                const oddsMatches = [...containerText.matchAll(/\\b(\\d+\\.\\d{2})\\b/g)];
                const odds = oddsMatches.map(m => parseFloat(m[1]));
                
                // Extract team names (text before/after "vs" or " - ")
                let homeTeam = '', awayTeam = '';
                if (text.includes(' vs ')) {
                    const parts = text.split(' vs ');
                    homeTeam = parts[0].trim();
                    awayTeam = parts[1]?.split('\\n')[0]?.trim() || '';
                }
                
                if (homeTeam && awayTeam && odds.length >= 2) {
                    matches.push({
                        homeTeam,
                        awayTeam,
                        display: text.slice(0, 150),
                        odds: odds,
                    });
                }
            }
        }
        
        // Also grab the full page text for debugging
        const pageText = document.body ? document.body.innerText : '';
        
        return { matches, pageLength: pageText.length, pageText: pageText.slice(0, 5000) };
    }""")

@app.route("/fetch", methods=["POST"])
def fetch_url():
    """Navigate to URL, wait for match data to render, extract it."""
    data = request.get_json()
    url = data.get("url", "")
    
    if not url:
        return jsonify({"error": "Missing url"}), 400
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            viewport={"width": 1920, "height": 1080},
        )
        
        # Inject token cookies
        if SPORTYBET_TOKEN:
            context.add_cookies([
                {"name": "accessToken", "value": SPORTYBET_TOKEN, "domain": ".sportybet.com", "path": "/"},
            ])
        
        page = context.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });")
        
        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
            
            # Wait for match content — look for any element with "vs" text
            # Try progressively longer waits
            matches_found = False
            for wait_ms in [5000, 10000, 15000]:
                page.wait_for_timeout(wait_ms)
                result = scrape_matches(page)
                if result["matches"]:
                    matches_found = True
                    break
            
            if not matches_found:
                # One final long wait then try again
                page.wait_for_timeout(15000)
                result = scrape_matches(page)
            
            browser.close()
            
            # Parse structured matches from the page text
            parsed_matches = parse_sportybet_matches(result["pageText"])
            
            return jsonify({
                "ok": True,
                "url": url,
                "dom_matches_found": len(result["matches"]),
                "parsed_matches_found": len(parsed_matches),
                "parsed_matches": parsed_matches,
                "page_length": result["pageLength"],
                "page_text": result["pageText"],
            })
            
        except Exception as e:
            # Even on error, try to get whatever we can
            try:
                result = scrape_matches(page)
                browser.close()
                return jsonify({
                    "ok": True,
                    "url": url,
                    "matches_found": len(result["matches"]),
                    "matches": result["matches"],
                    "page_length": result["pageLength"],
                    "page_text": result["pageText"],
                    "warning": str(e),
                })
            except:
                return jsonify({"ok": False, "error": str(e)}), 500

if __name__ == "__main__":
    # Load token from credentials.env
    creds_path = r"C:/Users/alaga/AppData/Local/hermes/secrets/credentials.env"
    try:
        for line in open(creds_path):
            if line.startswith("SPORTYBET_TOKEN="):
                SPORTYBET_TOKEN = line.split("=", 1)[1].strip()
                break
    except FileNotFoundError:
        pass
    
    print(f"SportyBet proxy v2 running on http://localhost:8191")
    print(f"Token loaded: {'yes' if SPORTYBET_TOKEN else 'no'}")
    app.run(host="127.0.0.1", port=8191)
