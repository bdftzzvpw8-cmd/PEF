'use strict';
// Weekly bonus leaderboard: splits a fixed prize pool across the top slice of
// qualifying accounts, weighted by whichever metric the leaderboard ranks on
// and capped per account.

// How an account earns its place.
//
// `total_pnl` totals each client's wins and losses across their bet types, so a
// client who won 500 on PreMatch and lost 400 InPlay counts for 900, not 100.
// It measures how much action a client put through, which is what the
// leaderboard has always rewarded.
//
// The other two exist for comparison: `abs_pnl` nets a client's bet types before
// taking the magnitude, and `wagered` is the original basis, which needs
// transaction-ledger files since only they carry the amount staked.
const METRICS = {
  total_pnl: {
    key:   'total_pnl',
    label: 'Volume',
    of:    account => {
      const perType = account.betTypes && Object.keys(account.betTypes).length
        ? Object.values(account.betTypes)
        : null;
      // Without a bet-type breakdown the netted figure is all there is.
      return perType
        ? perType.reduce((sum, amount) => sum + Math.abs(amount), 0)
        : Math.abs(account.pnl ?? 0);
    },
    note:  "each client's wins and losses totalled across their bet types",
  },
  abs_pnl: {
    key:   'abs_pnl',
    label: '|Net P&L|',
    of:    account => Math.abs(account.pnl ?? 0),
    note:  'the size of the net swing, after a client\'s bet types cancel out',
  },
  wagered: {
    key:   'wagered',
    label: 'Wagered',
    of:    account => account.volume ?? 0,
    note:  'amount staked (needs ledger exports)',
  },
};

const DEFAULTS = {
  pool:       3000,       // total prize pool, in dollars
  cap:         500,       // most any single account can receive
  topPct:     0.20,       // share of qualifying accounts that are eligible
  minEligible: 10,        // hard floor: always at least this many, if available
  basis:      'total_pnl',// which metric ranks and weights the leaderboard
};

// Spreads `pool` across `weights` in proportion, then applies the per-account
// cap and re-spreads the overflow among those still under it. Repeats until the
// leftover is negligible or everyone is capped.
function distribute(weights, pool, cap) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return weights.map(() => 0);

  const awards = weights.map(w => Math.min((w / total) * pool, cap));
  let excess = pool - awards.reduce((sum, a) => sum + a, 0);

  for (let pass = 0; pass < 20 && excess > 0.005; pass++) {
    const openIdx = awards
      .map((a, i) => (a < cap - 1e-9 ? i : -1))
      .filter(i => i >= 0);
    if (!openIdx.length) break;

    const openWeight = openIdx.reduce((sum, i) => sum + weights[i], 0);
    if (openWeight <= 0) break;

    let carried = 0;
    for (const i of openIdx) {
      const share  = (weights[i] / openWeight) * excess;
      const capped = Math.min(awards[i] + share, cap);
      carried += awards[i] + share - capped;
      awards[i] = capped;
    }
    excess = carried;
  }
  return awards;
}

// `accounts` is the Map produced by ledger.aggregatePlayers or load.load.
function buildBonusReport(accounts, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const metric = METRICS[config.basis];
  if (!metric) {
    throw new Error(`Unknown ranking basis "${config.basis}". `
      + `Expected one of: ${Object.keys(METRICS).join(', ')}.`);
  }

  const all = [...accounts.values()];
  for (const account of all) account.metricValue = metric.of(account);

  // An account with nothing to rank on takes no part in the leaderboard.
  const active   = all.filter(a => a.metricValue > 0).sort((a, b) => b.metricValue - a.metricValue);
  const inactive = all.filter(a => a.metricValue <= 0);

  if (!active.length) {
    throw new Error(`No qualifying accounts — every account has zero ${metric.label}.`);
  }

  // Top slice, but never fewer than the floor (or than we actually have).
  const eligibleCount = Math.min(
    active.length,
    Math.max(config.minEligible, Math.ceil(active.length * config.topPct)),
  );
  const eligible   = active.slice(0, eligibleCount);
  const ineligible = active.slice(eligibleCount);

  const awards = distribute(eligible.map(a => a.metricValue), config.pool, config.cap);
  eligible.forEach((a, i) => { a.bonus = awards[i]; });
  ineligible.forEach(a => { a.bonus = 0; });
  inactive.forEach(a => { a.bonus = 0; });

  const totalPaid      = awards.reduce((sum, a) => sum + a, 0);
  const eligibleWeight = eligible.reduce((sum, a) => sum + a.metricValue, 0);
  // Wins and losses are added together rather than netted: an account that won
  // 400 and one that lost 400 each contribute 400, so the book total reflects
  // the whole week's action. Netting them would cancel to nearly nothing.
  const totalWeight    = all.reduce((sum, a) => sum + a.metricValue, 0);

  return {
    config, metric,
    all, active, inactive, eligible, ineligible,
    awards,
    eligibleCount,
    eligibleWeight,
    activeWeight: active.reduce((sum, a) => sum + a.metricValue, 0),
    // The book-wide total, wins and losses added together.
    totalWeight,
    // The same figure netted, which is what the export's own grand-total row
    // reports. Kept so the two can be reconciled rather than confused.
    netPnl: all.reduce((sum, a) => sum + (a.pnl ?? 0), 0),
    // The metric value of the last account to make the cut — anything below
    // this missed out.
    threshold: eligible.length ? eligible[eligible.length - 1].metricValue : 0,
    totalPaid,
    // The cap limits the eligible set to `count x cap` in total. With a small
    // set that ceiling can sit below the pool, leaving part of it unpayable —
    // surfaced here rather than silently vanishing.
    unpaid: Math.max(0, config.pool - totalPaid),
    payoutCeiling: eligible.length * config.cap,
  };
}

// The payload shape the leaderboard collection already stores. `volume_threshold`
// keeps its name so existing consumers do not break, but it now carries the
// cutoff for whichever metric ranked the board — `threshold_basis` says which.
function toPayload(report, week, { limit = 10, generatedAt = new Date() } = {}) {
  return {
    generated_at:     generatedAt.toISOString(),
    week_start:       week.weekStart,
    week_end:         week.weekEnd,
    volume_threshold: Math.round(report.threshold),
    threshold_basis:  report.metric.key,
    // Wins and losses added together, not netted.
    total_volume:     Math.round(report.totalWeight),
    net_pnl:          Math.round(report.netPnl),
    bonuses: report.eligible.slice(0, limit).map((account, i) => ({
      rank:    i + 1,
      account: account.player ?? account.account,
    })),
  };
}

module.exports = { METRICS, DEFAULTS, distribute, buildBonusReport, toPayload };
