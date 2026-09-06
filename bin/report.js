#!/usr/bin/env node
'use strict';
// CLI: reads one or more ledger exports and prints the weekly bonus
// leaderboard or the referral commission report.
//
//   node bin/report.js bonus     export.csv [more.csv ...] [--pool=3000] [--json]
//   node bin/report.js referrals export.csv [more.csv ...] [--csv]
//
// Multiple files are concatenated, so it works whether the platform exports
// one file per player or one file for the whole book.

const { readFile }            = require('../lib/sheet');
const { loadLedger }          = require('../lib/ledger');
const { buildBonusReport, toPayload } = require('../lib/bonus');
const { buildReferralReport, toCsv }  = require('../lib/referrals');

function parseArgs(argv) {
  const files = [];
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    else files.push(arg);
  }
  return { files, flags };
}

const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = n => Math.round(n).toLocaleString('en-US');

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { files, flags } = parseArgs(rest);

  if (!command || !files.length) {
    console.error('Usage: report.js <bonus|referrals> <export.csv|.xlsx> [...] [options]');
    process.exit(1);
  }

  const rows = files.flatMap(readFile);
  const { players, referrals, week, transactions } = loadLedger(rows);

  if (command === 'bonus') {
    const report = buildBonusReport(players, {
      ...(flags.pool   !== undefined && { pool:   Number(flags.pool) }),
      ...(flags.cap    !== undefined && { cap:    Number(flags.cap) }),
      ...(flags.topPct !== undefined && { topPct: Number(flags.topPct) / 100 }),
      ...(flags.floor  !== undefined && { minEligible: Number(flags.floor) }),
    });

    if (flags.json) {
      console.log(JSON.stringify(toPayload(report, week), null, 2));
      return;
    }

    console.log(`\nWeekly Bonus Leaderboard   ${week.weekStart} → ${week.weekEnd}`);
    console.log(`${transactions.length} transactions · ${report.active.length} active `
      + `· ${report.inactive.length} zero-volume excluded`);
    console.log(`Pool ${money(report.config.pool)} · cap ${money(report.config.cap)}/account `
      + `· top ${report.config.topPct * 100}% (floor ${report.config.minEligible})`);
    console.log(`Eligible ${report.eligibleCount} · cutoff volume ${money(report.volumeThreshold)}\n`);

    console.log(['  #', 'Account'.padEnd(16), 'Agent'.padEnd(10),
      'Volume'.padStart(12), 'Share'.padStart(8), 'Bonus'.padStart(11)].join(' '));
    report.eligible.forEach((a, i) => {
      const share = report.eligibleVolume > 0 ? (a.volume / report.eligibleVolume) * 100 : 0;
      console.log([
        String(i + 1).padStart(3),
        a.player.padEnd(16),
        (a.agent || '—').padEnd(10),
        count(a.volume).padStart(12),
        (share.toFixed(2) + '%').padStart(8),
        money(a.bonus).padStart(11),
      ].join(' '));
    });
    console.log(`\nTotal paid ${money(report.totalPaid)} of ${money(report.config.pool)}`);
    if (report.unpaid > 0.01) {
      console.log(`WARNING  ${money(report.unpaid)} undistributed — ${report.eligibleCount} eligible `
        + `account(s) at a ${money(report.config.cap)} cap can absorb at most `
        + `${money(report.payoutCeiling)}.`);
    }
    console.log('');
    return;
  }

  if (command === 'referrals') {
    const report = buildReferralReport(players, referrals, {
      ...(flags.rate !== undefined && { commissionRate: Number(flags.rate) / 100 }),
    });

    if (flags.csv)  { console.log(toCsv(report)); return; }
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return; }

    console.log(`\nWeekly Referrals   ${week.weekStart} → ${week.weekEnd}`);
    console.log(`${report.referrerCount} referrers · ${report.clientCount} referred clients `
      + `· commission ${report.config.commissionRate * 100}% of net losses\n`);

    if (!report.groups.length) {
      console.log('No referral rows found. Referrals are read from credit rows '
        + 'whose details read "Referred <CODE>".\n');
      return;
    }

    for (const group of report.groups) {
      const net = group.pnl < 0 ? `house +${money(Math.abs(group.pnl))}` : `house -${money(group.pnl)}`;
      console.log(`${group.referrer}  ·  ${group.clientCount} client(s)  ·  ${net}`
        + (group.commission > 0 ? `  ·  owes ${money(group.commission)}` : '  ·  no commission'));
      for (const client of group.clients) {
        const lossShare = client.pnl < 0
          ? money(Math.abs(client.pnl) * report.config.commissionRate)
          : '—';
        console.log(`    ${client.account.padEnd(16)} vol ${count(client.volume).padStart(10)}`
          + `   p&l ${(client.pnl < 0 ? '+' : '-') + money(Math.abs(client.pnl))}`.padEnd(22)
          + `   loss share ${lossShare}`
          + (client.hasActivity ? '' : '   (no activity this week)'));
      }
      if (group.commission === 0 && group.clients.some(c => c.pnl < 0)) {
        console.log('    (losing clients are offset by winning ones — nothing payable)');
      }
      console.log('');
    }
    console.log(`Total commission ${money(report.totalCommission)}\n`);
    return;
  }

  console.error(`Unknown command "${command}". Expected "bonus" or "referrals".`);
  process.exit(1);
}

main();
