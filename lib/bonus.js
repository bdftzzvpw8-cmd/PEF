'use strict';
// Weekly bonus leaderboard: splits a fixed prize pool across the top slice of
// active accounts, weighted by volume and capped per account.

const DEFAULTS = {
  pool:       3000,   // total prize pool, in dollars
  cap:         500,   // most any single account can receive
  topPct:     0.20,   // share of active accounts that are eligible
  minEligible: 10,    // hard floor: always at least this many, if available
};

// Spreads `pool` across `accounts` in proportion to volume, then applies the
// per-account cap and re-spreads the overflow among those still under it.
// Repeats until the leftover is negligible or everyone is capped.
function distribute(accounts, pool, cap) {
  const totalVolume = accounts.reduce((sum, a) => sum + a.volume, 0);
  if (totalVolume <= 0) return accounts.map(() => 0);

  const awards = accounts.map(a => Math.min((a.volume / totalVolume) * pool, cap));
  let excess = pool - awards.reduce((sum, b) => sum + b, 0);

  for (let pass = 0; pass < 20 && excess > 0.005; pass++) {
    const openIdx = awards
      .map((b, i) => (b < cap - 1e-9 ? i : -1))
      .filter(i => i >= 0);
    if (!openIdx.length) break;

    const openVolume = openIdx.reduce((sum, i) => sum + accounts[i].volume, 0);
    if (openVolume <= 0) break;

    let carried = 0;
    for (const i of openIdx) {
      const share  = (accounts[i].volume / openVolume) * excess;
      const capped = Math.min(awards[i] + share, cap);
      carried += awards[i] + share - capped;
      awards[i] = capped;
    }
    excess = carried;
  }
  return awards;
}

// `players` is the Map produced by ledger.aggregatePlayers.
function buildBonusReport(players, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const all = [...players.values()];

  // Accounts with no wagering volume take no part in the leaderboard.
  const active   = all.filter(a => a.volume > 0).sort((a, b) => b.volume - a.volume);
  const inactive = all.filter(a => a.volume <= 0);

  if (!active.length) throw new Error('No active accounts found — every account has zero volume.');

  // Top slice, but never fewer than the floor (or than we actually have).
  const eligibleCount = Math.min(
    active.length,
    Math.max(config.minEligible, Math.ceil(active.length * config.topPct)),
  );
  const eligible   = active.slice(0, eligibleCount);
  const ineligible = active.slice(eligibleCount);

  const awards = distribute(eligible, config.pool, config.cap);
  eligible.forEach((a, i) => { a.bonus = awards[i]; });
  ineligible.forEach(a => { a.bonus = 0; });
  inactive.forEach(a => { a.bonus = 0; });

  const totalPaid      = awards.reduce((sum, b) => sum + b, 0);
  const eligibleVolume = eligible.reduce((sum, a) => sum + a.volume, 0);
  const activeVolume   = active.reduce((sum, a) => sum + a.volume, 0);

  return {
    config,
    all, active, inactive, eligible, ineligible,
    awards,
    eligibleCount,
    eligibleVolume,
    activeVolume,
    // Volume of the last account to make the cut — anything below this missed out.
    volumeThreshold: eligible.length ? eligible[eligible.length - 1].volume : 0,
    totalPaid,
    // The cap limits the eligible set to `count x cap` in total. With a small
    // set that ceiling can sit below the pool, leaving part of it unpayable —
    // surfaced here rather than silently vanishing.
    unpaid: Math.max(0, config.pool - totalPaid),
    payoutCeiling: eligible.length * config.cap,
  };
}

// The payload shape the leaderboard collection already stores: week keys, the
// cutoff, and the top ten accounts by rank.
function toPayload(report, week, { limit = 10, generatedAt = new Date() } = {}) {
  return {
    generated_at:     generatedAt.toISOString(),
    week_start:       week.weekStart,
    week_end:         week.weekEnd,
    volume_threshold: Math.round(report.volumeThreshold),
    bonuses: report.eligible.slice(0, limit).map((a, i) => ({
      rank:    i + 1,
      account: a.player,
    })),
  };
}

module.exports = { DEFAULTS, distribute, buildBonusReport, toPayload };
