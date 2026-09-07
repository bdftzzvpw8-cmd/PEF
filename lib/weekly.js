'use strict';
// The weekly report: the bonus leaderboard and the referral commissions in one
// place, over the same week and the same set of exports.

const { buildBonusReport, toPayload: bonusPayload } = require('./bonus');
const { buildReferralReport } = require('./referrals');

function buildWeeklyReport(accounts, referrals, options = {}) {
  const bonus    = buildBonusReport(accounts, options.bonus);
  const referral = buildReferralReport(accounts, referrals, options.referral);

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

  return { bonus, referral, paidAndReferred };
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
    bonus_winners_referred: paidAndReferred.map(entry => ({
      account:  entry.account,
      referrer: entry.referrer,
      bonus:    Number(entry.bonus.toFixed(2)),
    })),
  };
}

module.exports = { buildWeeklyReport, toWeeklyPayload };
