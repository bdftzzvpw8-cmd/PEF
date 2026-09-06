'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { distribute, buildBonusReport, DEFAULTS } = require('../lib/bonus');

function playersFrom(volumes) {
  const map = new Map();
  volumes.forEach((volume, i) => {
    const name = `ACCT${String(i + 1).padStart(2, '0')}`;
    map.set(name, { player: name, key: name, agent: 'A', volume, pnl: 0, bets: 1 });
  });
  return map;
}

test('distributes the whole pool in proportion to volume', () => {
  const accounts = [{ volume: 300 }, { volume: 200 }, { volume: 500 }];
  const awards = distribute(accounts, 1000, 10000);
  assert.deepStrictEqual(awards.map(a => Math.round(a)), [300, 200, 500]);
  assert.ok(Math.abs(awards.reduce((s, a) => s + a, 0) - 1000) < 0.01);
});

test('caps an account and re-spreads the overflow to the others', () => {
  // Without a cap the first account would take $900 of the $1000.
  const accounts = [{ volume: 900 }, { volume: 50 }, { volume: 50 }];
  const awards = distribute(accounts, 1000, 500);
  assert.strictEqual(Math.round(awards[0]), 500);
  assert.ok(Math.abs(awards.reduce((s, a) => s + a, 0) - 1000) < 0.01,
    'overflow should be redistributed, not lost');
  assert.ok(Math.abs(awards[1] - awards[2]) < 0.01, 'equal volume, equal award');
});

test('stops cleanly when every account hits the cap', () => {
  const accounts = [{ volume: 100 }, { volume: 100 }];
  const awards = distribute(accounts, 1000, 200);
  assert.deepStrictEqual(awards.map(Math.round), [200, 200]);
});

test('never awards more than the cap after redistribution', () => {
  const volumes = [5000, 100, 90, 80, 70, 60, 50, 40, 30, 20];
  const awards = distribute(volumes.map(volume => ({ volume })), 3000, 500);
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

test('zero-volume accounts are excluded, not ranked last', () => {
  const report = buildBonusReport(playersFrom([100, 0, 50, 0]));
  assert.strictEqual(report.active.length, 2);
  assert.strictEqual(report.inactive.length, 2);
  for (const account of report.inactive) assert.strictEqual(account.bonus, 0);
});

test('the cutoff is the volume of the last account to make the cut', () => {
  const report = buildBonusReport(playersFrom([900, 800, 700, 600, 500]), { minEligible: 3 });
  assert.strictEqual(report.volumeThreshold, 700);
});

test('throws when no account has any volume', () => {
  assert.throws(() => buildBonusReport(playersFrom([0, 0])), /No active accounts/);
});

test('defaults match the agreed rules', () => {
  assert.strictEqual(DEFAULTS.pool, 3000);
  assert.strictEqual(DEFAULTS.cap, 500);
  assert.strictEqual(DEFAULTS.topPct, 0.20);
  assert.strictEqual(DEFAULTS.minEligible, 10);
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
