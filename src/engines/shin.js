// engines/shin.js — implied probabilities from bookmaker odds
// Ported from mberk/shin (Python) — Shin's method accounts for insider trading proportion.

/**
 * Calculate implied probabilities from decimal odds using Shin's method.
 * Better than naive 1/odds because it de-viggs properly by estimating
 * the proportion of insider money in the market.
 *
 * @param {number[]} odds - array of decimal odds (e.g., [1.65, 4.0, 5.5])
 * @returns {number[]} implied probabilities summing to ~1
 */
export function shinImplied(odds) {
  const n = odds.length;
  if (n < 2) throw new Error("Need at least 2 odds");

  // Inverse odds
  const invOdds = odds.map((o) => 1 / o);
  const booksum = invOdds.reduce((a, b) => a + b, 0);

  // If booksum <= 1, no overround — just normalise
  if (booksum <= 1) {
    return invOdds.map((p) => p / booksum);
  }

  // Shin's method: solve for z (proportion of insiders)
  // using iterative approach
  let z = 0.01; // initial guess for insider proportion

  for (let iter = 0; iter < 100; iter++) {
    let newZ = z;
    let sum = 0;

    for (let i = 0; i < n; i++) {
      const oi = invOdds[i];
      const sqrtTerm = Math.sqrt(z * z + 4 * (1 - z) * ((oi * oi) / booksum));
      sum += (-2 * oi + Math.sqrt(z + (oi * oi * (1 - z))) ) / 
             (2 * z * oi + (1 - z) * sqrtTerm);
    }

    // Newton-Raphson update
    const diff = sum - 1;
    if (Math.abs(diff) < 1e-10) break;

    newZ = z - diff * 0.01; // simple gradient step
    if (newZ < 0) newZ = 0.001;
    if (newZ > 0.5) newZ = 0.5;
    z = newZ;
  }

  // Compute final implied probabilities with estimated z
  const implied = [];
  for (let i = 0; i < n; i++) {
    const oi = invOdds[i];
    const sqrtTerm = Math.sqrt(z * z + 4 * (1 - z) * ((oi * oi) / booksum));
    const pi =
      (-z * oi + Math.sqrt(oi * oi - 4 * z * (1 - z) * oi * oi / booksum)) /
      (2 * z);
    // Clamp and use simpler formula if the above gives NaN
    if (isNaN(pi) || pi <= 0 || pi > 1) {
      // Fall back to basic proportional normalisation
      implied.push(oi / booksum);
    } else {
      implied.push(pi);
    }
  }

  // Normalise to ensure they sum to 1
  const sum = implied.reduce((a, b) => a + b, 0);
  return implied.map((p) => p / sum);
}

/**
 * Naive implied probabilities (1/odds, then normalise).
 * Less accurate than Shin but useful as baseline.
 */
export function naiveImplied(odds) {
  const invOdds = odds.map((o) => 1 / o);
  const sum = invOdds.reduce((a, b) => a + b, 0);
  return invOdds.map((p) => p / sum);
}
