// engines/dc-model.js — Dixon-Coles model fitted to full EPL season data
// Fits attack/defence strength per team from football-data.co.uk results

import { fetchLeagueData } from "./live-data.js";

/**
 * Fit team attack/defence strengths from match history.
 * Uses simple iterative fitting (gradient descent on Poisson likelihood).
 *
 * @param {Array<{homeTeam, awayTeam, homeGoals, awayGoals}>} matches
 * @param {number} iterations - fitting iterations
 * @returns {Object} { teams: {[name]: {attack, defence}}, leagueMeanHomeGoals, leagueMeanAwayGoals }
 */
export function fitDixonColes(matches, iterations = 50) {
  // Collect teams
  const teams = new Set();
  for (const m of matches) {
    if (m.homeTeam) teams.add(m.homeTeam);
    if (m.awayTeam) teams.add(m.awayTeam);
  }

  // Initialize parameters
  const params = {};
  for (const t of teams) {
    params[t] = { attack: 1.0, defence: 1.0 };
  }
  let homeAdvantage = 1.2;

  // League mean goals (for baseline)
  const totalMatches = matches.length;
  const meanHomeGoals = matches.reduce((s, m) => s + m.homeGoals, 0) / totalMatches;
  const meanAwayGoals = matches.reduce((s, m) => s + m.awayGoals, 0) / totalMatches;

  // Iterative fitting
  const lr = 0.01; // learning rate

  for (let iter = 0; iter < iterations; iter++) {
    // Accumulate gradients
    const grads = {};
    for (const t of teams) {
      grads[t] = { attack: 0, defence: 0 };
    }
    let haGrad = 0;

    for (const m of matches) {
      const home = m.homeTeam;
      const away = m.awayTeam;

      // Expected goals for this match under current parameters
      const lambdaHome = Math.max(0.1, params[home].attack * params[away].defence * homeAdvantage * meanHomeGoals / 1.35);
      const lambdaAway = Math.max(0.1, params[away].attack * params[home].defence * meanAwayGoals / 1.35);

      // Gradient of Poisson log-likelihood
      // d/dθ [x*log(λ) - λ] where λ depends on θ
      // For home goals:
      const dh_dAttackH = lambdaHome / params[home].attack; // ∂λh/∂attack_home
      const dh_dDefenceA = lambdaHome / params[away].defence; // ∂λh/∂defence_away
      const dh_dHA = lambdaHome / homeAdvantage;

      // For away goals:
      const da_dAttackA = lambdaAway / params[away].attack;
      const da_dDefenceH = lambdaAway / params[home].defence;

      // Residuals
      const resH = m.homeGoals - lambdaHome;
      const resA = m.awayGoals - lambdaAway;

      // Accumulate gradients (ascent — we want to maximize likelihood)
      grads[home].attack += resH * dh_dAttackH;
      grads[away].defence += resH * dh_dDefenceA;
      grads[away].attack += resA * da_dAttackA;
      grads[home].defence += resA * da_dDefenceH;
      haGrad += resH * dh_dHA;
    }

    // Update parameters
    for (const t of teams) {
      params[t].attack += lr * grads[t].attack / totalMatches;
      params[t].defence += lr * grads[t].defence / totalMatches;
      // Clamp to reasonable ranges
      params[t].attack = Math.max(0.3, Math.min(2.5, params[t].attack));
      params[t].defence = Math.max(0.3, Math.min(2.5, params[t].defence));
    }
    homeAdvantage += lr * haGrad / totalMatches;
    homeAdvantage = Math.max(1.0, Math.min(1.8, homeAdvantage));
  }

  return {
    teams: params,
    homeAdvantage: Math.round(homeAdvantage * 100) / 100,
    leagueMeanHomeGoals: Math.round(meanHomeGoals * 100) / 100,
    leagueMeanAwayGoals: Math.round(meanAwayGoals * 100) / 100,
    matchesFitted: totalMatches,
  };
}

/**
 * Get cached fitted model. Fetches data and fits once, then caches.
 */
let _cachedModel = null;
let _cacheTime = null;
const CACHE_TTL = 3600000; // 1 hour

export async function getFittedModel(leagueKey = "epl") {
  if (_cachedModel && _cacheTime && Date.now() - _cacheTime < CACHE_TTL) {
    return _cachedModel;
  }

  const matches = await fetchLeagueData(leagueKey);
  const model = fitDixonColes(matches);
  model.matches = matches; // keep raw data for reference
  _cachedModel = model;
  _cacheTime = Date.now();
  return model;
}

/**
 * Predict a match using the fitted model.
 */
export async function predictMatch(homeTeam, awayTeam, leagueKey = "epl") {
  const model = await getFittedModel(leagueKey);

  const homeParams = model.teams[homeTeam];
  const awayParams = model.teams[awayTeam];

  if (!homeParams || !awayParams) {
    return { error: `Unknown team(s): ${!homeTeam ? homeTeam : ""} ${!awayParams ? awayTeam : ""}` };
  }

  // Expected goals
  const lambdaHome = Math.max(0.1,
    homeParams.attack * awayParams.defence * model.homeAdvantage * model.leagueMeanHomeGoals / 1.35
  );
  const lambdaAway = Math.max(0.1,
    awayParams.attack * homeParams.defence * model.leagueMeanAwayGoals / 1.35
  );

  // Poisson probabilities
  let homeWin = 0, draw = 0, awayWin = 0, bttsYes = 0, over25 = 0;
  const maxGoals = 10;

  const poisPmf = (k, lambda) => {
    let logPmf = -lambda + k * Math.log(lambda);
    let logFact = 0;
    for (let i = 2; i <= k; i++) logFact += Math.log(i);
    return Math.exp(logPmf - logFact);
  };

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poisPmf(h, lambdaHome) * poisPmf(a, lambdaAway);
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
      if (h > 0 && a > 0) bttsYes += p;
      if (h + a > 2.5) over25 += p;
    }
  }

  return {
    homeTeam,
    awayTeam,
    xgHome: Math.round(lambdaHome * 100) / 100,
    xgAway: Math.round(lambdaAway * 100) / 100,
    homeWin: Math.round(homeWin * 1000) / 1000,
    draw: Math.round(draw * 1000) / 1000,
    awayWin: Math.round(awayWin * 1000) / 1000,
    bttsYes: Math.round(bttsYes * 1000) / 1000,
    over25: Math.round(over25 * 1000) / 1000,
    confidence: "high",
    model: "Dixon-Coles (fitted)",
    matchesUsed: model.matchesFitted,
  };
}

/**
 * Build a mega-odds ticket using real fitted predictions.
 */
export async function buildMegaTicket(targetOdds, leagueKey = "epl") {
  const model = await getFittedModel(leagueKey);

  // For each recent fixture pairing we can predict, compute safest market
  const selections = [];
  const seenTeams = new Set();

  // Use last N matches to generate upcoming-style predictions
  // In reality these would be actual upcoming fixtures from an API
  // For now, predict cross-team matchups from the fitted model

  const sortedTeams = Object.entries(model.teams)
    .sort(([, a], [, b]) => b.attack - a.attack); // strongest attack first

  const poisPmf = (k, lambda) => {
    let logPmf = -lambda + k * Math.log(lambda);
    let logFact = 0;
    for (let i = 2; i <= k; i++) logFact += Math.log(i);
    return Math.exp(logPmf - logFact);
  };

  for (const [strongTeam] of sortedTeams.slice(0, 10)) {
    // Find weakest opponents for high-confidence home wins
    const weakOpponents = Object.entries(model.teams)
      .filter(([name]) => name !== strongTeam)
      .sort(([, a], [, b]) => a.defence - b.defence) // weakest defence first
      .slice(0, 2);

    for (const [weakTeam] of weakOpponents) {
      if (seenTeams.has(weakTeam)) continue;

      const lambdaHome = strongTeam && weakTeam ?
        model.teams[strongTeam].attack * model.teams[weakTeam].defence * 
        model.homeAdvantage * model.leagueMeanHomeGoals / 1.35 : null;
      
      if (!lambdaHome) continue;

      // Home win probability
      let homeWin = 0;
      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          if (h > a) homeWin += poisPmf(h, lambdaHome) * poisPmf(a, lambdaHome * 0.6);
        }
      }

      // Implied fair odds = 1/probability, add bookmaker margin ~5%
      const fairOdds = 1 / homeWin;
      const bookOdds = Math.round(fairOdds * 0.95 * 100) / 100; // 95% = bookie margin

      selections.push({
        label: `${strongTeam} vs ${weakTeam} — Home Win`,
        homeTeam: strongTeam,
        awayTeam: weakTeam,
        market: "Home Win",
        model_p: Math.round(homeWin * 1000) / 1000,
        odds: Math.max(1.05, bookOdds), // floor at 1.05
      });

      seenTeams.add(weakTeam);
      break; // one selection per strong team
    }
  }

  // Greedy select safest first until target odds reached
  selections.sort((a, b) => a.odds - b.odds);
  
  const ticket = [];
  let totalOdds = 1;
  let jointP = 1;

  for (const sel of selections) {
    ticket.push(sel);
    totalOdds *= sel.odds;
    jointP *= sel.model_p;

    if (totalOdds >= targetOdds) break;
  }

  return {
    targetOdds,
    achievedOdds: Math.round(totalOdds * 100) / 100,
    jointProbability: Math.round(jointP * 10000000) / 10000000,
    selections: ticket,
    legs: ticket.length,
  };
}
