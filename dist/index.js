var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/engines/dixon-coles.js
function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  let logPmf = -lambda + k * Math.log(lambda);
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(logPmf - logFact);
}
__name(poissonPmf, "poissonPmf");
function dcTau(homeGoals, awayGoals, lambdaHome, lambdaAway, rho) {
  if (homeGoals === 0 && awayGoals === 0)
    return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1)
    return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0)
    return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1)
    return 1 - rho;
  return 1;
}
__name(dcTau, "dcTau");
function dixonColes(attackHome, defenceHome, attackAway, defenceAway, homeAdvantage = 1.2, leagueMeanGoals = 2.7, rho = -0.05, maxGoals = 10) {
  const lambdaHome = attackHome * defenceAway * homeAdvantage * leagueMeanGoals / 2;
  const lambdaAway = attackAway * defenceHome * leagueMeanGoals / 2;
  const grid = [];
  let totalProb = 0;
  for (let hg = 0; hg <= maxGoals; hg++) {
    grid[hg] = [];
    for (let ag = 0; ag <= maxGoals; ag++) {
      let p = poissonPmf(hg, lambdaHome) * poissonPmf(ag, lambdaAway) * dcTau(hg, ag, lambdaHome, lambdaAway, rho);
      if (p < 0) p = 0;
      grid[hg][ag] = p;
      totalProb += p;
    }
  }
  for (let hg = 0; hg <= maxGoals; hg++)
    for (let ag = 0; ag <= maxGoals; ag++)
      grid[hg][ag] /= totalProb;
  let homeWin = 0, draw = 0, awayWin = 0, bttsYes = 0, over15 = 0, over25 = 0, over35 = 0;
  for (let hg = 0; hg <= maxGoals; hg++) {
    for (let ag = 0; ag <= maxGoals; ag++) {
      const p = grid[hg][ag];
      const total = hg + ag;
      if (hg > ag) homeWin += p;
      else if (hg === ag) draw += p;
      else awayWin += p;
      if (hg > 0 && ag > 0) bttsYes += p;
      if (total > 1.5) over15 += p;
      if (total > 2.5) over25 += p;
      if (total > 3.5) over35 += p;
    }
  }
  const xgHome = grid.reduce(
    (sum, row, hg) => sum + hg * row.reduce((a, b) => a + b, 0),
    0
  );
  const xgAway = grid.reduce(
    (sum, row, ag) => sum + ag * row.reduce((a, b) => a + b, 0),
    0
  );
  return {
    grid,
    homeWin,
    draw,
    awayWin,
    bttsYes,
    over15,
    over25,
    over35,
    xgHome: Math.round(xgHome * 100) / 100,
    xgAway: Math.round(xgAway * 100) / 100,
    lambdaHome,
    lambdaAway
  };
}
__name(dixonColes, "dixonColes");
function accumulatorProbability(selections, haircut = 0.02) {
  if (!selections || selections.length === 0) return { jointP: 0, naiveJointP: 0 };
  let naive = selections[0].model_p;
  let adjusted = selections[0].model_p;
  for (let i = 1; i < selections.length; i++) {
    naive *= selections[i].model_p;
    adjusted *= selections[i].model_p;
    if (selections[i].sameLeague && selections[i - 1].sameLeague) {
      adjusted -= adjusted * haircut;
    }
  }
  return { jointP: adjusted, naiveJointP: naive };
}
__name(accumulatorProbability, "accumulatorProbability");

// src/engines/shin.js
function shinImplied(odds) {
  const n = odds.length;
  if (n < 2) throw new Error("Need at least 2 odds");
  const invOdds = odds.map((o) => 1 / o);
  const booksum = invOdds.reduce((a, b) => a + b, 0);
  if (booksum <= 1) {
    return invOdds.map((p) => p / booksum);
  }
  let z = 0.01;
  for (let iter = 0; iter < 100; iter++) {
    let newZ = z;
    let sum2 = 0;
    for (let i = 0; i < n; i++) {
      const oi = invOdds[i];
      const sqrtTerm = Math.sqrt(z * z + 4 * (1 - z) * (oi * oi / booksum));
      sum2 += (-2 * oi + Math.sqrt(z + oi * oi * (1 - z))) / (2 * z * oi + (1 - z) * sqrtTerm);
    }
    const diff = sum2 - 1;
    if (Math.abs(diff) < 1e-10) break;
    newZ = z - diff * 0.01;
    if (newZ < 0) newZ = 1e-3;
    if (newZ > 0.5) newZ = 0.5;
    z = newZ;
  }
  const implied = [];
  for (let i = 0; i < n; i++) {
    const oi = invOdds[i];
    const sqrtTerm = Math.sqrt(z * z + 4 * (1 - z) * (oi * oi / booksum));
    const pi = (-z * oi + Math.sqrt(oi * oi - 4 * z * (1 - z) * oi * oi / booksum)) / (2 * z);
    if (isNaN(pi) || pi <= 0 || pi > 1) {
      implied.push(oi / booksum);
    } else {
      implied.push(pi);
    }
  }
  const sum = implied.reduce((a, b) => a + b, 0);
  return implied.map((p) => p / sum);
}
__name(shinImplied, "shinImplied");

// src/engines/trim-shield.js
function trimToTarget(selections, targetOdds) {
  const sorted = [...selections].sort((a, b) => a.odds - b.odds);
  const kept = [];
  const removed = [];
  let totalOdds = 1;
  let jointP = 1;
  for (const sel of sorted) {
    const potentialOdds = totalOdds * sel.odds;
    if (potentialOdds <= targetOdds || kept.length === 0) {
      kept.push(sel);
      totalOdds *= sel.odds;
      jointP *= sel.model_p;
    } else {
      removed.push(sel);
    }
  }
  return { kept, removed, newTotalOdds: Math.round(totalOdds * 100) / 100, jointP };
}
__name(trimToTarget, "trimToTarget");
function shield(selections, stake) {
  const n = selections.length;
  if (n < 3) return { error: "Shield needs 3+ legs" };
  const scenarios = {};
  for (let misses = 0; misses < n; misses++) {
    const hits = n - misses;
    let payout = 0;
    let prob = 0;
    if (misses === 0) {
      payout = selections.reduce((acc, s) => acc * s.odds, 1) * stake;
    } else if (misses === 1) {
      let bestPayout = 0;
      for (let skip = 0; skip < n; skip++) {
        let subOdds = 1;
        for (let j = 0; j < n; j++) {
          if (j !== skip) subOdds *= selections[j].odds;
        }
        bestPayout = Math.max(bestPayout, subOdds * stake);
      }
      payout = bestPayout;
    }
    for (let skipCombo = 0; skipCombo < combinations(n, misses); skipCombo++) {
      let p = 1;
      for (let j = 0; j < n; j++) {
        if (skipCombo >> j & 1) p *= 1 - selections[j].model_p;
        else p *= selections[j].model_p;
      }
      prob += p;
    }
    scenarios[`${n - hits}miss_${hits}hit`] = { payout: Math.round(payout * 100) / 100 };
  }
  return {
    legs: n,
    stake,
    totalOdds: Math.round(selections.reduce((a, s) => a * s.odds, 1) * 100) / 100,
    scenarios
  };
}
__name(shield, "shield");
function combinations(n, k) {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) result = result * (n - i) / (i + 1);
  return Math.round(result);
}
__name(combinations, "combinations");

// src/index.js
var index_default = {
  async fetch(request, env2) {
    const url = new URL(request.url);
    console.log(`[overline] ${request.method} ${url.pathname}`);
    if (url.pathname === "/api/telegram" && request.method === "POST") {
      try {
        const update = await request.json();
        console.log("[overline] update received:", JSON.stringify(update).slice(0, 500));
        if (!env2.OVERLINE_BOT_TOKEN) {
          console.error("[overline] OVERLINE_BOT_TOKEN is undefined!");
          return new Response("TOKEN MISSING", { status: 500 });
        }
        await handleUpdate(update, env2);
        return new Response("OK");
      } catch (err) {
        console.error("[overline] handler error:", err.message, err.stack);
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }
    if (url.pathname === "/debug") {
      return Response.json({
        hasToken: !!env2.OVERLINE_BOT_TOKEN,
        tokenPrefix: env2.OVERLINE_BOT_TOKEN ? env2.OVERLINE_BOT_TOKEN.slice(0, 10) : "NONE",
        pathname: url.pathname
      });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, bot: "overline", version: "0.1.0" });
    }
    return new Response("Overline \u2014 model P vs the book.", { status: 200 });
  }
};
async function sendMessage(chatId, text, env2, replyMarkup = null) {
  const token = env2.OVERLINE_BOT_TOKEN;
  const body = { chat_id: String(chatId), text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const payload = JSON.stringify(body);
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "overline/0.1.0"
      },
      body: new TextEncoder().encode(payload)
    });
    const result = await resp.json();
    if (!result.ok) {
      console.error("[overline] sendMessage failed:", JSON.stringify(result));
      if (result.error_code === 400) {
        delete body.parse_mode;
        const retryResp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: new TextEncoder().encode(JSON.stringify(body))
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
__name(sendMessage, "sendMessage");
async function sendTyping(chatId) {
  const token = env.OVERLINE_BOT_TOKEN;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: new TextEncoder().encode(JSON.stringify({ chat_id: String(chatId), action: "typing" }))
    });
  } catch (err) {
    console.error("[overline] typing error:", err.message);
  }
}
__name(sendTyping, "sendTyping");
async function handleUpdate(update, env2) {
  if (!update.message) return;
  const chatId = update.message.chat.id;
  const text = update.message.text || "";
  try {
    await sendTyping(chatId);
    if (text.startsWith("/start")) {
      await cmdStart(chatId, env2);
    } else if (text.startsWith("/acca")) {
      await cmdAcca(chatId, env2);
    } else if (text.startsWith("/epl")) {
      await cmdEpl(chatId, env2);
    } else if (text.startsWith("/npfl")) {
      await cmdNpfl(chatId, env2);
    } else if (text.startsWith("/ev")) {
      await cmdEv(chatId, env2);
    } else if (text.startsWith("/trim")) {
      await cmdTrim(chatId, env2, text);
    } else if (text.startsWith("/shield")) {
      await cmdShield(chatId, env2, text);
    } else if (text.startsWith("/racing")) {
      await cmdRacing(chatId, env2);
    } else if (/give me.*odds/i.test(text)) {
      await cmdMegaOdds(chatId, env2, text);
    } else {
      await routeNaturalLanguage(chatId, text, env2);
    }
  } catch (err) {
    console.error("Error:", err);
    await sendMessage(chatId, `Error: ${err.message}`, env2);
  }
}
__name(handleUpdate, "handleUpdate");
async function cmdStart(chatId, env2) {
  await sendMessage(
    chatId,
    `<b>Overline</b> \u2014 model P versus the book.

Not a casino. Not a tipster. A pricing desk.

Commands:
/acca \u2014 build an accumulator
/epl \u2014 Premier League + predictions
/npfl \u2014 Nigerian Pro League
/ev \u2014 find +EV bets
/setka \u2014 table tennis
/racing \u2014 horse racing
/trim \u2014 trim a ticket to target odds
/shield \u2014 insurance for 3+ leg tickets

Or just say <i>"give me 1m odds"</i>

<i>Demo slate active. Live book feed not wired.</i>`,
    env2,
    inlineKeys([
      ["EPL Predictions", "/epl"],
      ["Find +EV", "/ev"],
      ["1m Odds", "give me 1000000 odds"],
      ["Shield Test", "/shield"]
    ])
  );
}
__name(cmdStart, "cmdStart");
async function cmdAcca(chatId, env2) {
  const selections = [
    { label: "Arsenal vs Chelsea \u2014 Home Win", model_p: 0.675, odds: 1.65, sameLeague: true },
    { label: "Man City vs Everton \u2014 Home Win", model_p: 0.82, odds: 1.25, sameLeague: true },
    { label: "Liverpool vs Spurs \u2014 Home Win", model_p: 0.71, odds: 1.45, sameLeague: true }
  ];
  const { jointP, naiveJointP } = accumulatorProbability(selections);
  const totalOdds = selections.reduce((a, s) => a * s.odds, 1);
  let msg = "<b>Accumulator \u2014 Demo Slate</b>\n\n";
  selections.forEach((s, i) => {
    msg += `${i + 1}. ${s.label}
`;
    msg += `   model_p: ${(s.model_p * 100).toFixed(1)}% @ ${s.odds.toFixed(2)}
`;
    msg += `   EV: ${((s.model_p * s.odds - 1) * 100).toFixed(1)}%

`;
  });
  msg += `<b>Total Odds:</b> ${totalOdds.toFixed(2)}x
`;
  msg += `<b>Joint P (haircut):</b> ${(jointP * 100).toFixed(1)}%
`;
  msg += `<b>Naive Joint P:</b> ${(naiveJointP * 100).toFixed(1)}%
`;
  msg += `
<i>Demo data \u2014 not live odds.</i>`;
  await sendMessage(chatId, msg, env2, inlineKeys([["Trim to 20x", "/trim 20"], ["Shield", "/shield"]]));
}
__name(cmdAcca, "cmdAcca");
async function cmdEpl(chatId, env2) {
  const matches = [
    { home: "Arsenal", away: "Chelsea", attH: 1.4, defH: 0.8, attA: 1, defA: 1.1 },
    { home: "Man City", away: "Everton", attH: 1.7, defH: 0.6, attA: 0.8, defA: 1.3 },
    { home: "Liverpool", away: "Spurs", attH: 1.5, defH: 0.9, attA: 1.1, defA: 1 }
  ];
  let msg = "<b>Premier League \u2014 Dixon-Coles</b>\n<i>Demo slate. Not live odds.</i>\n\n";
  for (const m of matches) {
    const pred = dixonColes(m.attH, m.defH, m.attA, m.defA);
    msg += `<b>${m.home} vs ${m.away}</b>
`;
    msg += `  Home: ${(pred.homeWin * 100).toFixed(0)}% | `;
    msg += `Draw: ${(pred.draw * 100).toFixed(0)}% | `;
    msg += `Away: ${(pred.awayWin * 100).toFixed(0)}%
`;
    msg += `  xG: ${pred.xgHome} - ${pred.xgAway} | `;
    msg += `BTTS: ${(pred.bttsYes * 100).toFixed(0)}% | `;
    msg += `O2.5: ${(pred.over25 * 100).toFixed(0)}%

`;
  }
  await sendMessage(chatId, msg, env2);
}
__name(cmdEpl, "cmdEpl");
async function cmdEv(chatId, env2) {
  const bets = [
    { match: "Arsenal vs Chelsea", market: "Home", modelP: 0.675, odds: 1.65 },
    { match: "Man City vs Everton", market: "Home", modelP: 0.82, odds: 1.25 },
    { match: "Liverpool vs Spurs", market: "Home", modelP: 0.71, odds: 1.45 },
    { match: "Brighton vs Villa", market: "BTTS Yes", modelP: 0.58, odds: 1.8 }
  ];
  let msg = "<b>+EV Scanner \u2014 Demo</b>\n<i>Model P vs Shin-implied book P</i>\n\n";
  let foundEv = false;
  for (const bet of bets) {
    const implied = shinImplied([bet.odds, 3.5]);
    const ev = bet.modelP * bet.odds - 1;
    const flag = ev > 0 ? "+EV" : "-EV";
    if (ev > 0) foundEv = true;
    msg += `${bet.match}
`;
    msg += `  ${bet.market}: model=${(bet.modelP * 100).toFixed(0)}% @ ${bet.odds}
`;
    msg += `  EV: ${flag} (${(ev * 100).toFixed(1)}%)

`;
  }
  if (!foundEv) msg += `<i>No +EV found in demo slate.</i>
`;
  await sendMessage(chatId, msg, env2);
}
__name(cmdEv, "cmdEv");
async function cmdNpfl(chatId, env2) {
  await sendMessage(
    chatId,
    "<b>Nigerian Pro League</b>\n\nNPFL data source not wired.\nThe catalogue includes NPFL but live fixtures require the soccerdata pipeline.\n\n<i>Demo slate only for now.</i>",
    env2
  );
}
__name(cmdNpfl, "cmdNpfl");
async function cmdRacing(chatId, env2) {
  await sendMessage(
    chatId,
    "<b>Horse Racing \u2014 Benter-lite</b>\n\nConditional logit model not yet fitted to live data.\nSame-race wins are exclusive \u2014 never parlayed.\n\n<i>Awaiting racing feed.</i>",
    env2
  );
}
__name(cmdRacing, "cmdRacing");
async function cmdTrim(chatId, env2, text) {
  const targetMatch = text.match(/\/trim\s+(\d+)/);
  const target = targetMatch ? parseInt(targetMatch[1]) : 20;
  const selections = [
    { label: "Arsenal Home @1.65", model_p: 0.675, odds: 1.65 },
    { label: "Man City Home @1.25", model_p: 0.82, odds: 1.25 },
    { label: "Liverpool Home @1.45", model_p: 0.71, odds: 1.45 },
    { label: "Wolves Away @2.80", model_p: 0.38, odds: 2.8 },
    { label: "Newcastle Draw @3.50", model_p: 0.31, odds: 3.5 },
    { label: "Brighton BTTS @1.80", model_p: 0.58, odds: 1.8 }
  ];
  const result = trimToTarget(selections, target);
  let msg = `<b>Trimmed to ${result.newTotalOdds}x</b>

`;
  msg += `<b>Kept (${result.kept.length}):</b>
`;
  result.kept.forEach((k, i) => {
    msg += `  ${i + 1}. ${k.label} \u2014 p=${(k.model_p * 100).toFixed(0)}%
`;
  });
  msg += `
<b>Removed (${result.removed.length}):</b>
`;
  result.removed.forEach((r) => {
    msg += `  \u2717 ${r.label} \u2014 p=${(r.model_p * 100).toFixed(0)}%
`;
  });
  msg += `
<b>New Joint P:</b> ${(result.jointP * 100).toFixed(1)}%
`;
  await sendMessage(chatId, msg, env2);
}
__name(cmdTrim, "cmdTrim");
async function cmdShield(chatId, env2, text) {
  const selections = [
    { label: "Arsenal Home @1.65", model_p: 0.675, odds: 1.65 },
    { label: "Man City Home @1.25", model_p: 0.82, odds: 1.25 },
    { label: "Liverpool Home @1.45", model_p: 0.71, odds: 1.45 }
  ];
  const stake = 100;
  const result = shield(selections, stake);
  let msg = `<b>Shield Analysis \u2014 ${result.legs} legs @ \u20A6${stake}</b>
`;
  msg += `Total Odds: ${result.totalOdds}x

`;
  for (const [scenario, data] of Object.entries(result.scenarios)) {
    msg += `  ${scenario.replace("_", " ")}: \u20A6${data.payout}
`;
  }
  msg += `
<i>If one leg misses, the best sub-parlay still pays.</i>`;
  await sendMessage(chatId, msg, env2);
}
__name(cmdShield, "cmdShield");
async function cmdMegaOdds(chatId, env2, text) {
  let target = 1e6;
  const millionMatch = text.match(/(\d+)\s*m(?:illion)?/i);
  const numberMatch = text.match(/(\d{3,})\s*(?:odds|x)/i);
  if (millionMatch) target = parseInt(millionMatch[1]) * 1e6;
  else if (numberMatch) target = parseInt(numberMatch[1]);
  const safeSelections = [
    { label: "Man City Home @1.15", model_p: 0.87, odds: 1.15, league: "EPL" },
    { label: "Real Madrid Home @1.10", model_p: 0.91, odds: 1.1, league: "La Liga" },
    { label: "Bayern Home @1.08", model_p: 0.93, odds: 1.08, league: "Bundesliga" },
    { label: "PSG Home @1.18", model_p: 0.85, odds: 1.18, league: "Ligue 1" },
    { label: "Inter Home @1.22", model_p: 0.82, odds: 1.22, league: "Serie A" },
    { label: "Barcelona Home @1.12", model_p: 0.89, odds: 1.12, league: "La Liga" },
    { label: "Arsenal Home @1.25", model_p: 0.68, odds: 1.25, league: "EPL" },
    { label: "Atletico Home @1.30", model_p: 0.77, odds: 1.3, league: "La Liga" },
    { label: "Dortmund Home @1.35", model_p: 0.74, odds: 1.35, league: "Bundesliga" },
    { label: "Juventus Home @1.40", model_p: 0.71, odds: 1.4, league: "Serie A" },
    { label: "Napoli Home @1.28", model_p: 0.78, odds: 1.28, league: "Serie A" },
    { label: "Man United Home @1.55", model_p: 0.64, odds: 1.55, league: "EPL" },
    { label: "Chelsea Home @1.60", model_p: 0.63, odds: 1.6, league: "EPL" },
    { label: "RB Leipzig Home @1.33", model_p: 0.75, odds: 1.33, league: "Bundesliga" }
  ];
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
  let msg = `<b>Mega Ticket Builder</b>
`;
  msg += `Target: ${target.toLocaleString()}x

`;
  msg += `Found ${ticket.length} high-confidence selections:

`;
  ticket.forEach((s, i) => {
    msg += `${i + 1}. ${s.label}
`;
    msg += `   conf: ${(s.model_p * 100).toFixed(0)}%
`;
  });
  msg += `
<b>Total Odds:</b> ${total.toLocaleString()}x
`;
  msg += `<b>Est. Probability:</b> ${(jointP * 100).toExponential(2)}%
`;
  msg += `<b>Games:</b> ${ticket.length}
`;
  if (jointP < 0.01) msg += `
\u26A0\uFE0F Lottery territory. Trim for better probability.`;
  await sendMessage(chatId, msg, env2, inlineKeys([
    [`Trim to 50x`, `trim to 50x`],
    [`Trim to 1000x`, `trim to 1000x`],
    [`Split into 3`, `split into 3`]
  ]));
}
__name(cmdMegaOdds, "cmdMegaOdds");
async function routeNaturalLanguage(chatId, text, env2) {
  const lower = text.toLowerCase();
  if (/convert\s+\w+\s+(from|on)\s+sportybet/i.test(lower)) {
    await sendMessage(
      chatId,
      "<b>Code Converter</b>\n\nSportyBet code conversion requires their booking API.\nCurrently running on demo slate \u2014 no live book feed.\n\n<i>Coming soon.</i>",
      env2
    );
  } else if (/predict|who will win|analysis/i.test(lower)) {
    await cmdEpl(chatId, env2);
  } else {
    await sendMessage(
      chatId,
      `I didn't understand that.

Try:
\u2022 /epl \u2014 Premier League predictions
\u2022 /acca \u2014 build an accumulator
\u2022 /ev \u2014 find +EV bets
\u2022 /trim 50 \u2014 trim to 50x

Or just say <i>"give me 1m odds"</i>`,
      env2
    );
  }
}
__name(routeNaturalLanguage, "routeNaturalLanguage");
function inlineKeys(rows) {
  return {
    inline_keyboard: rows.map(([text, callback_data]) => [
      { text, callback_data: callback_data || text }
    ])
  };
}
__name(inlineKeys, "inlineKeys");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
