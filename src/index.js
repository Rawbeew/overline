// index.js — Overline v4
// Conversational stats betting bot. Talks like a person.
// Bulletproof: never crashes, always responds.

import { fetchLeagueData, parseCSV } from "./engines/live-data.js";
import { fitDixonColes } from "./engines/dc-model.js";

// ─── Access Control & Paywall ──────────────────────────────────

const FREE_LIMIT = 2;  // total free requests ever

async function getUserAccess(env, chatId) {
  if (!env.FIXTURES) return { plan: "free", requests_used: 0, tokens: 0, expires: null };
  
  try {
    const key = `user_${chatId}`;
    const data = await env.FIXTURES.get(key, "json");
    return data || { plan: "free", requests_used: 0, tokens: 0, expires: null };
  } catch (e) {
    return { plan: "free", requests_used: 0, tokens: 0, expires: null };
  }
}

async function saveUserAccess(env, chatId, access) {
  if (!env.FIXTURES) return;
  try {
    await env.FIXTURES.put(`user_${chatId}`, JSON.stringify(access));
  } catch (e) { /* ignore */ }
}

async function checkAndIncrement(env, chatId) {
  const access = await getUserAccess(env, chatId);
  
  if (access.plan === "premium" || access.plan === "lite") {
    // Check expiry
    if (access.expires && new Date(access.expires) < new Date()) {
      access.plan = "free";
      access.expires = null;
    }
    
    // Premium with tokens
    if (access.plan === "premium") {
      if (access.tokens > 0) {
        access.tokens -= 1;
        await saveUserAccess(env, chatId, access);
        return { allowed: true, access };
      }
      // Premium but no tokens — can still edit codes, no fresh research
      return { allowed: true, access, noTokens: true };
    }
    
    // Lite
    const today = new Date().toISOString().split("T")[0];
    if (access.last_request_date !== today) {
      access.daily_count = 0;
      access.last_request_date = today;
    }
    if ((access.daily_count || 0) < 15) {
      access.daily_count = (access.daily_count || 0) + 1;
      await saveUserAccess(env, chatId, access);
      return { allowed: true, access };
    }
    return { allowed: false, access, reason: "daily_limit" };
  }
  
  // Free tier
  if (access.requests_used < FREE_LIMIT) {
    access.requests_used += 1;
    await saveUserAccess(env, chatId, access);
    return { allowed: true, access, freeRemaining: FREE_LIMIT - access.requests_used };
  }
  
  return { allowed: false, access, reason: "free_exhausted" };
}

function getUpgradeMessage() {
  return `❌ <b>No Active Access</b>\n\n` +
    `You've used your free requests. Upgrade to keep going.\n\n` +
    
    `💎 <b>Premium</b> — from ₦500\n` +
    `• Fresh AI predictions\n` +
    `• Correct scores & overs analysis\n` +
    `• Auto-built tickets\n` +
    `• Match research\n\n` +
    
    `⚡ <b>Lite</b> — from ₦200\n` +
    `• 15 requests/day\n` +
    `• Edit existing tickets\n` +
    `• Split, trim, combine\n\n` +
    
    `Use /pricing to choose.`;
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/telegram" && request.method === "POST") {
      let chatId = null;
      try {
        const update = await request.json();
        chatId = update?.message?.chat?.id;
        const text = update?.message?.text || "";

        if (!chatId || !text) {
          return new Response("OK");
        }

        // Send typing indicator (non-blocking)
        try {
          await fetch(`https://api.telegram.org/bot${env.OVERLINE_BOT_TOKEN}/sendChatAction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: String(chatId), action: "typing" }),
          });
        } catch (e) { /* ignore */ }

        // Handle slash commands
        if (text.startsWith("/")) {
          const cmd = text.split(" ")[0].toLowerCase();
          
          if (cmd === "/start") {
            response = "👋 Welcome to <b>Overline</b>.\n\nI predict football matches using stats.\n\nTry: \"correct scores\" or \"give me 50 odds\"\n\nYou get 2 free requests. Use /upgrade for unlimited.";
          }
          else if (cmd === "/help") {
            response = "How Overline works:\n\nI use a statistical model (Dixon-Coles) to predict match outcomes.\n\nAsk me for correct scores, overs, BTTS, or build a ticket.\n\nFree: 2 requests total\nPremium: unlimited predictions\nLite: 15 requests/day for code editing";
          }
          else if (cmd === "/upgrade") {
            response = getUpgradeMessage();
          }
          else if (cmd === "/pricing") {
            response = `💎 <b>Premium</b>\n• 1 Day — ₦500\n• 7 Days — ₦2,000\n• 30 Days — ₦5,000\n\n⚡ <b>Lite</b>\n• 1 Day — ₦200\n• 7 Days — ₦1,000\n• 30 Days — ₦3,500\n\n💎 Premium includes research tokens for fresh predictions.\n\nUse /upgrade to choose.`;
          }
          else if (cmd === "/benefits") {
            response = `🆓 <b>Free</b>\n• 2 requests total\n• Basic predictions only\n\n💎 <b>Premium</b>\n• Fresh AI predictions\n• Correct scores & overs\n• Auto-built tickets\n• Booking codes\n• Match analysis\n\n⚡ <b>Lite</b>\n• 15 requests/day\n• Edit existing tickets\n• Split, trim, combine\n\nUse /upgrade to choose.`;
          }
          else if (cmd === "/subscription") {
            const access = await getUserAccess(env, chatId);
            if (access.plan === "free") {
              response = `❌ <b>No Active Access</b>\n\nRequests used: ${access.requests_used}/${FREE_LIMIT}\n\nUse /upgrade to choose Lite or Premium.`;
            } else {
              const expiry = access.expires ? new Date(access.expires).toDateString() : "N/A";
              response = `✅ <b>${access.plan.toUpperCase()}</b>\nExpires: ${expiry}\nTokens: ${access.tokens || 0}`;
            }
          }
          else if (cmd === "/usage") {
            const access = await getUserAccess(env, chatId);
            response = `📊 <b>Usage</b>\nPlan: ${access.plan}\nRequests used: ${access.requests_used || 0}\nTokens remaining: ${access.tokens || 0}`;
          }
          else {
            response = "Unknown command. Try /help";
          }
          
          await sendMsg(chatId, response, env);
          return new Response("OK");
        }
        
        // Check paywall for non-command messages
        const accessCheck = await checkAndIncrement(env, chatId);
        
        if (!accessCheck.allowed) {
          response = getUpgradeMessage();
          await sendMsg(chatId, response, env);
          return new Response("OK");
        }
        
        // Generate response — wrapped so nothing crashes
        let response;
        try {
          response = await generateResponse(text, env);
          
          // Add remaining free requests note
          if (accessCheck.freeRemaining !== undefined) {
            response += `\n\n<i>${accessCheck.freeRemaining} free requests remaining. /upgrade for unlimited.</i>`;
          }
        } catch (innerErr) {
          console.error("[overline] generate error:", innerErr.message);
          response = "Hmm, hit a snag there. Try again.";
        }

        // Always try to send something
        if (response) {
          await sendMsg(chatId, response, env);
        }

        return new Response("OK");
      } catch (outerErr) {
        console.error("[overline] outer:", outerErr.message);
        // Last resort: try to tell the user
        if (chatId) {
          try {
            await fetch(`https://api.telegram.org/bot${env.OVERLINE_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: String(chatId), text: "Something broke. Give me a sec." }),
            });
          } catch (e) { /* truly broken */ }
        }
        return new Response("OK");
      }
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: "4.0" });
    }

    return new Response("Overline", { status: 200 });
  },
};

// ─── Message sender ────────────────────────────────────────────

async function sendMsg(chatId, text, env) {
  // Try HTML first, fallback to plain text
  const attempts = [
    { text: text, parse_mode: "HTML" },
    { text: text },  // no parse_mode = plain text
  ];

  for (const body of attempts) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${env.OVERLINE_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: String(chatId), ...body }),
      });
      const result = await resp.json();
      if (result.ok) return; // success!
      console.error("[overline] send failed:", result.description);
    } catch (e) {
      console.error("[overline] send error:", e.message);
    }
  }
}

// ─── Response Generator ────────────────────────────────────────

async function generateResponse(text, env) {
  const lower = text.toLowerCase().trim();

  // Greetings
  if (/^(hi|hello|hey|yo|sup|good)/i.test(lower)) {
    return "Yo. What do you need? I've got correct scores, overs, BTTS — all model-driven. What are you feeling today?";
  }

  // Thanks
  if (/thank|appreciate/i.test(lower)) {
    return "Anytime. Hit me up when you want more picks.";
  }

  // Correct scores
  if (/correct.?score/i.test(lower)) {
    return await getCorrectScores();
  }

  // Overs / goals
  if (/over|goals|high.?scor/i.test(lower)) {
    const lineMatch = lower.match(/(\d+\.?\d*)/);
    const line = lineMatch ? parseFloat(lineMatch[1]) : 2.5;
    return await getOvers(line);
  }

  // BTTS
  if (/btts|both.?teams|both.?score/i.test(lower)) {
    return await getBTTS();
  }

  // Build ticket / odds
  if (/(?:odds|ticket|book|build|give me)/i.test(lower)) {
    return await buildTicket(lower);
  }

  // Team vs team
  const vsMatch = text.match(/^(.{2,30}?)\s+(?:vs|versus)\s+(.{2,30}?)$/i);
  if (vsMatch) {
    return await predictMatch(vsMatch[1].trim(), vsMatch[2].trim());
  }

  // Win rate
  if (/win.?rate|accuracy|stats/i.test(lower)) {
    return "Still tracking. Need more predictions before I can give you a real number. Check back in a week or two.";
  }

  // Corners/cards/players (not available yet)
  if (/corner/i.test(lower)) return "Corners data isn't wired up yet. I'll let you know when it is.";
  if (/card/i.test(lower)) return "Cards data coming soon.";
  if (/player.*score|scorer/i.test(lower)) return "Player props need player-level data. On the roadmap.";

  // Default
  return `I do stats betting. Ask me for:\n• "correct scores" — best CS picks\n• "overs 2.5" — high-scoring games\n• "btts" — both teams to score\n• "give me 50 odds" — build a ticket\n• "Arsenal vs Chelsea" — match breakdown`;
}

// ─── Dixon-Coles Engine ────────────────────────────────────────

let _model = null;
let _cacheTime = 0;

async function getModel() {
  if (_model && Date.now() - _cacheTime < 3600000) return _model;

  let matches = [];
  const now = new Date();
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 7 ? year : year - 1;
  const season = `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`;

  for (const code of ["E0", "E1"]) {
    try {
      const url = `https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`;
      const resp = await fetch(url, { headers: { "User-Agent": "overline/4.0" } });
      if (resp.ok) {
        const csv = await resp.text();
        matches = [...matches, ...parseCSV(csv)];
      }
    } catch (e) { /* keep going */ }
  }

  // Previous season fallback
  if (matches.length < 50) {
    const prevSeason = `${String(startYear - 1).slice(2)}${String(startYear).slice(2)}`;
    for (const code of ["E0", "E1"]) {
      try {
        const url = `https://www.football-data.co.uk/mmz4281/${prevSeason}/${code}.csv`;
        const resp = await fetch(url, { headers: { "User-Agent": "overline/4.0" } });
        if (resp.ok) {
          const csv = await resp.text();
          matches = [...parseCSV(csv), ...matches];
        }
      } catch (e) { /* keep going */ }
    }
  }

  _model = fitDixonColes(matches);
  _cacheTime = Date.now();
  return _model;
}

function poisPmf(k, lambda) {
  if (k < 0 || lambda <= 0) return 0;
  let logPmf = -lambda + k * Math.log(lambda);
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(logPmf - logFact);
}

function scoreMatrix(lh, la) {
  const grid = [];
  let total = 0;
  for (let h = 0; h <= 8; h++) {
    grid[h] = [];
    for (let a = 0; a <= 8; a++) {
      grid[h][a] = poisPmf(h, lh) * poisPmf(a, la);
      total += grid[h][a];
    }
  }
  for (let h = 0; h <= 8; h++)
    for (let a = 0; a <= 8; a++)
      grid[h][a] /= total;
  return grid;
}

function teamPair(model, home, away) {
  const hp = model.teams[home], ap = model.teams[away];
  return {
    lh: Math.max(0.2, hp.attack * ap.defence * model.homeAdvantage * model.leagueMeanHomeGoals / 1.35),
    la: Math.max(0.2, ap.attack * hp.defence * model.leagueMeanAwayGoals / 1.35),
  };
}

function fuzzy(model, name) {
  const lower = name.toLowerCase();
  for (const team of Object.keys(model.teams)) {
    if (team.toLowerCase() === lower) return team;
    const tl = team.toLowerCase();
    if (tl.length >= 4 && (tl.includes(lower) || lower.includes(tl))) return team;
  }
  return null;
}

function topMatchups(model, count = 8) {
  const sorted = Object.entries(model.teams)
    .map(([name, p]) => ({ name, str: p.attack / p.defence }))
    .sort((a, b) => b.str - a.str);

  const pairs = [];
  const used = new Set();

  for (const s of sorted.slice(0, count)) {
    for (const w of [...sorted].reverse()) {
      if (used.has(s.name) || used.has(w.name) || s.name === w.name) continue;
      pairs.push({ strong: s.name, weak: w.name });
      used.add(s.name);
      used.add(w.name);
      break;
    }
    if (pairs.length >= count) break;
  }
  return pairs;
}

// ─── Feature responses ────────────────────────────────────────

async function getCorrectScores() {
  const model = await getModel();
  const pairs = topMatchups(model, 5);

  let msg = "🎯 Best correct score picks:\n\n";
  let found = false;

  for (const pair of pairs) {
    try {
      const tp = teamPair(model, pair.strong, pair.weak);
      const grid = scoreMatrix(tp.lh, tp.la);

      let best = { score: "", prob: 0 };
      for (let h = 0; h <= 5; h++)
        for (let a = 0; a <= 5; a++)
          if (grid[h][a] > best.prob)
            best = { score: `${h}-${a}`, prob: grid[h][a] };

      if (best.prob > 0.08) {
        const odds = Math.max(4, Math.round(1 / best.prob * 0.85));
        msg += `${pair.strong} vs ${pair.weak}\n`;
        msg += `  ${best.score} @ ${odds.toFixed(2)} (${(best.prob * 100).toFixed(0)}%)\n\n`;
        found = true;
      }
    } catch (e) { /* skip */ }
  }

  if (!found) msg += "No strong CS picks right now. Check back later.";
  return msg;
}

async function getOvers(line) {
  const model = await getModel();
  const teams = Object.entries(model.teams)
    .map(([n, p]) => ({ n, att: p.attack }))
    .sort((a, b) => b.att - a.att);

  let msg = `⚽ Over ${line} picks:\n\n`;
  let found = false;

  for (let i = 0; i < Math.min(6, teams.length - 1); i += 2) {
    try {
      const tp = teamPair(model, teams[i].n, teams[i + 1].n);
      const grid = scoreMatrix(tp.lh, tp.la);

      let overP = 0;
      for (let h = 0; h <= 8; h++)
        for (let a = 0; a <= 8; a++)
          if (h + a > line) overP += grid[h][a];

      if (overP > 0.30) {
        const odds = Math.max(1.5, Math.round(1 / overProb * 0.92 * 100) / 100);
        msg += `${teams[i].n} vs ${teams[i + 1].n}\n`;
        msg += `  Over ${line} @ ${odds.toFixed(2)} (${Math.round(overP * 100)}%)\n`;
        msg += `  xG: ${(tp.lh + tp.la).toFixed(1)}\n\n`;
        found = true;
      }
    } catch (e) { /* skip */ }
  }

  if (!found) msg += "Nothing strong right now.";
  return msg;
}

async function getBTTS() {
  const model = await getModel();
  const teams = Object.entries(model.teams)
    .map(([n, p]) => ({ n, c: p.attack + (2 - p.defence) }))
    .sort((a, b) => b.c - a.c);

  let msg = "🥅 BTTS picks:\n\n";
  let found = false;

  for (let i = 0; i < Math.min(6, teams.length - 1); i += 2) {
    try {
      const tp = teamPair(model, teams[i].n, teams[i + 1].n);
      const grid = scoreMatrix(tp.lh, tp.la);

      let bttsP = 0;
      for (let h = 1; h <= 8; h++)
        for (let a = 1; a <= 8; a++)
          bttsP += grid[h][a];

      if (bttsP > 0.45) {
        const odds = Math.max(1.5, Math.round(1 / bttsP * 0.90 * 100) / 100);
        msg += `${teams[i].n} vs ${teams[i + 1].n}\n`;
        msg += `  @ ${odds.toFixed(2)} (${Math.round(bttsP * 100)}%)\n\n`;
        found = true;
      }
    } catch (e) { /* skip */ }
  }

  if (!found) msg += "No strong BTTS picks right now.";
  return msg;
}

async function buildTicket(lower) {
  const model = await getModel();

  let target = null;
  const mMatch = lower.match(/(\d+)\s*m(?:illion)?/);
  const numMatch = lower.match(/\b(\d{2,7})\b/);
  if (mMatch) target = parseInt(mMatch[1]) * 1000000;
  else if (numMatch) target = parseInt(numMatch[1]);

  const pairs = topMatchups(model, 10);
  const picks = [];

  for (const pair of pairs) {
    try {
      const tp = teamPair(model, pair.strong, pair.weak);
      const grid = scoreMatrix(tp.lh, tp.la);

      // Best correct score
      let cs = { s: "", p: 0 };
      for (let h = 0; h <= 5; h++)
        for (let a = 0; a <= 5; a++)
          if (grid[h][a] > cs.p) cs = { s: `${h}-${a}`, p: grid[h][a] };

      if (cs.p > 0.07) {
        picks.push({
          match: `${pair.strong} vs ${pair.weak}`,
          market: `CS ${cs.s}`,
          prob: cs.p,
          odds: Math.max(4, Math.round(1 / cs.p * 0.85)),
        });
      }

      // Over 3.5
      let o35 = 0;
      for (let h = 0; h <= 8; h++)
        for (let a = 0; a <= 8; a++)
          if (h + a > 3.5) o35 += grid[h][a];
      if (o35 > 0.15) {
        picks.push({
          match: `${pair.strong} vs ${pair.weak}`,
          market: "O3.5",
          prob: o35,
          odds: Math.max(2.5, Math.round(1 / o35 * 0.90 * 100) / 100),
        });
      }
    } catch (e) { /* skip */ }
  }

  // Sort by value
  picks.sort((a, b) => (b.odds * b.prob) - (a.odds * a.prob));

  // Build ticket
  const ticket = [];
  let total = 1, joint = 1;

  for (const pick of picks) {
    if (ticket.some(t => t.match === pick.match)) continue;
    ticket.push(pick);
    total *= pick.odds;
    joint *= pick.prob;
    if (target && total >= target) break;
    if (!target && ticket.length >= 4) break;
  }

  total = Math.round(total * 100) / 100;

  let msg = `🎫 Ticket\n`;
  msg += `${total.toLocaleString()}x — ${(joint * 100).toFixed(2)}% win chance\n`;
  msg += `${ticket.length} legs\n\n`;

  ticket.forEach((t, i) => {
    msg += `${i + 1}. ${t.match}\n`;
    msg += `   ${t.market} @ ${t.odds.toFixed(2)} (${Math.round(t.prob * 100)}%)\n`;
  });

  return msg;
}

async function predictMatch(homeInput, awayInput) {
  const model = await getModel();
  const home = fuzzy(model, homeInput);
  const away = fuzzy(model, awayInput);

  if (!home || !away) {
    return `Can't find those teams. Try Premier League or Championship teams.`;
  }

  const tp = teamPair(model, home, away);
  const grid = scoreMatrix(tp.lh, tp.la);

  let hw = 0, d = 0, aw = 0;
  for (let h = 0; h <= 8; h++)
    for (let a = 0; a <= 8; a++) {
      if (h > a) hw += grid[h][a];
      else if (h === a) d += grid[h][a];
      else aw += grid[h][a];
    }

  // Top scores
  const scores = [];
  for (let h = 0; h <= 5; h++)
    for (let a = 0; a <= 5; a++)
      scores.push({ s: `${h}-${a}`, p: grid[h][a] });
  scores.sort((a, b) => b.p - a.p);

  const favourite = hw > d && hw > aw ? home : aw > d ? away : "neither team";
  const confidence = Math.max(hw, d, aw) > 0.55 ? "pretty confident" : "it's tight";

  let msg = `${home} vs ${away}\n\n`;
  msg += `Model gives ${home} ${(hw * 100).toFixed(0)}%, draw ${(d * 100).toFixed(0)}%, ${away} ${(aw * 100).toFixed(0)}%.\n\n`;

  if (favourite !== "neither team") {
    msg += `I'm leaning ${favourite} — ${confidence} on that.\n\n`;
  }

  msg += `Most likely scores:\n`;
  scores.slice(0, 3).forEach(s => {
    msg += `  ${s.s} at ${(s.p * 100).toFixed(1)}% (fair odds ~${Math.round(1 / s.p * 0.85)})\n`;
  });

  return msg;
}
