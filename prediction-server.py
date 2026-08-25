"""
prediction-server.py — Local prediction engine for Overline
Runs on port 8192. Combines live SportyBet fixtures with Dixon-Coles predictions.
The Telegram bot calls this instead of doing predictions in the Worker.

Endpoints:
  GET /fixtures?sport=football  → today's fixtures with predictions
  GET /predict?home=X&away=Y    → single match prediction  
  POST /ticket                  → build a ticket from top picks
"""

from flask import Flask, request, jsonify
import urllib.request
import json
import csv
import io
import math
from datetime import datetime

app = Flask(__name__)

PROXY_URL = "http://localhost:8191"

# ─── Dixon-Coles Engine ──────────────────────────────────────────

def fit_dixon_coles(matches):
    """Fit team attack/defence strengths from match history."""
    teams = set()
    for m in matches:
        if m.get("home_team"):
            teams.add(m["home_team"])
        if m.get("away_team"):
            teams.add(m["away_team"])
    
    params = {t: {"attack": 1.0, "defence": 1.0} for t in teams}
    home_advantage = 1.2
    
    total = len(matches)
    if total == 0:
        return params, home_advantage, 1.35, 1.10
    
    mean_home = sum(m["home_goals"] for m in matches) / total
    mean_away = sum(m["away_goals"] for m in matches) / total
    
    lr = 0.01
    for _ in range(50):
        grads = {t: {"attack": 0.0, "defence": 0.0} for t in teams}
        ha_grad = 0.0
        
        for m in matches:
            h, a = m.get("home_team"), m.get("away_team")
            if not h or not a or h not in params or a not in params:
                continue
            
            lambda_h = max(0.1, params[h]["attack"] * params[a]["defence"] * home_advantage * mean_home / 1.35)
            lambda_a = max(0.1, params[a]["attack"] * params[h]["defence"] * mean_away / 1.35)
            
            res_h = m["home_goals"] - lambda_h
            res_a = m["away_goals"] - lambda_a
            
            grads[h]["attack"] += res_h * lambda_h / params[h]["attack"]
            grads[a]["defence"] += res_h * lambda_h / params[a]["defence"]
            grads[a]["attack"] += res_a * lambda_a / params[a]["attack"]
            grads[h]["defence"] += res_a * lambda_a / params[h]["defence"]
            ha_grad += res_h * lambda_h / home_advantage
        
        for t in teams:
            params[t]["attack"] = max(0.3, min(2.5, params[t]["attack"] + lr * grads[t]["attack"] / total))
            params[t]["defence"] = max(0.3, min(2.5, params[t]["defence"] + lr * grads[t]["defence"] / total))
        
        home_advantage = max(1.0, min(1.8, home_advantage + lr * ha_grad / total))
    
    return params, round(home_advantage, 2), round(mean_home, 2), round(mean_away, 2)


def pois_pmf(k, lam):
    if k < 0 or lam <= 0: return 0
    log_pmf = -lam + k * math.log(lam)
    log_fact = sum(math.log(i) for i in range(2, k+1))
    return math.exp(log_pmf - log_fact)



def fuzzy_match_team(name, params):
    """Find a team in the fitted model using fuzzy matching. Returns ORIGINAL key."""
    if not name or not params:
        return None
    
    name_lower = name.lower().strip()
    
    # Exact match (case-insensitive)
    for team_name in params:
        if team_name.lower() == name_lower:
            return team_name  # return ORIGINAL key with correct casing
    
    # Substring match (either direction)
    for team_name in params:
        team_lower = team_name.lower()
        if len(team_lower) >= 4 and (team_lower in name_lower or name_lower in team_lower):
            return team_name  # return ORIGINAL key
    
    # Word overlap match
    stop_words = {"fc", "city", "united", "town", "afc", "cf", "sc", "the"}
    name_words = set(name_lower.split()) - stop_words
    
    for team_name in params:
        team_words = set(team_name.lower().split()) - stop_words
        if name_words and team_words and (name_words & team_words):
            return team_name  # return ORIGINAL key
    
    return None


def predict_match(params, home_adv, mean_home, mean_away, home_team, away_team):
    """Predict a match using fitted parameters."""
    home_key = fuzzy_match_team(home_team, params)
    away_key = fuzzy_match_team(away_team, params)
    
    hp = params.get(home_key) if home_key else None
    ap = params.get(away_key) if away_key else None
    
    if not hp or not ap:
        return None
    
    lambda_h = max(0.1, hp["attack"] * ap["defence"] * home_adv * mean_home / 1.35)
    lambda_a = max(0.1, ap["attack"] * hp["defence"] * mean_away / 1.35)
    
    hw = d = aw = btts = o25 = o35 = 0.0
    score_matrix = {}
    
    for h in range(11):
        for a in range(11):
            p = pois_pmf(h, lambda_h) * pois_pmf(a, lambda_a)
            if h > a: hw += p
            elif h == a: d += p
            else: aw += p
            if h > 0 and a > 0: btts += p
            if h + a > 2.5: o25 += p
            if h + a > 3.5: o35 += p
            score_matrix[f"{h}-{a}"] = round(p, 6)
    
    # Find most likely correct score
    best_cs = max(score_matrix.items(), key=lambda x: x[1])
    
    return {
        "home_win": round(hw, 4),
        "draw": round(d, 4),
        "away_win": round(aw, 4),
        "btts": round(btts, 4),
        "over25": round(o25, 4),
        "over35": round(o35, 4),
        "xg_home": round(lambda_h, 2),
        "xg_away": round(lambda_a, 2),
        "best_correct_score": best_cs[0],
        "best_cs_probability": best_cs[1],
        "score_matrix": score_matrix,
    }


# ─── Data Fetching ────────────────────────────────────────────────

_model_cache = None
_cache_time = 0

def get_model():
    """Fetch EPL data from football-data.co.uk and fit model."""
    global _model_cache, _cache_time
    import time as time_module
    
    if _model_cache and time_module.time() - _cache_time < 3600:
        return _model_cache
    
    # Fetch current season data from EPL + Championship
    now = datetime.now()
    year = now.year
    start_year = year if now.month >= 8 else year - 1
    season = f"{str(start_year)[2:]}{str(start_year + 1)[2:]}"
    
    all_matches = []
    
    # EPL (E0) + Championship (E1)
    for league_code in ["E0", "E1"]:
        url = f"https://www.football-data.co.uk/mmz4281/{season}/{league_code}.csv"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "overline/2.0"})
            resp = urllib.request.urlopen(req, timeout=15)
            reader = csv.DictReader(io.StringIO(resp.read().decode(errors="ignore")))
            
            for row in reader:
                try:
                    all_matches.append({
                        "home_team": row["HomeTeam"].strip(),
                        "away_team": row["AwayTeam"].strip(),
                        "home_goals": int(row["FTHG"]),
                        "away_goals": int(row["FTAG"]),
                    })
                except (ValueError, KeyError):
                    continue
            print(f"[predictions] Fetched {league_code}: {len(all_matches)} total matches")
        except Exception as e:
            print(f"[predictions] Error fetching {league_code}: {e}")
    
    # If early season, add previous season
    if len(all_matches) < 50:
        prev_season = f"{str(start_year - 1)[2:]}{str(start_year)[2:]}"
        prev_url = f"https://www.football-data.co.uk/mmz4281/{prev_season}/E0.csv"
        try:
            req = urllib.request.Request(prev_url, headers={"User-Agent": "overline/2.0"})
            resp = urllib.request.urlopen(req, timeout=15)
            reader = csv.DictReader(io.StringIO(resp.read().decode(errors="ignore")))
            
            prev_matches = []
            for row in reader:
                try:
                    prev_matches.append({
                        "home_team": row["HomeTeam"].strip(),
                        "away_team": row["AwayTeam"].strip(),
                        "home_goals": int(row["FTHG"]),
                        "away_goals": int(row["FTAG"]),
                    })
                except:
                    continue
            
            all_matches = prev_matches + all_matches
        except:
            pass
    
    result = fit_dixon_coles(all_matches)
    _model_cache = result
    _cache_time = time_module.time()
    return result


def get_live_fixtures():
    """Fetch live fixtures from the SportyBet proxy."""
    try:
        print("[predictions] Fetching fixtures from proxy...")
        req = urllib.request.Request(
            f"{PROXY_URL}/fetch",
            data=json.dumps({"url": "https://www.sportybet.com/ng/sport/football/today"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=120)
        data = json.loads(resp.read().decode())
        
        parsed = data.get("parsed_matches", [])
        print(f"[predictions] Proxy returned {len(parsed)} matches")
        
        if not parsed:
            print(f"[predictions] Full proxy response keys: {list(data.keys())}")
            if data.get("ok") == False:
                print(f"[predictions] Error: {data.get('error')}")
        
        return parsed
    except Exception as e:
        print(f"[predictions] Proxy fetch error: {type(e).__name__}: {e}")
        return []


# ─── API Endpoints ────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"ok": True, "service": "overline-predictions", "version": "1.0"})


@app.route("/fixtures")
def fixtures():
    """Get today's fixtures with predictions."""
    # Get live fixtures from proxy
    live_matches = get_live_fixtures()
    print(f"[predictions] Got {len(live_matches)} live matches")
    
    # Get fitted model
    params, home_adv, mean_home, mean_away = get_model()
    
    results = []
    for match in live_matches[:20]:  # limit to first 20
        home_name = match.get("home_team", "")
        away_name = match.get("away_team", "")
        
        # Debug: show what we're looking up and what's available
        if not results:  # only log for first match
            print(f"[predictions] Looking up: '{home_name}' vs '{away_name}'")
            print(f"[predictions] Model has {len(params)} teams: {list(params.keys())[:10]}...")
        
        pred = predict_match(
            params, home_adv, mean_home, mean_away,
            home_name, away_name
        )
        
        if pred:
            if not results:
                print(f"[predictions] ✅ First match matched!")
        else:
            if not results:
                print(f"[predictions] ❌ First match NOT found in model")

        if pred:
            # Calculate EV for each market
            oh = match.get("odds_home", 0)
            od = match.get("odds_draw", 0)
            oa = match.get("odds_away", 0)
            
            ev_home = pred["home_win"] * oh - 1 if oh else -1
            ev_draw = pred["draw"] * od - 1 if od else -1
            ev_away = pred["away_win"] * oa - 1 if oa else -1
            
            results.append({
                **match,
                "prediction": {
                    "home_win_pct": round(pred["home_win"] * 100, 1),
                    "draw_pct": round(pred["draw"] * 100, 1),
                    "away_win_pct": round(pred["away_win"] * 100, 1),
                    "xg_home": pred["xg_home"],
                    "xg_away": pred["xg_away"],
                    "btts_pct": round(pred["btts"] * 100, 1),
                    "over25_pct": round(pred["over25"] * 100, 1),
                    "best_score": pred["best_correct_score"],
                    "ev_home": round(ev_home * 100, 1),
                    "ev_draw": round(ev_draw * 100, 1),
                    "ev_away": round(ev_away * 100, 1),
                }
            })
    
    # Sort by highest EV
    results.sort(key=lambda x: max(x["prediction"]["ev_home"], 
                                    x["prediction"]["ev_draw"], 
                                    x["prediction"]["ev_away"]), reverse=True)
    
    return jsonify({
        "ok": True,
        "count": len(results),
        "timestamp": datetime.now().isoformat(),
        "fixtures": results,
    })


@app.route("/ticket", methods=["POST"])
def build_ticket():
    """Build an optimized ticket from live fixtures."""
    target_odds = request.json.get("target_odds", 50) if request.json else 50
    
    # Get predictions
    fixtures_resp = fixtures()
    fixtures_data = fixtures_resp.get_json()
    all_fixtures = fixtures_data.get("fixtures", [])
    
    # Create high-value selections
    selections = []
    for fx in all_fixtures:
        pred = fx.get("prediction", {})
        eid = fx.get("event_id")
        
        # Best EV market for each match
        markets = [
            {"market": "Home Win", "prob": pred["home_win_pct"]/100, "odds": fx.get("odds_home"), "ev": pred["ev_home"]},
            {"market": "Away Win", "prob": pred["away_win_pct"]/100, "odds": fx.get("odds_away"), "ev": pred["ev_away"]},
            {"market": "Draw", "prob": pred["draw_pct"]/100, "odds": fx.get("odds_draw"), "ev": pred["ev_draw"]},
        ]
        
        best = max(markets, key=lambda x: x["ev"])
        if best["ev"] > 0 and best["odds"]:
            selections.append({
                "event_id": eid,
                "match": f"{fx['home_team']} vs {fx['away_team']}",
                "market": best["market"],
                "probability": round(best["prob"], 3),
                "odds": best["odds"],
                "ev_pct": best["ev"],
                "kickoff": fx.get("time", ""),
                "date": fx.get("date", ""),
            })
    
    # Build ticket targeting the desired odds
    selections.sort(key=lambda x: x["odds"])  # safest first
    ticket = []
    total_odds = 1
    joint_prob = 1
    
    for sel in selections:
        next_total = total_odds * sel["odds"]
        if next_total <= target_odds or not ticket:
            ticket.append(sel)
            total_odds = next_total
            joint_prob *= sel["probability"]
        elif next_total >= target_odds:
            ticket.append(sel)
            total_odds = next_total
            joint_prob *= sel["probability"]
            break
    
    return jsonify({
        "ok": True,
        "target_odds": target_odds,
        "achieved_odds": round(total_odds, 2),
        "win_probability": round(joint_prob * 100, 2),
        "legs": len(ticket),
        "selections": ticket,
    })


if __name__ == "__main__":
    print("Overline Prediction Server running on http://localhost:8192")
    app.run(host="127.0.0.1", port=8192)
