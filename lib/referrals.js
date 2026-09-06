'use strict';
// Weekly referral commission: each referrer earns a share of what their
// referred clients lost over the week.

const DEFAULTS = {
  commissionRate: 0.20,   // share of a group's net losses paid to the referrer
};

// `players` is the Map from ledger.aggregatePlayers; `edges` the array from
// ledger.parseReferrals. Referred accounts with no activity this week are kept
// and reported at zero, so a referrer's roster stays visible week to week.
function buildReferralReport(players, edges, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const groups = new Map();

  for (const edge of edges) {
    let group = groups.get(edge.referrerKey);
    if (!group) {
      group = { referrer: edge.referrer, referrerKey: edge.referrerKey, clients: [] };
      groups.set(edge.referrerKey, group);
    }
    const activity = players.get(edge.referredKey);
    group.clients.push({
      account:  activity ? activity.player : edge.referred,
      key:      edge.referredKey,
      volume:   activity ? activity.volume : 0,
      pnl:      activity ? activity.pnl    : 0,
      bets:     activity ? activity.bets   : 0,
      hasActivity: Boolean(activity),
      bonusPaid: edge.bonusPaid,
    });
  }

  for (const group of groups.values()) {
    group.clients.sort((a, b) => b.volume - a.volume);
    group.volume = group.clients.reduce((sum, c) => sum + c.volume, 0);
    // Negative P&L means the house won; only then is commission owed.
    group.pnl        = group.clients.reduce((sum, c) => sum + c.pnl, 0);
    group.commission = group.pnl < 0 ? Math.abs(group.pnl) * config.commissionRate : 0;
    group.clientCount = group.clients.length;
    group.activeClientCount = group.clients.filter(c => c.hasActivity).length;
  }

  // Referrers owed commission first, then by volume.
  const sorted = [...groups.values()].sort((a, b) => {
    if ((a.commission > 0) !== (b.commission > 0)) return a.commission > 0 ? -1 : 1;
    if (b.commission !== a.commission) return b.commission - a.commission;
    return b.volume - a.volume;
  });

  return {
    config,
    groups: sorted,
    referrerCount:  sorted.length,
    clientCount:    sorted.reduce((sum, g) => sum + g.clientCount, 0),
    totalVolume:    sorted.reduce((sum, g) => sum + g.volume, 0),
    totalPnl:       sorted.reduce((sum, g) => sum + g.pnl, 0),
    totalCommission: sorted.reduce((sum, g) => sum + g.commission, 0),
  };
}

// Per-client rows followed by a subtotal per referrer. The payable figure is
// the subtotal: it nets a referrer's winning clients against their losing ones,
// so summing the per-client column overstates what is actually owed.
function toCsv(report) {
  const rate = report.config.commissionRate;
  const rows = [['Referrer', 'Account', 'Total Volume', 'Win/Loss', 'Client Loss Share', 'Commission Payable']];

  for (const group of report.groups) {
    for (const client of group.clients) {
      rows.push([
        group.referrer,
        client.account,
        client.volume.toFixed(2),
        client.pnl.toFixed(2),
        client.pnl < 0 ? (Math.abs(client.pnl) * rate).toFixed(2) : '',
        '',
      ]);
    }
    rows.push([
      group.referrer,
      'SUBTOTAL',
      group.volume.toFixed(2),
      group.pnl.toFixed(2),
      '',
      group.commission.toFixed(2),
    ]);
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

module.exports = { DEFAULTS, buildReferralReport, toCsv };
