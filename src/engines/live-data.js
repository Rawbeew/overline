// engines/live-data.js — fetch real EPL fixtures + odds from football-data.co.uk
// No API key needed. CSV downloads are free and open.

// Auto-detect current season (e.g., "2627" for Aug 2026–May 2027)
function getCurrentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  // Season runs Aug–May. If month >= Aug (7), we're in year/year+1
  const startYear = now.getMonth() >= 7 ? year : year - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(2)}${String(endYear).slice(2)}`;
}

const FOOTBALL_DATA_BASE = "https://www.football-data.co.uk/mmz4281";

const LEAGUES = {
  epl:      { code: "E0", name: "Premier League" },
  championship: { code: "E1", name: "Championship" },
  laliga:   { code: "SP1", name: "La Liga" },
  seriea:   { code: "I1", name: "Serie A" },
  bundesliga: { code: "D1", name: "Bundesliga" },
  ligue1:   { code: "F1", name: "Ligue 1" },
};

/**
 * Fetch match data for a league.
 * Returns parsed CSV rows with teams, scores, odds, dates.
 */
export async function fetchLeagueData(leagueKey) {
  const league = LEAGUES[leagueKey];
  if (!league) throw new Error(`Unknown league: ${leagueKey}`);

  const season = getCurrentSeason();
  const url = `${FOOTBALL_DATA_BASE}/${season}/${league.code}.csv`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "overline/0.1.0" },
  });

  if (!resp.ok) throw new Error(`Failed to fetch ${league.name}: ${resp.status}`);

  const csv = await resp.text();
  return parseCSV(csv);
}

/**
 * Parse football-data.co.uk CSV format
 */
export function parseCSV(csvText) {
  const lines = csvText.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]).map(h => h.replace(/^\uFEFF/, "").trim());

  // Map column names we care about
  const colMap = {
    date: headers.indexOf("Date"),
    time: headers.indexOf("Time"),
    homeTeam: headers.indexOf("HomeTeam"),
    awayTeam: headers.indexOf("AwayTeam"),
    fthg: headers.indexOf("FTHG"), // full time home goals
    ftag: headers.indexOf("FTAG"), // full time away goals
    ftr: headers.indexOf("FTR"),   // full time result H/D/A
    hthg: headers.indexOf("HTHG"), // half time home goals
    htag: headers.indexOf("HTAG"),
    b365h: headers.indexOf("B365H"),
    b365d: headers.indexOf("B365D"),
    b365a: headers.indexOf("B365A"),
    psh: headers.indexOf("PSH"),   // Pinnacle home
    psd: headers.indexOf("PSD"),
    psa: headers.indexOf("PSA"),
    maxh: headers.indexOf("MaxH"),
    maxd: headers.indexOf("MaxD"),
    maxa: headers.indexOf("MaxA"),
    avgH: headers.indexOf("AvgCH") || headers.indexOf("AVGH"),
    avgD: headers.indexOf("AvgCD") || headers.indexOf("AVGD"),
    avgA: headers.indexOf("AvgCA") || headers.indexOf("AVGA"),
  };

  const matches = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 10) continue;

    matches.push({
      date: row[colMap.date] || "",
      time: row[colMap.time] || "",
      homeTeam: row[colMap.homeTeam] || "",
      awayTeam: row[colMap.awayTeam] || "",
      homeGoals: parseInt(row[colMap.fthg]) || 0,
      awayGoals: parseInt(row[colMap.ftag]) || 0,
      result: row[colMap.ftr] || "",
      odds: {
        bet365: {
          home: parseFloat(row[colMap.b365h]) || null,
          draw: parseFloat(row[colMap.b365d]) || null,
          away: parseFloat(row[colMap.b365a]) || null,
        },
        pinnacle: {
          home: parseFloat(row[colMap.psh]) || null,
          draw: parseFloat(row[colMap.psd]) || null,
          away: parseFloat(row[colMap.psa]) || null,
        },
        max: {
          home: parseFloat(row[colMap.maxh]) || null,
          draw: parseFloat(row[colMap.maxd]) || null,
          away: parseFloat(row[colMap.maxa]) || null,
        },
      },
    });
  }

  return matches;
}

/**
 * Simple CSV line parser that handles quoted fields with commas
 */
function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Get unique team names from match data
 */
export function getTeams(matches) {
  const teams = new Set();
  for (const m of matches) {
    if (m.homeTeam) teams.add(m.homeTeam);
    if (m.awayTeam) teams.add(m.awayTeam);
  }
  return [...teams].sort();
}

/**
 * Get upcoming/recent matches (last N by date)
 */
export function getRecentMatches(matches, count = 10) {
  return matches
    .filter(m => m.date && m.homeGoals !== null)
    .sort((a, b) => new Date(b.date.split("/").reverse().join("-")) - 
                    new Date(a.date.split("/").reverse().join("-")))
    .slice(0, count);
}
