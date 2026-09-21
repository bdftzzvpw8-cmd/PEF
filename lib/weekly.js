'use strict';
// The weekly report: the bonus leaderboard and the referral commissions in one
// place, over the same week and the same set of exports.

const { buildBonusReport, toPayload: bonusPayload, METRICS } = require('./bonus');
const { buildReferralReport } = require('./referrals');

// While the ranking basis is still being decided, the report shows the paying
// board alongside the alternative so the two can be compared on real weeks
// before either is committed to.
function compareBases(accounts, primary, options) {
  const alternative = primary === 'wagered' ? 'total_pnl' : 'wagered';
  let other;
  try {
    other = buildBonusReport(accounts, { ...options, basis: alternative });
  } catch {
    return null;   // nothing to rank on for that basis — e.g. no volume supplied
  }
  return {
    basis:  alternative,
    label:  METRICS[alternative].label,
    report: other,
    rows:   other.eligible.map((account, i) => ({
      rank:    i + 1,
      account: account.player ?? account.account,
      value:   account.metricValue,
      bonus:   account.bonus,
    })),
  };
}

function buildWeeklyReport(accounts, referrals, options = {}) {
  const bonus    = buildBonusReport(accounts, options.bonus);
  const referral = buildReferralReport(accounts, referrals, options.referral);

  const comparison = compareBases(accounts, bonus.metric.key, options.bonus ?? {});
  // Re-rank on the paying basis: building the alternative stamped every account
  // with its metric value, and the render reads that field.
  if (comparison) buildBonusReport(accounts, options.bonus);

  const paidBy = new Set(bonus.eligible.map(a => a.player ?? a.account));
  const alsoPaid = comparison
    ? comparison.rows.filter(row => paidBy.has(row.account)).map(row => row.account)
    : [];

  // Which of the paid accounts were themselves referred — the overlap that
  // matters when the same client both wins a bonus and earns someone a
  // commission.
  const paidAndReferred = bonus.eligible
    .filter(account => account.referredBy)
    .map(account => ({
      account:  account.player ?? account.account,
      bonus:    account.bonus,
      referrer: account.referredBy,
    }));

  return {
    bonus, referral, paidAndReferred,
    comparison: comparison && {
      ...comparison,
      // Who would be paid under either basis, and who only under one.
      inBoth:      alsoPaid,
      onlyOnOther: comparison.rows.filter(r => !paidBy.has(r.account)).map(r => r.account),
      onlyOnPaying: bonus.eligible
        .map(a => a.player ?? a.account)
        .filter(name => !comparison.rows.some(r => r.account === name)),
    },
  };
}

function toWeeklyPayload(report, week, options = {}) {
  const { bonus, referral, paidAndReferred } = report;
  return {
    ...bonusPayload(bonus, week, options),
    referrals: {
      referrers:        referral.referrerCount,
      referred_clients: referral.clientCount,
      commission_rate:  referral.config.commissionRate,
      total_commission: Number(referral.totalCommission.toFixed(2)),
      payable: referral.groups
        .filter(group => group.commission > 0)
        .map(group => ({
          referrer:   group.referrer,
          clients:    group.clientCount,
          net_pnl:    Number(group.pnl.toFixed(2)),
          commission: Number(group.commission.toFixed(2)),
        })),
    },
    comparison: report.comparison && {
      basis: report.comparison.basis,
      ranking: report.comparison.rows.map(row => ({
        rank: row.rank, account: row.account, value: Number(row.value.toFixed(2)),
      })),
      in_both:        report.comparison.inBoth,
      only_on_other:  report.comparison.onlyOnOther,
      only_on_paying: report.comparison.onlyOnPaying,
    },
    bonus_winners_referred: paidAndReferred.map(entry => ({
      account:  entry.account,
      referrer: entry.referrer,
      bonus:    Number(entry.bonus.toFixed(2)),
    })),
  };
}

module.exports = { buildWeeklyReport, toWeeklyPayload };
