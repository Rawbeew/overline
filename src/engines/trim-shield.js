// engines/trim.js — trim a ticket to target odds by removing riskiest legs
// Shield — insurance math for 3+ leg tickets

/**
 * Trim an accumulator to a target total odds.
 * Removes the lowest-confidence (highest odds = riskiest) selections
 * until the remaining product of odds is <= target.
 *
 * @param {Array<{model_p: number, odds: number, label: string}>} selections
 * @param {number} targetOdds - maximum desired total odds
 * @returns {{ kept: Array, removed: Array, newTotalOdds: number, jointP: number }}
 */
export function trimToTarget(selections, targetOdds) {
  // Sort by confidence descending (lowest odds first = safest)
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

/**
 * Split an accumulator into N smaller tickets with roughly equal selections.
 *
 * @param {Array} selections - full ticket selections
 * @param {number} parts - number of tickets to split into
 * @returns {Array<Array>} array of tickets
 */
export function splitTicket(selections, parts) {
  if (!selections.length || parts < 1) return [selections];

  const perPart = Math.ceil(selections.length / parts);
  const tickets = [];

  for (let i = 0; i < parts; i++) {
    const start = i * perPart;
    const chunk = selections.slice(start, start + perPart);
    if (chunk.length > 0) tickets.push(chunk);
  }

  return tickets;
}

/**
 * Shield: calculate what happens if N-1 out of N legs hit.
 * Returns the payout for each partial-hit scenario.
 *
 * @param {Array<{odds: number, model_p: number}>} selections
 * @param {number} stake - amount wagered
 * @returns {Object} shield analysis
 */
export function shield(selections, stake) {
  const n = selections.length;
  if (n < 3) return { error: "Shield needs 3+ legs" };

  const scenarios = {};

  for (let misses = 0; misses < n; misses++) {
    const hits = n - misses;
    let payout = 0;
    let prob = 0;

    if (misses === 0) {
      // All hit — full accumulator payout
      payout = selections.reduce((acc, s) => acc * s.odds, 1) * stake;
    } else if (misses === 1) {
      // One miss — best sub-parlay wins
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
    // For 2+ misses, standard acca pays 0

    // Probability of exactly `misses` failures
    for (let skipCombo = 0; skipCombo < combinations(n, misses); skipCombo++) {
      let p = 1;
      // This is simplified — real combinatorics would enumerate properly
      for (let j = 0; j < n; j++) {
        if ((skipCombo >> j) & 1) p *= 1 - selections[j].model_p;
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
    scenarios,
  };
}

function combinations(n, k) {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}
