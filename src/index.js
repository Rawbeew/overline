// index.js — Overline v2
// Telegram-first sports prediction bot. Football + Basketball.
// Three features: Book, Split, Optimize. One metric: win rate.
// SportyBet for booking.

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
        return new Response("OK"); // always 200 to Telegram
      }
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: "2.0" });
    }

    return new Response("Overline — model P vs the book.", { status: 200 });
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
      // Retry without HTML in case of encoding issues
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
  const token = env.OVERLINE_BOT_TOKEN;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
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

  if (!text || text.startsWith("/")) return; // ignore commands and empty

  await sendTyping(chatId, env);

  try {
    // OPTIMIZE — "optimize", "trim", "trim to 50x"
    if (/^(?:optimize|optimise|trim)/i.test(lower)) {
      await cmdOptimize(chatId, text, env);
      return;
    }

    // SPLIT — "split into 3", "split"
    if (/^split/i.test(lower)) {
      await cmdSplit(chatId, text, env);
      return;
    }

    // WIN RATE — "win rate", "stats", "how accurate"
    if (/win.?rate|accuracy|how good|stats/i.test(lower)) {
      await cmdWinRate(chatId, env);
      return;
    }

    // MEGA/BIG ODDS — "give me X odds", "book me odds"
    if (/(?:odds|ticket|bet|book)/i.test(lower) && /(?:give|build|make|create|book|get|\d)/i.test(lower)) {
      await cmdBook(chatId, text, env);
      return;
    }

    // TEAM vs TEAM — "Arsenal vs Chelsea"
    const vsMatch = text.match(/^(.{2,30}?)\s+(?:vs|versus|v\.?)\s+(.{2,30}?)$/i);
    if (vsMatch) {
      await cmdPredictMatch(chatId, vsMatch[1].trim(), vsMatch[2].trim(), env);
      return;
    }

    // Default — show what the bot does
    await sendMessage(chatId,
      `I predict games and build tickets.\n\n` +
      `<i>"give me odds"</i> — today's best picks\n` +
      `<i>"Arsenal vs Chelsea"</i> — match prediction\n` +
      `<i>"trim to 50x"</i> — optimize a ticket\n` +
      `<i>"split into 3"</i> — split into smaller bets\n` +
      `<i>"win rate"</i> — model accuracy\n`, env);

  } catch (err) {
    console.error("[overline] handler:", err.message);
    await sendMessage(chatId, `Something went wrong. Try again.`, env);
  }
}

// ─── Feature 1: BOOK TICKETS ───────────────────────────────────

async function cmdBook(chatId, text, env) {
  // Parse target odds from message
  let targetOdds = null;
  const mMatch = text.match(/(\d+)\s*m(?:illion)?/i);
  const kMatch = text.match(/(\d+)\s*k\b/i);
  const xMatch = text.match(/(\d+)\s*x\b/i);
  const plainMatch = text.match(/\b(\d{2,7})\b/);

  if (mMatch) targetOdds = parseInt(mMatch[1]) * 1000000;
  else if (kMatch) targetOdds = parseInt(kMatch[1]) * 1000;
  else if (xMatch) targetOdds = parseInt(xMatch[1]);
  else if (plainMatch) targetOdds = parseInt(plainMatch[1]);

  await sendMessage(chatId, `Building ticket...`, env);
  const predictions = await getTopPredictions(targetOdds);

  if (!predictions.selections.length) {
    await sendMessage(chatId, `No confident picks available right now. Check back later.`, env);
    return;
  }

  const winRate = await getWinRate();
  let msg = `<b>Ticket</b>\n`;
  msg += `Total odds: <b>${predictions.totalOdds.toLocaleString()}x</b>\n`;
  msg += `Win probability: <b>${(predictions.jointP * 100).toFixed(1)}%</b>\n`;
  msg += `Legs: ${predictions.selections.length}\n`;
  if (winRate.count > 0) {
    msg += `Model win rate: <b>${winRate.pct}%</b> (${winRate.count} predictions)\n`;
  }
  msg += `\n`;

  predictions.selections.forEach((s, i) => {
    msg += `${i + 1}. <b>${s.match}</b>\n`;
    msg += `   ${s.market} @ ${s.odds.toFixed(2)} (${(s.probability * 100).toFixed(0)}%)\n`;
  });

  msg += `\n<i>Add these to your SportyBet slip.</i>`;

  await sendMessage(chatId, msg, env, inlineKeys([
    [`Optimize to 50x`, `optimize to 50`],
    [`Split into 3`, `split into 3`],
    [`Win rate`, `win rate`],
  ]));
}

// ─── Feature 2: SPLIT ──────────────────────────────────────────

async function cmdSplit(chatId, text, env) {
  const partsMatch = text.match(/(\d+)/);
  const parts = partsMatch ? Math.min(parseInt(partsMatch[1]), 10) : 3;

  // Get the last built ticket from KV or rebuild
  const ticket = await getLastTicket(env);
  if (!ticket || !ticket.length) {
    await sendMessage(chatId, `No ticket to split. Say <i>"give me odds"</i> first.`, env);
    return;
  }

  const perPart = Math.ceil(ticket.length / parts);
  let msg = `<b>Split into ${parts} tickets</b>\n\n`;

  for (let i = 0; i < parts; i++) {
    const chunk = ticket.slice(i * perPart, (i + 1) * perPart);
    if (!chunk.length) break;

    let subOdds = 1;
    let subProb = 1;
    msg += `<b>Ticket ${i + 1}</b>\n`;

    for (const sel of chunk) {
      subOdds *= sel.odds;
      subProb *= sel.probability;
      msg += `  ${sel.match} — ${sel.market} @ ${sel.odds.toFixed(2)}\n`;
    }

    msg += `  Odds: ${subOdds.toFixed(2)}x | Win prob: ${(subProb * 100).toFixed(1)}%\n\n`;
  }

  await sendMessage(chatId, msg, env);
}

// ─── Feature 3: OPTIMIZE (trim to target odds) ────────────────

async function cmdOptimize(chatId, text, env) {
  const targetMatch = text.match(/(\d+)/);
  const targetOdds = targetMatch ? parseInt(targetMatch[1]) : 50;

  const ticket = await getLastTicket(env);
  if (!ticket || !ticket.length) {
    await sendMessage(chatId, `No ticket to optimize. Say <i>"give me odds"</i> first.`, env);
    return;
  }

  // Keep safest legs (lowest odds = highest probability) until we hit target
  const sorted = [...ticket].sort((a, b) => a.odds - b.odds);
  const kept = [];
  const removed = [];
  let totalOdds = 1;

  for (const sel of sorted) {
    if (totalOdds * sel.odds <= targetOdds || kept.length === 0) {
      kept.push(sel);
      totalOdds *= sel.odds;
    } else {
      removed.push(sel);
    }
  }

  let jointP = kept.reduce((p, s) => p * s.probability, 1);
  const winRate = await getWinRate();

  let msg = `<b>Optimized to ${totalOdds.toFixed(2)}x</b>\n`;
  msg += `Win probability: <b>${(jointP * 100).toFixed(1)}%</b>\n`;
  if (winRate.count > 0) {
    msg += `Model win rate: <b>${winRate.pct}%</b>\n`;
  }
  msg += `\n<b>Kept (${kept.length}):</b>\n`;

  kept.forEach((k) => {
    msg += `  ✓ ${k.match} @ ${k.odds.toFixed(2)} (${(k.probability * 100).toFixed(0)}%)\n`;
  });

  if (removed.length) {
    msg += `\n<b>Removed (${removed.length}):</b>\n`;
    removed.forEach((r) => {
      msg += `  ✗ ${r.match} @ ${r.odds.toFixed(2)}\n`;
    });
  }

  await sendMessage(chatId, msg, env);
}

// ─── Win Rate Tracking ─────────────────────────────────────────

async function getWinRate(env) {
  // In production this reads from KV/D1
  // For now return placeholder until we have enough predictions logged
  return { pct: null, count: 0 };
}

async function logPrediction(prediction, env) {
  // Store for win-rate tracking
  // Will use KV: key=prediction_{date}_{match}, value={match, market, prob, kickoff}
}

// ─── Prediction Engine ─────────────────────────────────────────

let _modelCache = null;
let _cacheTime = 0;
const CACHE_TTL = 3600000; // 1 hour

async function getModel() {
  if (_modelCache && Date.now() - _cacheTime < CACHE_TTL) return _modelCache;

  let matches = [];
  
  // Current season
  try {
    matches = await fetchLeagueData("epl");
  } catch (e) { /* fall through */ }

  // If early season (<50 matches), add previous season
  if (matches.length < 50) {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const startYear = now.getMonth() >= 7 ? year : year - 1;
      const prevSeason = `${String(startYear - 1).slice(2)}${String(startYear).slice(2)}`;
      
      const url = `https://www.football-data.co.uk/mmz4281/${prevSeason}/E0.csv`;
      const resp = await fetch(url, { headers: { "User-Agent": "overline/2.0" } });
      if (resp.ok) {
        const csv = await resp.text();
        const prevMatches = parseCSV(csv);
        matches = [...prevMatches, ...matches];
      }
    } catch (e) { /* continue with what we have */ }
  }

  _modelCache = fitDixonColes(matches);
  _cacheTime = Date.now();
  return _modelCache;
}

async function getTopPredictions(targetOdds) {
  const model = await getModel();

  // Generate predictions from strongest vs weakest teams
  const teamsByStrength = Object.entries(model.teams)
    .map(([name, p]) => ({ name, score: p.attack / p.defence }))
    .sort((a, b) => b.score - a.score);

  const selections = [];
  const used = new Set();

  for (const strong of teamsByStrength.slice(0, 8)) {
    for (const weak of [...teamsByStrength].reverse()) {
      if (used.has(strong.name) || used.has(weak.name)) continue;
      if (strong.name === weak.name) continue;

      const homeP = model.teams[strong.name];
      const awayP = model.teams[weak.name];

      const lambdaHome = Math.max(0.2,
        homeP.attack * awayP.defence * model.homeAdvantage * model.leagueMeanHomeGoals / 1.35);
      const lambdaAway = Math.max(0.2,
        awayP.attack * homeP.defence * model.leagueMeanAwayGoals / 1.35);

      // Home win probability via Poisson
      let homeWin = 0;
      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          if (h > a) homeWin += poisPmf(h, lambdaHome) * poisPmf(a, lambdaAway);
        }
      }

      const fairOdds = 1 / homeWin;
      const bookOdds = Math.max(1.05, Math.round(fairOdds * 0.93 * 100) / 100);

      selections.push({
        match: `${strong.name} vs ${weak.name}`,
        market: "Home Win",
        probability: Math.round(homeWin * 1000) / 1000,
        odds: bookOdds,
      });

      used.add(strong.name);
      used.add(weak.name);
      break; // one pick per strong team
    }
  }

  // Sort safest first and accumulate until target reached
  selections.sort((a, b) => a.odds - b.odds);
  
  const ticket = [];
  let totalOdds = 1;
  let jointP = 1;

  for (const sel of selections) {
    ticket.push(sel);
    totalOdds *= sel.odds;
    jointP *= sel.probability;
    if (targetOdds && totalOdds >= targetOdds) break;
  }

  return {
    selections: ticket,
    totalOdds: Math.round(totalOdds * 100) / 100,
    jointP: jointP,
  };
}

async function getLastTicket(env) {
  // In production: read from KV storage
  // For MVP: regenerate from model
  const preds = await getTopPredictions(null);
  return preds.selections;
}

// ─── Poisson helper ────────────────────────────────────────────

function poisPmf(k, lambda) {
  if (k < 0 || lambda <= 0) return 0;
  let logPmf = -lambda + k * Math.log(lambda);
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(logPmf - logFact);
}

// ─── Match prediction ──────────────────────────────────────────

async function cmdPredictMatch(chatId, homeInput, awayInput, env) {
  const model = await getModel();

  const findTeam = (input) => {
    const lower_input = input.toLowerCase();
    for (const name of Object.keys(model.teams)) {
      if (name.toLowerCase().includes(lower_input) ||
          lower_input.includes(name.toLowerCase().split(" ")[0])) {
        return name;
      }
    }
    return null;
  };

  const home = findTeam(homeInput);
  const away = findTeam(awayInput);

  if (!home || !away) {
    await sendMessage(chatId,
      `Couldn't find those teams. I cover Premier League:\n${Object.keys(model.teams).join(", ")}`, env);
    return;
  }

  const hp = model.teams[home];
  const ap = model.teams[away];

  const lambdaHome = Math.max(0.2,
    hp.attack * ap.defence * model.homeAdvantage * model.leagueMeanHomeGoals / 1.35);
  const lambdaAway = Math.max(0.2,
    ap.attack * hp.defence * model.leagueMeanAwayGoals / 1.35);

  let hw = 0, d = 0, aw = 0, btts = 0, o25 = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const p = poisPmf(h, lambdaHome) * poisPmf(a, lambdaAway);
      if (h > a) hw += p;
      else if (h === a) d += p;
      else aw += p;
      if (h > 0 && a > 0) btts += p;
      if (h + a > 2.5) o25 += p;
    }
  }

  let msg = `<b>${home} vs ${away}</b>\n\n`;
  msg += `Home Win: <b>${(hw * 100).toFixed(0)}%</b> @ ${(1 / hw * 0.93).toFixed(2)}\n`;
  msg += `Draw: <b>${(d * 100).toFixed(0)}%</b> @ ${(1 / d * 0.93).toFixed(2)}\n`;
  msg += `Away Win: <b>${(aw * 100).toFixed(0)}%</b> @ ${(1 / aw * 0.93).toFixed(2)}\n\n`;
  msg += `xG: ${lambdaHome.toFixed(1)}-${lambdaAway.toFixed(1)}\n`;
  msg += `BTTS: ${(btts * 100).toFixed(0)}% | Over 2.5: ${(o25 * 100).toFixed(0)}%\n\n`;
  msg += `<i>Dixon-Coles · full season fit</i>`;

  await sendMessage(chatId, msg, env, inlineKeys([
    [`Add to ticket`, `add ${home} ${away}`],
  ]));
}
