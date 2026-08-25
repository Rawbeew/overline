// index.js — Overline v3
// Statistical betting bot. Correct scores, overs, BTTS — model-driven.
// Football only. Dixon-Coles engine. SportyBet booking via local proxy.

import { fetchLeagueData, parseCSV } from "./engines/live-data.js";
import { fitDixonColes } from "./engines/dc-model.js";

// ─── Worker entry ──────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/telegram" && request.method === "POST") {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response("OK");
      } catch (err) {
        console.error("[overline] error:", err.message);
        return new Response("OK");
      }
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: "3.0" });
    }

    return new Response("Overline — stats vs the book.", { status: 200 });
  },
};

// ─── Telegram helpers ──────────────────────────────────────────

async function sendMessage(chatId, text, env, replyMarkup = null) {
  const token = env.OVERLINE_BOT_TOKEN;
  const body = { chat_id: String(chatId), text: text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const result = await resp.json();
    if (!result.ok) {
      delete body.parse_mode;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    }
  } catch (err) {
    console.error("[overline] sendMessage error:", err.message);
  }
}

async function sendTyping(chatId, env) {
  try {
    await fetch(`https://api.telegram.org/bot${env.OVERLINE_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: new TextEncoder().encode(JSON.stringify({ chat_id: String(chatId), action: "typing" })),
    });
  } catch (err) { /* non-critical */ }
}

function inlineKeys(rows) {
  return {
    inline_keyboard: rows.map(([text, callback_data]) => [
      { text, callback_data: callback_data || text },
    ]),
  };
}

// ─── Update router ─────────────────────────────────────────────

async function handleUpdate(update, env) {
  if (!update.message) return;
  const chatId = update.message.chat.id;
  const text = (update.message.text || "").trim();
  const lower = text.toLowerCase();

  if (!text || text.startsWith("/")) return;

  await sendTyping(chatId, env);

  try {
    // CORRECT SCORES
    if (/correct.?score/i.test(lower)) {
      await cmdCorrectScores(chatId, env);
      return;
    }

    // OVERS — "overs 3.5", "over 2.5 today", "high scoring"
    if (/over|goals|high.?scor/i.test(lower)) {
      const lineMatch = lower.match(/(\d+\.?\d*)/);
      const line = lineMatch ? parseFloat(lineMatch[1]) : 2.5;
      await cmdOvers(chatId, line, env);
      return;
    }

    // BTTS
    if (/btts|both.?teams|both.?score/i.test(lower)) {
      await cmdBTTS(chatId, env);
      return;
    }

    // BUILD TICKET — "give me X odds", "build ticket", "book X odds"
    if (/(?:odds|ticket|book|build|give me)/i.test(lower)) {
      await cmdBuildTicket(chatId, text, env);
      return;
    }

    // TEAM vs TEAM — "Arsenal vs Chelsea"
    const vsMatch = text.match(/^(.{2,30}?)\s+(?:vs|versus|v\.?)\s+(.{2,30}?)$/i);
    if (vsMatch) {
      await cmdPredictMatch(chatId, vsMatch[1].trim(), vsMatch[2].trim(), env);
      return;
    }

    // WIN RATE
    if (/win.?rate|accuracy|stats/i.test(lower)) {
      await sendMessage(chatId, `Win rate tracking coming soon. The model needs more predictions to calculate accuracy.`, env);
      return;
    }

    // HELP / DEFAULT
    await sendMessage(chatId,
      `<b>Overline</b>\n\n` +
      `Just tell me what you want.\n\n` +
      `<b>Build a ticket</b>\n` +
      `• Book 20 odds\n` +
      `• Book 50 odds over 1.5 only\n` +
      `• Correct scores today\n` +
      `• BTTS picks\n\n` +
      `<b>Match analysis</b>\n` +
      `• Arsenal vs Chelsea\n` +
      `• Over 3.5 today\n\n` +
      `<b>Stats markets</b>\n` +
      `• Corners (coming soon)\n` +
      `• Cards (coming soon)\n` +
      `• Player to score (coming soon)\n\n` +
      `<b>Useful</b>\n` +
      `• Win rate\n`, env);

  } catch (err) {
    console.error("[overline] handler:", err.message);
    await sendMessage(chatId, `Something went wrong. Try again.`, env);
  }
}

// ─── Dixon-Coles Engine ────────────────────────────────────────

let _modelCache = null;
let _cacheTime = 0;
const CACHE_TTL = 3600000;

async function getModel() {
  if (_modelCache && Date.now() - _cacheTime < CACHE_TTL) return _modelCache;

  let matches = [];

  // Fetch EPL + Championship (current season)
  const now = new Date();
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 7 ? year : year - 1;
  const season = `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`;

  for (const code of ["E0", "E1"]) {
    try {
      const url = `https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`;
      const resp = await fetch(url, { headers: { "User-Agent": "overline/3.0" } });
      if (resp.ok) {
        const csv = await resp.text();
        const parsed = parseCSV(csv);
        matches = [...matches, ...parsed];
      }
    } catch (e) { /* continue */ }
  }

  // If early season, add previous season too
  if (matches.length < 50) {
    const prevSeason = `${String(startYear - 1).slice(2)}${String(startYear).slice(2)}`;
    for (const code of ["E0", "E1"]) {
      try {
        const url = `https://www.football-data.co.uk/mmz4281/${prevSeason}/${code}.csv`;
        const resp = await fetch(url, { headers: { "User-Agent": "overline/3.0" } });
        if (resp.ok) {
          const csv = await resp.text();
          const parsed = parseCSV(csv);
          matches = [...parsed, ...matches];
        }
      } catch (e) { /* continue */ }
    }
  }

  _modelCache = fitDixonColes(matches);
  _cacheTime = Date.now();
  return _modelCache;
}

function poisPmf(k, lambda) {
  if (k < 0 || lambda <= 0) return 0;
  let logPmf = -lambda + k * Math.log(lambda);
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(logPmf - logFact);
}

function buildScoreMatrix(lambdaHome, lambdaAway, maxGoals = 8) {
  const grid = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    grid[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const p = poisPmf(h, lambdaHome) * poisPmf(a, lambdaAway);
      grid[h][a] = p;
      total += p;
    }
  }
  // Normalize
  for (let h = 0; h <= maxGoals; h++)
    for (let a = 0; a <= maxGoals; a++)
      grid[h][a] /= total;

  return grid;
}

function getTeamPair(model, strongTeam, weakTeam) {
  const hp = model.teams[strongTeam];
  const ap = model.teams[weakTeam];

  const lambdaHome = Math.max(0.2,
    hp.attack * ap.defence * model.homeAdvantage * model.leagueMeanHomeGoals / 1.35);
  const lambdaAway = Math.max(0.2,
    ap.attack * hp.defence * model.leagueMeanAwayGoals / 1.35);

  return { lambdaHome, lambdaAway };
}

function fuzzyFind(model, name) {
  const lower = name.toLowerCase();
  for (const team of Object.keys(model.teams)) {
    const tl = team.toLowerCase();
    if (tl === lower) return team;
    if (tl.length >= 4 && (tl.includes(lower) || lower.includes(tl))) return team;
  }
  // Word overlap
  const stop = new Set(["fc", "city", "united", "town", "afc"]);
  const nw = new Set(lower.split(" ").filter(w => !stop.has(w)));
  for (const team of Object.keys(model.teams)) {
    const tw = new Set(team.toLowerCase().split(" ").filter(w => !stop.has(w)));
    if (nw.size && tw.size && [...nw].some(w => tw.has(w))) return team;
  }
  return null;
}

// ─── Feature: CORRECT SCORES ──────────────────────────────────

async function cmdCorrectScores(chatId, env) {
  const model = await getModel();

  const teamsByStrength = Object.entries(model.teams)
    .map(([name, p]) => ({ name, score: p.attack / p.defence }))
    .sort((a, b) => b.score - a.score);

  const picks = [];
  const used = new Set();

  for (const strong of teamsByStrength.slice(0, 10)) {
    for (const weak of [...teamsByStrength].reverse()) {
      if (used.has(strong.name) || used.has(weak.name)) continue;
      if (strong.name === weak.name) continue;

      const { lambdaHome, lambdaAway } = getTeamPair(model, strong.name, weak.name);
      const grid = buildScoreMatrix(lambdaHome, lambdaAway);

      // Find top 3 correct scores
      const scores = [];
      for (let h = 0; h <= 5; h++) {
        for (let a = 0; a <= 5; a++) {
          scores.push({ score: `${h}-${a}`, prob: grid[h][a], h, a });
        }
      }
      scores.sort((a, b) => b.prob - a.prob);

      const best = scores[0];
      if (best.prob > 0.08) {
        // Fair odds with 15% bookmaker margin (CS markets have high margins)
        const fairOdds = 1 / best.prob;
        const bookOdds = Math.round(fairOdds * 0.85 * 100) / 100;

        picks.push({
          match: `${strong.name} vs ${weak.name}`,
          score: best.score,
          probability: best.prob,
          odds: Math.max(4, bookOdds),
        });
      }

      used.add(strong.name);
      used.add(weak.name);
      break;
    }

    if (picks.length >= 5) break;
  }

  picks.sort((a, b) => b.probability - a.probability);

  let msg = `<b>🎯 Correct Score Picks</b>\n\n`;
  picks.forEach((p, i) => {
    msg += `${i + 1}. <b>${p.match}</b>\n`;
    msg += `   ${p.score} @ ${p.odds.toFixed(2)} (${(p.probability * 100).toFixed(1)}%)\n`;
  });

  await sendMessage(chatId, msg, env, inlineKeys([
    ["Build CS ticket", "build ticket from correct scores"],
  ]));
}

// ─── Feature: OVERS ────────────────────────────────────────────

async function cmdOvers(chatId, line, env) {
  const model = await getModel();

  const teamsByStrength = Object.entries(model.teams)
    .map(([name, p]) => ({ name, attack: p.attack }))
    .sort((a, b) => b.attack - a.attack);

  const picks = [];
  const used = new Set();

  // Pair highest-attack teams together (most likely to score goals)
  for (let i = 0; i < Math.min(teamsByStrength.length - 1, 8); i += 2) {
    const teamA = teamsByStrength[i];
    const teamB = teamsByStrength[i + 1];

    if (used.has(teamA.name) || used.has(teamB.name)) continue;

    const hpA = model.teams[teamA.name];
    const hpB = model.teams[teamB.name];

    const lambdaH = Math.max(0.2,
      hpA.attack * hpB.defence * model.homeAdvantage * model.leagueMeanHomeGoals / 1.35);
    const lambdaA = Math.max(0.2,
      hpB.attack * hpA.defence * model.leagueMeanAwayGoals / 1.35);

    const grid = buildScoreMatrix(lambdaH, lambdaA);

    // Calculate P(total > line)
    let overProb = 0;
    for (let h = 0; h <= 8; h++) {
      for (let a = 0; a <= 8; a++) {
        if (h + a > line) overProb += grid[h][a];
      }
    }

    if (overProb > 0.30) { // only show if decent chance
      const fairOdds = 1 / overProb;
      const bookOdds = Math.round(fairOdds * 0.92 * 100) / 100;

      picks.push({
        match: `${teamA.name} vs ${teamB.name}`,
        market: `Over ${line}`,
        probability: overProb,
        odds: Math.max(1.5, bookOdds),
        xg: (lambdaH + lambdaA).toFixed(1),
      });
    }

    used.add(teamA.name);
    used.add(teamB.name);
  }

  picks.sort((a, b) => b.probability - a.probability);

  let msg = `<b>⚽ Over ${line} Goals</b>\n\n`;
  picks.forEach((p, i) => {
    msg += `${i + 1}. <b>${p.match}</b>\n`;
    msg += `   Over ${line} @ ${p.odds.toFixed(2)} (${(p.probability * 100).toFixed(0)}%)\n`;
    msg += `   xG total: ${p.xg}\n`;
  });

  if (!picks.length) {
    msg += `No strong over picks today. Try a lower line.`;
  }

  await sendMessage(chatId, msg, env);
}

// ─── Feature: BTTS ─────────────────────────────────────────────

async function cmdBTTS(chatId, env) {
  const model = await getModel();

  // Find teams with balanced attack AND weak defence (both likely to score)
  const teams = Object.entries(model.teams)
    .map(([name, p]) => ({ name, combined: p.attack + (2 - p.defence) }))
    .sort((a, b) => b.combined - a.combined);

  const picks = [];
  const used = new Set();

  for (let i = 0; i < Math.min(teams.length - 1, 8); i += 2) {
    const teamA = teams[i];
    const teamB = teams[i + 1];

    if (used.has(teamA.name) || used.has(teamB.name)) continue;

    const hpA = model.teams[teamA.name];
    const hpB = model.teams[teamB.name];

    const lambdaH = Math.max(0.2,
      hpA.attack * hpB.defence * model.homeAdvantage * model.leagueMeanHomeGoals / 1.35);
    const lambdaA = Math.max(0.2,
      hpB.attack * hpA.defence * model.leagueMeanAwayGoals / 1.35);

    const grid = buildScoreMatrix(lambdaH, lambdaA);

    let bttsProb = 0;
    for (let h = 1; h <= 8; h++) {
      for (let a = 1; a <= 8; a++) {
        bttsProb += grid[h][a];
      }
    }

    if (bttsProb > 0.45) {
      const fairOdds = 1 / bttsProb;
      const bookOdds = Math.round(fairOdds * 0.90 * 100) / 100;

      picks.push({
        match: `${teamA.name} vs ${teamB.name}`,
        market: "BTTS Yes",
        probability: bttsProb,
        odds: Math.max(1.5, bookOdds),
      });
    }

    used.add(teamA.name);
    used.add(teamB.name);
  }

  picks.sort((a, b) => b.probability - a.probability);

  let msg = `<b>🥅 BTTS Picks</b>\n\n`;
  picks.forEach((p, i) => {
    msg += `${i + 1}. <b>${p.match}</b>\n`;
    msg += `   BTTS @ ${p.odds.toFixed(2)} (${(p.probability * 100).toFixed(0)}%)\n`;
  });

  await sendMessage(chatId, msg, env);
}

// ─── Feature: BUILD TICKET ─────────────────────────────────────

async function cmdBuildTicket(chatId, text, env) {
  // Parse target odds
  let target = null;
  const mMatch = text.match(/(\d+)\s*m(?:illion)?/i);
  const kMatch = text.match(/(\d+)\s*k\b/i);
  const xMatch = text.match(/(\d+)\s*x?\b/i);
  const plain = text.match(/\b(\d{2,7})\b/);

  if (mMatch) target = parseInt(mMatch[1]) * 1000000;
  else if (kMatch) target = parseInt(kMatch[1]) * 1000;
  else if (xMatch) target = parseInt(xMatch[1]);
  else if (plain) target = parseInt(plain[1]);

  const model = await getModel();
  const teamsByStrength = Object.entries(model.teams)
    .map(([name, p]) => ({ name, score: p.attack / p.defence }))
    .sort((a, b) => b.score - a.score);

  // Generate all high-value picks across markets
  const allPicks = [];
  const used = new Set();

  for (const strong of teamsByStrength.slice(0, 12)) {
    for (const weak of [...teamsByStrength].reverse()) {
      if (used.has(strong.name) || used.has(weak.name)) continue;
      if (strong.name === weak.name) continue;

      const { lambdaHome, lambdaAway } = getTeamPair(model, strong.name, weak.name);
      const grid = buildScoreMatrix(lambdaHome, lambdaAway);

      // 1. Best correct score
      let bestCS = { score: "", prob: 0 };
      for (let h = 0; h <= 5; h++) {
        for (let a = 0; a <= 5; a++) {
          if (grid[h][a] > bestCS.prob) {
            bestCS = { score: `${h}-${a}`, prob: grid[h][a] };
          }
        }
      }
      if (bestCS.prob > 0.07) {
        allPicks.push({
          match: `${strong.name} vs ${weak.name}`,
          market: `CS ${bestCS.score}`,
          probability: bestCS.prob,
          odds: Math.max(4, Math.round(1 / bestCS.prob * 0.85)),
          type: "cs",
        });
      }

      // 2. Over 3.5
      let o35 = 0;
      for (let h = 0; h <= 8; h++)
        for (let a = 0; a <= 8; a++)
          if (h + a > 3.5) o35 += grid[h][a];
      if (o35 > 0.15) {
        allPicks.push({
          match: `${strong.name} vs ${weak.name}`,
          market: "Over 3.5",
          probability: o35,
          odds: Math.max(2.5, Math.round(1 / o35 * 0.90 * 100) / 100),
          type: "goals",
        });
      }

      // 3. BTTS + Over 2.5
      let bttsO25 = 0;
      for (let h = 1; h <= 8; h++)
        for (let a = 1; a <= 8; a++)
          if (h + a > 2.5) bttsO25 += grid[h][a];
      if (bttsO25 > 0.20) {
        allPicks.push({
          match: `${strong.name} vs ${weak.name}`,
          market: "BTTS + O2.5",
          probability: bttsO25,
          odds: Math.max(2, Math.round(1 / bttsO25 * 0.88 * 100) / 100),
          type: "combo",
        });
      }

      used.add(strong.name);
      used.add(weak.name);
      break;
    }
    if (allPicks.length >= 15) break;
  }

  // Build ticket — for high targets prioritize high odds, for low targets prioritize probability
  allPicks.sort((a, b) => {
    if (target && target > 100) return b.odds - a.odds;
    return (b.probability * b.odds) - (a.probability * a.odds); // EV sorting
  });

  const ticket = [];
  let totalOdds = 1;
  let jointProb = 1;

  for (const pick of allPicks) {
    // Don't pick two markets from the same match
    if (ticket.some(t => t.match === pick.match)) continue;

    ticket.push(pick);
    totalOdds *= pick.odds;
    jointProb *= pick.probability;

    if (target && totalOdds >= target) break;
    if (!target && ticket.length >= 4) break; // default 4 legs
  }

  totalOdds = Math.round(totalOdds * 100) / 100;

  let msg = `<b>🎫 Ticket</b>\n`;
  msg += `Total: <b>${totalOdds.toLocaleString()}x</b>\n`;
  msg += `Win probability: <b>${(jointProb * 100).toFixed(2)}%</b>\n`;
  msg += `Legs: ${ticket.length}\n\n`;

  ticket.forEach((t, i) => {
    msg += `${i + 1}. <b>${t.match}</b>\n`;
    msg += `   ${t.market} @ ${t.odds.toFixed(2)} (${(t.probability * 100).toFixed(0)}%)\n`;
  });

  await sendMessage(chatId, msg, env, inlineKeys([
    [`Optimize to 50x`, `optimize to 50`],
    [`More odds`, `give me ${Math.round(totalOdds * 10)} odds`],
  ]));
}

// ─── Feature: MATCH PREDICTION ────────────────────────────────

async function cmdPredictMatch(chatId, homeInput, awayInput, env) {
  const model = await getModel();

  const home = fuzzyFind(model, homeInput);
  const away = fuzzyFind(model, awayInput);

  if (!home || !away) {
    const available = Object.keys(model.teams).slice(0, 15).join(", ");
    await sendMessage(chatId, `Couldn't find those teams. I cover:\n${available}...`, env);
    return;
  }

  const { lambdaHome, lambdaAway } = getTeamPair(model, home, away);
  const grid = buildScoreMatrix(lambdaHome, lambdaAway);

  let hw = 0, d = 0, aw = 0, btts = 0, o25 = 0, o35 = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = grid[h][a];
      if (h > a) hw += p;
      else if (h === a) d += p;
      else aw += p;
      if (h > 0 && a > 0) btts += p;
      if (h + a > 2.5) o25 += p;
      if (h + a > 3.5) o35 += p;
    }
  }

  // Top 3 correct scores
  const scores = [];
  for (let h = 0; h <= 5; h++)
    for (let a = 0; a <= 5; a++)
      scores.push({ score: `${h}-${a}`, prob: grid[h][a] });
  scores.sort((a, b) => b.prob - a.prob);

  let msg = `<b>${home} vs ${away}</b>\n\n`;
  msg += `Win: <b>${(hw * 100).toFixed(0)}%</b> / ${((d) * 100).toFixed(0)}% / ${(aw * 100).toFixed(0)}%\n`;
  msg += `xG: ${lambdaHome.toFixed(1)}-${lambdaAway.toFixed(1)}\n\n`;
  msg += `BTTS: ${(btts * 100).toFixed(0)}% | O2.5: ${(o25 * 100).toFixed(0)}% | O3.5: ${(o35 * 100).toFixed(0)}%\n\n`;
  msg += `<b>Top scores:</b>\n`;
  scores.slice(0, 3).forEach(s => {
    msg += `  ${s.score} — ${(s.prob * 100).toFixed(1)}% @ ${(1 / s.prob * 0.85).toFixed(2)}\n`;
  });

  await sendMessage(chatId, msg, env);
}
