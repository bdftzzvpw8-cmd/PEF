'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { distribute, buildBonusReport, toPayload, DEFAULTS } = require('../lib/bonus');

// Each account gets the same figure as volume and as a loss, so a test reads
// the same under either ranking basis.
function playersFrom(values) {
  const map = new Map();
  values.forEach((value, i) => {
    const name = `ACCT${String(i + 1).padStart(2, '0')}`;
    map.set(name, { player: name, key: name, agent: 'A', volume: value, pnl: -value, bets: 1 });
  });
  return map;
}

test('distributes the whole pool in proportion to the weights', () => {
  const awards = distribute([300, 200, 500], 1000, 10000);
  assert.deepStrictEqual(awards.map(a => Math.round(a)), [300, 200, 500]);
  assert.ok(Math.abs(awards.reduce((s, a) => s + a, 0) - 1000) < 0.01);
});

test('caps an account and re-spreads the overflow to the others', () => {
  // Without a cap the first account would take $900 of the $1000.
  const awards = distribute([900, 50, 50], 1000, 500);
  assert.strictEqual(Math.round(awards[0]), 500);
  assert.ok(Math.abs(awards.reduce((s, a) => s + a, 0) - 1000) < 0.01,
    'overflow should be redistributed, not lost');
  assert.ok(Math.abs(awards[1] - awards[2]) < 0.01, 'equal weight, equal award');
});

test('stops cleanly when every account hits the cap', () => {
  const awards = distribute([100, 100], 1000, 200);
  assert.deepStrictEqual(awards.map(Math.round), [200, 200]);
});

test('never awards more than the cap after redistribution', () => {
  const awards = distribute([5000, 100, 90, 80, 70, 60, 50, 40, 30, 20], 3000, 500);
  for (const award of awards) assert.ok(award <= 500 + 1e-6, `${award} exceeds cap`);
});

test('eligibility uses the hard floor of 10 when the top slice is smaller', () => {
  // 20 active accounts: 20% is 4, so the floor of 10 must win.
  const report = buildBonusReport(playersFrom(Array.from({ length: 20 }, (_, i) => 100 - i)));
  assert.strictEqual(report.eligibleCount, 10);
});

test('eligibility uses the top slice once it exceeds the floor', () => {
  // 100 active accounts: 20% is 20, comfortably above the floor.
  const report = buildBonusReport(playersFrom(Array.from({ length: 100 }, (_, i) => 500 - i)));
  assert.strictEqual(report.eligibleCount, 20);
});

test('eligibility never exceeds the number of active accounts', () => {
  const report = buildBonusReport(playersFrom([500, 400, 300]));
  assert.strictEqual(report.eligibleCount, 3);
  assert.strictEqual(report.ineligible.length, 0);
});

test('accounts with nothing to rank on are excluded, not ranked last', () => {
  const report = buildBonusReport(playersFrom([100, 0, 50, 0]));
  assert.strictEqual(report.active.length, 2);
  assert.strictEqual(report.inactive.length, 2);
  for (const account of report.inactive) assert.strictEqual(account.bonus, 0);
});

test('the cutoff is the metric value of the last account to make the cut', () => {
  const report = buildBonusReport(playersFrom([900, 800, 700, 600, 500]), { minEligible: 3 });
  assert.strictEqual(report.threshold, 700);
});

test('throws when no account has anything to rank on', () => {
  assert.throws(() => buildBonusReport(playersFrom([0, 0])), /No qualifying accounts/);
});

test('defaults match the agreed rules', () => {
  assert.strictEqual(DEFAULTS.pool, 3000);
  assert.strictEqual(DEFAULTS.cap, 500);
  assert.strictEqual(DEFAULTS.topPct, 0.20);
  assert.strictEqual(DEFAULTS.minEligible, 10);
  assert.strictEqual(DEFAULTS.basis, 'abs_pnl');
});

test('reports the shortfall when the cap ceilings payout below the pool', () => {
  // Five eligible accounts at a $500 cap can absorb $2,500 of a $3,000 pool.
  const report = buildBonusReport(playersFrom([500, 400, 300, 200, 100]), { minEligible: 5 });
  assert.strictEqual(report.payoutCeiling, 2500);
  assert.strictEqual(Math.round(report.totalPaid), 2500);
  assert.strictEqual(Math.round(report.unpaid), 500);
});

test('reports no shortfall when the eligible set can absorb the pool', () => {
  const report = buildBonusReport(playersFrom(Array.from({ length: 20 }, (_, i) => 100 - i)));
  assert.ok(Math.abs(report.totalPaid - 3000) < 0.01);
  assert.strictEqual(Math.round(report.unpaid), 0);
});

test('the book total adds wins and losses together instead of netting them', () => {
  const accounts = new Map([
    ['W', { player: 'W', key: 'W', pnl:  400, volume: 0 }],   // player won 400
    ['L', { player: 'L', key: 'L', pnl: -400, volume: 0 }],   // house won 400
    ['S', { player: 'S', key: 'S', pnl: -100, volume: 0 }],
  ]);
  const report = buildBonusReport(accounts, { basis: 'abs_pnl', minEligible: 3 });

  assert.strictEqual(report.totalWeight, 900, 'wins and losses add together');
  assert.strictEqual(report.netPnl, -100, 'the netted figure cancels most of it');
});

test('the payload carries the totalled figure alongside the netted one', () => {
  const accounts = new Map([
    ['W', { player: 'W', key: 'W', pnl:  400, volume: 0 }],
    ['L', { player: 'L', key: 'L', pnl: -400, volume: 0 }],
  ]);
  const report  = buildBonusReport(accounts, { basis: 'abs_pnl', minEligible: 2 });
  const payload = toPayload(report, { weekStart: '08-31-2026', weekEnd: '09-06-2026' });
  assert.strictEqual(payload.total_volume, 800);
  assert.strictEqual(payload.net_pnl, 0);
});
