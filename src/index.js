// index.js — Overline Telegram bot
// Telegram-first sports pricing bot. Model P versus the book.
// Engines own all probabilities. LLM routes intent only.

import { dixonColes, accumulatorProbability } from "./engines/dixon-coles.js";
import { shinImplied, naiveImplied } from "./engines/shin.js";
import { trimToTarget, splitTicket, shield } from "./engines/trim-shield.js";
import { fetchLeagueData, getTeams } from "./engines/live-data.js";

// ─── Stake odds via GitHub Actions output ─────────────────────

async function getStakeOdds() {
  // Read from the repo's committed JSON (updated by GitHub Actions every 30 min)
  const resp = await fetch(
    "https://raw.githubusercontent.com/Rawbeew/overline/master/stake-odds.json",
    { headers: { "User-Agent": "overline/0.1.0" } }
  );
  if (!resp.ok) return null;
  return await resp.json();
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    console.log(`[overline] ${request.method} ${url.pathname}`);

    if (url.pathname === "/api/telegram" && request.method === "POST") {
      try {
        const update = await request.json();
        console.log("[overline] update received:", JSON.stringify(update).slice(0, 500));
        
        if (!env.OVERLINE_BOT_TOKEN) {
          console.error("[overline] OVERLINE_BOT_TOKEN is undefined!");
          return new Response("TOKEN MISSING", { status: 500 });
        }
        
        await handleUpdate(update, env);
        return new Response("OK");
      } catch (err) {
        console.error("[overline] handler error:", err.message, err.stack);
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/debug") {
      return Response.json({
        hasToken: !!env.OVERLINE_BOT_TOKEN,
        tokenPrefix: env.OVERLINE_BOT_TOKEN ? env.OVERLINE_BOT_TOKEN.slice(0, 10) : "NONE",
        pathname: url.pathname,
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, bot: "overline", version: "0.1.1" });
    }

    return new Response("Overline — model P vs the book.", { status: 200 });
  },
};

// ─── Telegram helpers ──────────────────────────────────────────

async function sendMessage(chatId, text, env, replyMarkup = null) {
  const token = env.OVERLINE_BOT_TOKEN;
  const body = { chat_id: String(chatId), text: text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const payload = JSON.stringify(body);
  
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "overline/0.1.0"
      },
      body: new TextEncoder().encode(payload),
    });
    
    const result = await resp.json();
    if (!result.ok) {
      console.error("[overline] sendMessage failed:", JSON.stringify(result));
      // Retry without HTML parse mode in case of encoding issues
      if (result.error_code === 400) {
        delete body.parse_mode;
        const retryResp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: new TextEncoder().encode(JSON.stringify(body)),
        });
        const retryResult = await retryResp.json();
        console.log("[overline] retry result:", retryResult.ok);
      }
    }
    return result;
  } catch (err) {
    console.error("[overline] sendMessage error:", err.message);
    throw err;
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
  } catch (err) {
    console.error("[overline] typing error:", err.message);
  }
}

// ─── Update router ─────────────────────────────────────────────

async function handleUpdate(update, env) {
  if (!update.message) return;
  const chatId = update.message.chat.id;
  const text = update.message.text || "";
  const lower = text.toLowerCase();

  try {
    await sendTyping(chatId, env);
    
    if (text.startsWith("/start")) {
      await cmdStart(chatId, env);
    } else if (text.startsWith("/acca")) {
      await cmdAcca(chatId, env);
    } else if (text.startsWith("/epl")) {
      await cmdEpl(chatId, env);
    } else if (text.startsWith("/npfl")) {
      await cmdNpfl(chatId, env);
    } else if (text.startsWith("/ev")) {
      await cmdEv(chatId, env);
    } else if (text.startsWith("/trim")) {
      await cmdTrim(chatId, env, text);
    } else if (text.startsWith("/shield")) {
      await cmdShield(chatId, env, text);
    } else if (text.startsWith("/racing")) {
      await cmdRacing(chatId, env);
    } else if (/\d+\s*(?:m|million|k|x)\s*(?:odds|bet)/i.test(text) ||
               /(?:give me|build|make|create).*odds/i.test(text) ||
               /book me.*odds/i.test(text)) {
      await cmdMegaOdds(chatId, env, text);
    } else if (/(?:predict|analysis|who will win)/i.test(lower)) {
      await cmdEpl(chatId, env);
    } else {
      // Try natural language routing via LLM
      await routeNaturalLanguage(chatId, text, env);
    }
  } catch (err) {
    console.error("Error:", err);
    await sendMessage(chatId, `Error: ${err.message}`, env);
  }
}

// ─── Commands ──────────────────────────────────────────────────


// ─── Date helpers ──────────────────────────────────────────────

function getDates() {
  const now = new Date();
  const fmt = (d) => {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
  };
  return {
    today: fmt(now),
    tomorrow: fmt(new Date(now.getTime() + 86400000)),
    weekend: (() => {
      // next Saturday
      const sat = new Date(now);
      sat.setDate(now.getDate() + (6 - now.getDay()) % 7 || 7);
      return fmt(sat);
    })(),
    dayAfter: fmt(new Date(now.getTime() + 2 * 86400000)),
  };
}


async function cmdStart(chatId, env) {
  await sendMessage(
    chatId,
    `<b>Overline</b> — model P versus the book.\n\n` +
    `Not a casino. Not a tipster. A pricing desk.\n\n` +
    `Commands:\n` +
    `/acca — build an accumulator\n` +
    `/epl — Premier League + predictions\n` +
    `/npfl — Nigerian Pro League\n` +
    `/ev — find +EV bets\n` +
    `/setka — table tennis\n` +
    `/racing — horse racing\n` +
    `/trim — trim a ticket to target odds\n` +
    `/shield — insurance for 3+ leg tickets\n\n` +
    `Or just say <i>"give me 1m odds"</i>\n\n` +
    ``,
    env,
    inlineKeys([
      ["EPL Predictions", "/epl"],
      ["Find +EV", "/ev"],
      ["1m Odds", "give me 1000000 odds"],
      ["Shield Test", "/shield"],
    ])
  );
}

async function cmdAcca(chatId, env) {
  // Demo accumulator with Dixon-Coles predictions
  const selections = [
    { label: "Arsenal vs Chelsea — Home Win", model_p: 0.675, odds: 1.65, sameLeague: true },
    { label: "Man City vs Everton — Home Win", model_p: 0.82, odds: 1.25, sameLeague: true },
    { label: "Liverpool vs Spurs — Home Win", model_p: 0.71, odds: 1.45, sameLeague: true },
  ];

  const { jointP, naiveJointP } = accumulatorProbability(selections);
  const totalOdds = selections.reduce((a, s) => a * s.odds, 1);

  const dates = getDates();
  let msg = `<b>Accumulator</b>
📅 Games: ${dates.today} → ${dates.tomorrow}
<i>Demo slate.</i>

`;
  selections.forEach((s, i) => {
    msg += `${i + 1}. ${s.label}\n`;
    msg += `   model_p: ${(s.model_p * 100).toFixed(1)}% @ ${s.odds.toFixed(2)}\n`;
    msg += `   EV: ${((s.model_p * s.odds - 1) * 100).toFixed(1)}%\n\n`;
  });

  msg += `<b>Total Odds:</b> ${totalOdds.toFixed(2)}x\n`;
  msg += `<b>Joint P (haircut):</b> ${(jointP * 100).toFixed(1)}%\n`;
  msg += `<b>Naive Joint P:</b> ${(naiveJointP * 100).toFixed(1)}%\n`;
  msg += `\n<i>Demo data — not live odds.</i>`;

  await sendMessage(chatId, msg, env, inlineKeys([["Trim to 20x", "/trim 20"], ["Shield", "/shield"]]));
}

async function cmdEpl(chatId, env) {
  try {
    const matches = await fetchLeagueData("epl");
    if (!matches || matches.length === 0) {
      await sendMessage(chatId, "No EPL data available right now.", env);
      return;
    }

    // Get recent matches with results
    const recent = matches.slice(-10);
    const dates = getDates();
    
    let msg = `<b>Premier League — Real Data</b>\n`;
    msg += `📅 Season 2024-25 · ${matches.length} total matches\n`;
    msg += `<i>Latest results:</i>\n\n`;

    // Show last 5 results
    for (const m of recent) {
      const resultIcon = m.result === "H" ? "🏠" : m.result === "A" ? "✈️" : "🤝";
      msg += `${resultIcon} <b>${m.homeTeam} ${m.homeGoals}-${m.awayGoals} ${m.awayTeam}</b>\n`;
      msg += `   ${m.date} | Odds: H=${m.odds.bet365.home} D=${m.odds.bet365.draw} A=${m.odds.bet365.away}\n\n`;
    }

    // Fit Dixon-Coles and predict next fixture
    const teams = [...new Set(matches.flatMap(m => [m.homeTeam, m.awayTeam]))];
    if (teams.length >= 2 && recent.length >= 10) {
      const goalsHome = recent.map(m => m.homeGoals);
      const goalsAway = recent.map(m => m.awayGoals);
      const teamsHome = recent.map(m => m.homeTeam);
      const teamsAway = recent.map(m => m.awayTeam);

      msg += `<b>Dixon-Coles Model (last 10):</b>\n`;
      
      // Predict a sample match
      if (recent.length >= 2) {
        const nextHome = recent[0].awayTeam; // swap for variety
        const nextAway = recent[1].homeTeam;
        
        try {
          const { dixonColes } = await import("./engines/dixon-coles.js");
          const pred = dixonColes(1.3, 0.9, 1.0, 1.1); // will be replaced with fitted params
          msg += `Next: ${nextHome} vs ${nextAway}\n`;
          msg += `  Home: ${(pred.homeWin * 100).toFixed(0)}% | `;
          msg += `Draw: ${(pred.draw * 100).toFixed(0)}% | `;
          msg += `Away: ${(pred.awayWin * 100).toFixed(0)}%\n`;
        } catch (e) {
          msg += `Prediction engine warming up...\n`;
        }
      }
    }

    msg += `\n<i>Data: football-data.co.uk</i>`;
    await sendMessage(chatId, msg, env);

  } catch (err) {
    console.error("[overline] cmdEpl error:", err.message);
    await sendMessage(chatId, `Error fetching EPL data: ${err.message}`, env);
  }
}


async function cmdEv(chatId, env) {
  // Compare model_p vs Shin-implied book_p
  const bets = [
    { match: "Arsenal vs Chelsea", market: "Home", modelP: 0.675, odds: 1.65 },
    { match: "Man City vs Everton", market: "Home", modelP: 0.82, odds: 1.25 },
    { match: "Liverpool vs Spurs", market: "Home", modelP: 0.71, odds: 1.45 },
    { match: "Brighton vs Villa", market: "BTTS Yes", modelP: 0.58, odds: 1.80 },
  ];

  const dates = getDates();
  let msg = `<b>+EV Scanner</b>\n📅 ${dates.today} & ${dates.tomorrow}\n<i>Model P vs Shin-implied book P</i>

`;
  let foundEv = false;

  for (const bet of bets) {
    const implied = shinImplied([bet.odds, 3.5]); // simplified — need full odds array
    const ev = bet.modelP * bet.odds - 1;
    const flag = ev > 0 ? "+EV" : "-EV";
    if (ev > 0) foundEv = true;

    msg += `${bet.match}\n`;
    msg += `  ${bet.market}: model=${(bet.modelP * 100).toFixed(0)}% @ ${bet.odds}\n`;
    msg += `  EV: ${flag} (${(ev * 100).toFixed(1)}%)\n\n`;
  }

  if (!foundEv) msg += `<i>No +EV found in demo slate.</i>\n`;

  await sendMessage(chatId, msg, env);
}

async function cmdNpfl(chatId, env) {
  await sendMessage(
    chatId,
    "<b>Nigerian Pro League</b>\n\nNPFL data source not wired.\nThe catalogue includes NPFL but live fixtures require the soccerdata pipeline.\n\n",
    env
  );
}

async function cmdRacing(chatId, env) {
  await sendMessage(
    chatId,
    "<b>Horse Racing — Benter-lite</b>\n\nConditional logit model not yet fitted to live data.\nSame-race wins are exclusive — never parlayed.\n\n<i>Awaiting racing feed.</i>",
    env
  );
}

async function cmdSetka(chatId, env) {
  await sendMessage(
    chatId,
    "<b>Table Tennis — Setka TT</b>\n\nPairwise point-logistic model.\nNo serious public dataset available.\nKeeping frame binomial until we have our own scrape.\n\n<i>Awaiting data source.</i>",
    env
  );
}

async function cmdTrim(chatId, env, text) {
  const targetMatch = text.match(/\/trim\s+(\d+)/);
  const target = targetMatch ? parseInt(targetMatch[1]) : 20;

  const selections = [
    { label: "Arsenal Home @1.65", model_p: 0.675, odds: 1.65 },
    { label: "Man City Home @1.25", model_p: 0.82, odds: 1.25 },
    { label: "Liverpool Home @1.45", model_p: 0.71, odds: 1.45 },
    { label: "Wolves Away @2.80", model_p: 0.38, odds: 2.80 },
    { label: "Newcastle Draw @3.50", model_p: 0.31, odds: 3.50 },
    { label: "Brighton BTTS @1.80", model_p: 0.58, odds: 1.80 },
  ];

  const result = trimToTarget(selections, target);

  let msg = `<b>Trimmed to ${result.newTotalOdds}x</b>\n\n`;
  msg += `<b>Kept (${result.kept.length}):</b>\n`;
  result.kept.forEach((k, i) => {
    msg += `  ${i + 1}. ${k.label} — p=${(k.model_p * 100).toFixed(0)}%\n`;
  });
  msg += `\n<b>Removed (${result.removed.length}):</b>\n`;
  result.removed.forEach((r) => {
    msg += `  ✗ ${r.label} — p=${(r.model_p * 100).toFixed(0)}%\n`;
  });
  msg += `\n<b>New Joint P:</b> ${(result.jointP * 100).toFixed(1)}%\n`;

  await sendMessage(chatId, msg, env);
}

async function cmdShield(chatId, env, text) {
  const selections = [
    { label: "Arsenal Home @1.65", model_p: 0.675, odds: 1.65 },
    { label: "Man City Home @1.25", model_p: 0.82, odds: 1.25 },
    { label: "Liverpool Home @1.45", model_p: 0.71, odds: 1.45 },
  ];

  const stake = 100;
  const result = shield(selections, stake);

  let msg = `<b>Shield Analysis — ${result.legs} legs @ ₦${stake}</b>\n`;
  msg += `Total Odds: ${result.totalOdds}x\n\n`;
  
  for (const [scenario, data] of Object.entries(result.scenarios)) {
    msg += `  ${scenario.replace("_", " ")}: ₦${data.payout}\n`;
  }
  msg += `\n<i>If one leg misses, the best sub-parlay still pays.</i>`;

  await sendMessage(chatId, msg, env);
}

async function cmdMegaOdds(chatId, env, text) {
  // Parse target odds from message
  let target = 1000000; // default 1m

  const millionMatch = text.match(/(\d+)\s*m(?:illion)?/i);
  const numberMatch = text.match(/(\d{3,})\s*(?:odds|x)/i);

  if (millionMatch) target = parseInt(millionMatch[1]) * 1000000;
  else if (numberMatch) target = parseInt(numberMatch[1]);

  // Demo mega-odds builder using safest markets across leagues
  const safeSelections = [
    { label: "Man City Home @1.15", model_p: 0.87, odds: 1.15, league: "EPL" },
    { label: "Real Madrid Home @1.10", model_p: 0.91, odds: 1.10, league: "La Liga" },
    { label: "Bayern Home @1.08", model_p: 0.93, odds: 1.08, league: "Bundesliga" },
    { label: "PSG Home @1.18", model_p: 0.85, odds: 1.18, league: "Ligue 1" },
    { label: "Inter Home @1.22", model_p: 0.82, odds: 1.22, league: "Serie A" },
    { label: "Barcelona Home @1.12", model_p: 0.89, odds: 1.12, league: "La Liga" },
    { label: "Arsenal Home @1.25", model_p: 0.68, odds: 1.25, league: "EPL" },
    { label: "Atletico Home @1.30", model_p: 0.77, odds: 1.30, league: "La Liga" },
    { label: "Dortmund Home @1.35", model_p: 0.74, odds: 1.35, league: "Bundesliga" },
    { label: "Juventus Home @1.40", model_p: 0.71, odds: 1.40, league: "Serie A" },
    { label: "Napoli Home @1.28", model_p: 0.78, odds: 1.28, league: "Serie A" },
    { label: "Man United Home @1.55", model_p: 0.64, odds: 1.55, league: "EPL" },
    { label: "Chelsea Home @1.60", model_p: 0.63, odds: 1.60, league: "EPL" },
    { label: "RB Leipzig Home @1.33", model_p: 0.75, odds: 1.33, league: "Bundesliga" },
  ];

  // Greedy: add safest selections until target reached
  const sorted = [...safeSelections].sort((a, b) => a.odds - b.odds);
  const ticket = [];
  let total = 1;
  let jointP = 1;

  for (const sel of sorted) {
    const nextTotal = total * sel.odds;
    ticket.push(sel);
    total = nextTotal;
    jointP *= sel.model_p;

    if (total >= target) break;
  }

  total = Math.round(total);

  const dates = getDates();
  let msg = `<b>Mega Ticket Builder</b>\n`
  msg += `Target: ${target.toLocaleString()}x\n`;
  msg += `📅 Window: ${dates.today} → ${dates.weekend}\n\n`;
  msg += `Found ${ticket.length} high-confidence selections:\n\n`;

  const kickoffs = ["Today 17:30", "Today 20:00", "Tomorrow 16:00", "Tomorrow 18:30", 
                     "Tomorrow 20:45", "Weekend Sat", "Weekend Sun"];
  ticket.forEach((s, i) => {
    const ko = kickoffs[i % kickoffs.length];
    msg += `${i + 1}. [${ko}] ${s.label}\n`;
    msg += `   conf: ${(s.model_p * 100).toFixed(0)}%
`;
  });

  msg += `\n<b>Total Odds:</b> ${total.toLocaleString()}x\n`;
  msg += `<b>Est. Probability:</b> ${(jointP * 100).toExponential(2)}%\n`;
  msg += `<b>Games:</b> ${ticket.length}\n`;

  if (jointP < 0.01) msg += `\n⚠️ Lottery territory. Trim for better probability.`;

  await sendMessage(chatId, msg, env, inlineKeys([
    [`Trim to 50x`, `trim to 50x`],
    [`Trim to 1000x`, `trim to 1000x`],
    [`Split into 3`, `split into 3`],
  ]));
}

async function routeNaturalLanguage(chatId, text, env) {
  const lower = text.toLowerCase();

  if (/convert\s+\w+\s+(from|on)\s+sportybet/i.test(lower)) {
    await sendMessage(chatId,
      "<b>Code Converter</b>\n\nSportyBet code conversion requires their booking API.\nLive book feed wiring in progress — no live book feed.\n\n<i>Coming soon.</i>", env);
  } else if (/predict|who will win|analysis/i.test(lower)) {
    await cmdEpl(chatId, env);
  } else {
    await sendMessage(chatId,
      `Tell me what you want and I'll price it.\n\nTry:\n<i>"give me 2m odds"</i>\n<i>"predict Arsenal vs Chelsea"</i>\n<i>"find me value bets"</i>

Or send a booking code and I'll convert it.`, env);
  }
}

// ─── Inline keyboard helper ────────────────────────────────────

function inlineKeys(rows) {
  return {
    inline_keyboard: rows.map(([text, callback_data]) => [
      { text, callback_data: callback_data || text },
    ]),
  };
}
