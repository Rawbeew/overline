// engines/dixon-coles.js
// Dixon-Coles football prediction engine.
// All probabilities come from here. The LLM never invents numbers.
// Ported from penaltyblog (Python) — same math, TypeScript implementation.

/**
 * Poisson PMF for goals k with expected goals lambda
 */
function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  let logPmf = -lambda + k * Math.log(lambda);
  // log factorial(k)
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(logPmf - logFact);
}

/**
 * Dixon-Coles tau correction for low-scoring dependence (0-0, 1-0, 0-1, 1-1)
 */
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

/**
 * Build a score probability grid for home vs away team.
 *
 * @param {number} attackHome  - home team's attack strength
 * @param {number} defenceHome - home team's defence strength
 * @param {number} attackAway  - away team's attack strength
 * @param {number} defenceAway - away team's defence strength
 * @param {number} homeAdvantage - typical home advantage multiplier (~1.2)
 * @param {number} leagueMeanGoals - average total goals in the league (~2.7)
 * @param {number} rho - Dixon-Coles rho correction (-0.1 to 0.1, default -0.05)
 * @param {number} maxGoals - maximum goals per side in the grid (default 10)
 * @returns {{ grid: number[][], homeWin: number, draw: number, awayWin: number,
 *             bttsYes: number, over15: number, over25: number, over35: number,
 *             xgHome: number, xgAway: number }}
 */
export function dixonColes(
  attackHome,
  defenceHome,
  attackAway,
  defenceAway,
  homeAdvantage = 1.2,
  leagueMeanGoals = 2.7,
  rho = -0.05,
  maxGoals = 10
) {
  const lambdaHome = (attackHome * defenceAway * homeAdvantage * leagueMeanGoals) / 2;
  const lambdaAway = (attackAway * defenceHome * leagueMeanGoals) / 2;

  // Build score grid with DC correction
  const grid = [];
  let totalProb = 0;

  for (let hg = 0; hg <= maxGoals; hg++) {
    grid[hg] = [];
    for (let ag = 0; ag <= maxGoals; ag++) {
      let p =
        poissonPmf(hg, lambdaHome) *
        poissonPmf(ag, lambdaAway) *
        dcTau(hg, ag, lambdaHome, lambdaAway, rho);

      // Clamp negatives from DC correction
      if (p < 0) p = 0;
      grid[hg][ag] = p;
      totalProb += p;
    }
  }

  // Normalise so the truncated grid sums to 1
  for (let hg = 0; hg <= maxGoals; hg++)
    for (let ag = 0; ag <= maxGoals; ag++)
      grid[hg][ag] /= totalProb;

  // Aggregate markets
  let homeWin = 0,
    draw = 0,
    awayWin = 0,
    bttsYes = 0,
    over15 = 0,
    over25 = 0,
    over35 = 0;

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

  // Expected goals
  const xgHome = grid.reduce(
    (sum, row, hg) => sum + hg * row.reduce((a, b) => a + b, 0), 0
  );
  const xgAway = grid.reduce(
    (sum, row, ag) => sum + ag * row.reduce((a, b) => a + b, 0), 0
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
    lambdaAway,
  };
}

/**
 * Accumulator: multiply model probabilities across independent matches.
 * Applies a correlation haircut for same-league selections.
 *
 * @param {Array<{model_p: number, sameLeague: boolean}>} selections
 * @param {number} haircut - decimal haircut per same-league pair (default 0.02)
 * @returns {{ jointP: number, naiveJointP: number }}
 */
export function accumulatorProbability(selections, haircut = 0.02) {
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
