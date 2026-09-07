#!/usr/bin/env node
'use strict';
// CLI for the weekly reports.
//
//   node bin/report.js weekly    <exports...>   leaderboard + referrals
//   node bin/report.js bonus     <exports...>   leaderboard only
//   node bin/report.js referrals <exports...>   referral commissions only
//   node bin/report.js verify    <exports...>   structural checks only
//
// Pass any mix of the two exports the platform emits. The periodic summary
// carries the whole book's P&L by bet type; the transaction ledger carries
// wagering volume and the referral rows — referrals cannot be reported without
// at least one ledger file.
//
// Options: --basis=total_pnl|abs_pnl|wagered  --pool  --cap  --topPct  --floor
//          --rate   --include-casino   --json   --csv

const { load }                        = require('../lib/load');
const { buildBonusReport, toPayload } = require('../lib/bonus');
const { buildReferralReport, toCsv }  = require('../lib/referrals');
const { buildWeeklyReport, toWeeklyPayload } = require('../lib/weekly');

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
const name  = a => a.player ?? a.account;
// House view: a negative P&L means the house won.
const result = pnl => (pnl === undefined || pnl === 0 ? '—' : pnl < 0 ? 'house won' : 'player won');

function bonusOptions(flags) {
  return {
    ...(flags.basis  !== undefined && { basis:  String(flags.basis) }),
    ...(flags.pool   !== undefined && { pool:   Number(flags.pool) }),
    ...(flags.cap    !== undefined && { cap:    Number(flags.cap) }),
    ...(flags.topPct !== undefined && { topPct: Number(flags.topPct) / 100 }),
    ...(flags.floor  !== undefined && { minEligible: Number(flags.floor) }),
  };
}
function referralOptions(flags) {
  return { ...(flags.rate !== undefined && { commissionRate: Number(flags.rate) / 100 }) };
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderBonus(report, { accounts, week, exclusionLine, showReferrer }) {
  console.log(`\nWeekly Bonus Leaderboard   ${week.weekStart} → ${week.weekEnd}`);
  console.log(`Ranked on ${report.metric.label} — ${report.metric.note}`);
  console.log(exclusionLine);
  console.log(`${accounts.size} accounts · ${report.active.length} qualifying `
    + `· ${report.inactive.length} excluded`);
  console.log(`Pool ${money(report.config.pool)} · cap ${money(report.config.cap)}/account `
    + `· top ${report.config.topPct * 100}% (floor ${report.config.minEligible})`);
  console.log(`Eligible ${report.eligibleCount} · cutoff ${money(report.threshold)}`);
  console.log(`Total ${money(report.totalWeight)} · net ${money(report.netPnl)}\n`);

  const header = ['  #', 'Account'.padEnd(16), 'Agent'.padEnd(12),
    report.metric.label.padStart(12), 'Share'.padStart(8), 'Result'.padStart(11),
    'Bonus'.padStart(11)];
  if (showReferrer) header.push('  Referred by');
  console.log(header.join(' '));

  report.eligible.forEach((account, i) => {
    const share = report.eligibleWeight > 0
      ? (account.metricValue / report.eligibleWeight) * 100 : 0;
    const row = [
      String(i + 1).padStart(3),
      name(account).padEnd(16),
      (account.agent || account.group || '—').padEnd(12),
      count(account.metricValue).padStart(12),
      (share.toFixed(2) + '%').padStart(8),
      result(account.pnl).padStart(11),
      money(account.bonus).padStart(11),
    ];
    if (showReferrer) row.push('  ' + (account.referredBy || '—'));
    console.log(row.join(' '));
  });

  const eligibleShare = report.totalWeight > 0
    ? (report.eligibleWeight / report.totalWeight) * 100 : 0;
  console.log(`\nEligible accounts hold ${money(report.eligibleWeight)} of the `
    + `${money(report.totalWeight)} total (${eligibleShare.toFixed(1)}%)`);
  console.log(`Total paid ${money(report.totalPaid)} of ${money(report.config.pool)}`);
  if (report.unpaid > 0.01) {
    console.log(`WARNING  ${money(report.unpaid)} undistributed — ${report.eligibleCount} eligible `
      + `account(s) at a ${money(report.config.cap)} cap can absorb at most `
      + `${money(report.payoutCeiling)}.`);
  }
  console.log('');
}

function renderReferrals(report, { week, exclusionLine, seen }) {
  console.log(`\nWeekly Referrals   ${week.weekStart} → ${week.weekEnd}`);
  console.log(`${report.referrerCount} referrers · ${report.clientCount} referred clients `
    + `· commission ${report.config.commissionRate * 100}% of net losses`);
  console.log(`${exclusionLine}\n`);

  if (!report.groups.length) {
    console.log(seen.ledger
      ? 'No referral rows found. Referrals are read from credit rows whose details '
        + 'read "Referred <CODE>".'
      : 'No referral data — referral rows live in the transaction ledger, and no '
        + 'ledger file was supplied.');
    console.log('');
    return;
  }

  for (const group of report.groups) {
    const net = group.pnl < 0
      ? `house +${money(Math.abs(group.pnl))}`
      : `house -${money(group.pnl)}`;
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
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { files, flags } = parseArgs(rest);

  if (!command || !files.length) {
    console.error('Usage: report.js <weekly|bonus|referrals|verify> <export.csv|.xlsx> [...]');
    process.exit(1);
  }

  const { accounts, referrals, week, warnings, seen, exclude, excludedTotal, excludedAccounts } =
    load(files, { includeExcluded: Boolean(flags['include-casino']) });
  for (const warning of warnings) console.error(`NOTE  ${warning}`);

  const exclusionLine = exclude.length
    ? `Excluding ${exclude.join(', ')} — ${money(excludedTotal)} across `
      + `${excludedAccounts} account(s) left out`
    : 'Including every product (casino not excluded)';
  const context = { accounts, week, exclusionLine, seen };

  if (command === 'verify') {
    console.log(`\n${files.length} file(s): ${seen.periodic} periodic summary, ${seen.ledger} ledger`);
    console.log(`Week ${week ? `${week.weekStart} → ${week.weekEnd}` : 'unknown'}`);
    console.log(`${accounts.size} accounts · ${referrals.length} referral edge(s)`);
    console.log(`${[...accounts.values()].filter(a => a.volume > 0).length} account(s) have wagering volume`);
    console.log(exclusionLine);
    console.log(warnings.length ? `\n${warnings.length} note(s) above.\n` : '\nNo inconsistencies found.\n');
    return;
  }

  if (command === 'weekly') {
    const report = buildWeeklyReport(accounts, referrals, {
      bonus:    bonusOptions(flags),
      referral: referralOptions(flags),
    });
    if (flags.json) {
      console.log(JSON.stringify(toWeeklyPayload(report, week), null, 2));
      return;
    }
    renderBonus(report.bonus, { ...context, showReferrer: referrals.length > 0 });
    renderReferrals(report.referral, context);

    if (report.paidAndReferred.length) {
      console.log('Referred clients who also won a bonus:');
      for (const entry of report.paidAndReferred) {
        console.log(`    ${entry.account.padEnd(16)} ${money(entry.bonus).padStart(10)}`
          + `   referred by ${entry.referrer}`);
      }
      console.log('');
    }
    return;
  }

  if (command === 'bonus') {
    const report = buildBonusReport(accounts, bonusOptions(flags));
    if (flags.json) { console.log(JSON.stringify(toPayload(report, week), null, 2)); return; }
    renderBonus(report, { ...context, showReferrer: referrals.length > 0 });
    return;
  }

  if (command === 'referrals') {
    const report = buildReferralReport(accounts, referrals, referralOptions(flags));
    if (flags.csv)  { console.log(toCsv(report)); return; }
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return; }
    renderReferrals(report, context);
    return;
  }

  console.error(`Unknown command "${command}". Expected weekly, bonus, referrals or verify.`);
  process.exit(1);
}

main();
