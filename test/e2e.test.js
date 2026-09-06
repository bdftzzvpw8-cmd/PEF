'use strict';
// End-to-end over a ledger export in the platform's real format. The fixture
// mirrors the shape of a live export with stand-in account names.
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');

const { readFile }            = require('../lib/sheet');
const { loadLedger }          = require('../lib/ledger');
const { buildBonusReport, toPayload } = require('../lib/bonus');
const { buildReferralReport } = require('../lib/referrals');

const FIXTURE = path.join(__dirname, 'fixtures', 'ledger-sample.csv');
const load = () => loadLedger(readFile(FIXTURE));

test('reads every player and drops the totals row', () => {
  const { players } = load();
  assert.deepStrictEqual([...players.keys()].sort(), ['AA100', 'BB200', 'CC300', 'DD400', 'EE500']);
});

test('volume and p&l match a hand calculation', () => {
  const { players } = load();

  // AA100 staked 25 + 75 = 100, got back 40. Its 50 + 26 in referral credits
  // and 0.50 carryover must not appear in either figure.
  assert.strictEqual(players.get('AA100').volume, 100);
  assert.strictEqual(players.get('AA100').pnl, -60);

  // BB200 staked 300, got back 150. The rejected withdrawal is irrelevant.
  assert.strictEqual(players.get('BB200').volume, 300);
  assert.strictEqual(players.get('BB200').pnl, -150);

  // CC300 staked 500 and won 900 — a player up 400.
  assert.strictEqual(players.get('CC300').pnl, 400);

  // EE500 only has a carryover, so it never wagered.
  assert.strictEqual(players.get('EE500').volume, 0);
});

test('the reporting week comes from the transaction dates', () => {
  const { week } = load();
  assert.strictEqual(week.weekEnd, '09-06-2026');
  assert.strictEqual(week.weekStart, '08-31-2026');
});

test('bonus leaderboard ranks by volume and excludes the non-wagering account', () => {
  const { players, week } = load();
  const report = buildBonusReport(players, { basis: 'volume' });

  assert.deepStrictEqual(report.active.map(a => a.player), ['CC300', 'BB200', 'AA100', 'DD400']);
  assert.strictEqual(report.inactive.length, 1, 'EE500 has no volume');

  // Four active accounts, so the floor of 10 clamps down to all four.
  assert.strictEqual(report.eligibleCount, 4);

  // Pool 3000 over 960 total volume: CC300's share alone would exceed the cap.
  assert.strictEqual(Math.round(report.eligible[0].bonus), 500);
  for (const account of report.eligible) assert.ok(account.bonus <= 500 + 1e-6);
  // Only four accounts are eligible, so the $500 cap ceilings the payout at
  // $2,000 and $1,000 of the pool cannot be distributed.
  assert.strictEqual(report.payoutCeiling, 2000);
  assert.strictEqual(Math.round(report.totalPaid), 2000);
  assert.strictEqual(Math.round(report.unpaid), 1000);

  const payload = toPayload(report, week);
  assert.strictEqual(payload.week_end, '09-06-2026');
  assert.strictEqual(payload.volume_threshold, 60);
  assert.strictEqual(payload.threshold_basis, 'volume');
  assert.strictEqual(payload.bonuses[0].account, 'CC300');
});

test('referral report joins referred clients back to the referrer', () => {
  const { players, referrals } = load();
  const report = buildReferralReport(players, referrals);

  assert.strictEqual(report.referrerCount, 1);
  const group = report.groups[0];
  assert.strictEqual(group.referrer, 'AA100');
  assert.deepStrictEqual(group.clients.map(c => c.account).sort(), ['BB200', 'CC300']);

  // BB200 lost 150, CC300 won 400 → the group is net +250 for the players,
  // so the house is down and no commission is owed.
  assert.strictEqual(group.pnl, 250);
  assert.strictEqual(group.commission, 0);
});

test('commission is owed once the referred group is net down', () => {
  const { players, referrals } = load();
  // Drop the big winner and only AA100's losing client remains.
  players.delete('CC300');
  const report = buildReferralReport(players, referrals.filter(e => e.referredKey !== 'CC300'));
  assert.strictEqual(report.groups[0].pnl, -150);
  assert.strictEqual(report.groups[0].commission, 30);
});

// ── Ranking on P&L, across both export shapes ────────────────────────────────
const { load: loadFiles } = require('../lib/load');
const PERIODIC = path.join(__dirname, 'fixtures', 'periodic-sample.csv');

test('the P&L board ranks on the size of the swing, winners and losers alike', () => {
  const { accounts } = loadFiles([PERIODIC]);
  const report = buildBonusReport(accounts, { basis: 'abs_pnl' });

  // CC300 is up 400 and BB200 down 100 — the biggest swings lead, either way.
  assert.deepStrictEqual(
    report.active.map(a => a.account),
    ['CC300', 'BB200', 'FF600', 'AA100'],
  );
  assert.strictEqual(report.active[0].pnl, -400, 'the top account is a big house win');
  assert.ok(report.active.some(a => a.pnl > 0), 'accounts on both sides qualify');
});

test('an account that broke exactly even does not qualify', () => {
  const { accounts } = loadFiles([PERIODIC]);
  accounts.set('ZZ999', { account: 'ZZ999', player: 'ZZ999', key: 'ZZ999', volume: 0, pnl: 0 });
  const report = buildBonusReport(accounts, { basis: 'abs_pnl' });
  assert.ok(report.inactive.some(a => a.account === 'ZZ999'));
  assert.ok(!report.eligible.some(a => a.account === 'ZZ999'));
});

test('the payload records which metric set the cutoff', () => {
  const { accounts, week } = loadFiles([PERIODIC]);
  const payload = toPayload(buildBonusReport(accounts, { basis: 'abs_pnl' }), week);
  assert.strictEqual(payload.threshold_basis, 'abs_pnl');
  assert.strictEqual(payload.volume_threshold, 19, 'the smallest qualifying swing');
});

test('ranking basis changes who leads the board', () => {
  const { accounts } = loadFiles([PERIODIC, FIXTURE]);
  const byPnl    = buildBonusReport(accounts, { basis: 'abs_pnl' });
  const byVolume = buildBonusReport(accounts, { basis: 'volume' });
  assert.notDeepStrictEqual(
    byPnl.active.map(a => a.account),
    byVolume.active.map(a => a.account),
  );
});

test('an unknown ranking basis is rejected rather than silently defaulted', () => {
  const { accounts } = loadFiles([PERIODIC]);
  assert.throws(() => buildBonusReport(accounts, { basis: 'turnover' }), /Unknown ranking basis/);
});
