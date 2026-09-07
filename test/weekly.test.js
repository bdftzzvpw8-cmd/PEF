'use strict';
// The combined weekly report: leaderboard and referrals over one week.
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { load } = require('../lib/load');
const { buildWeeklyReport, toWeeklyPayload } = require('../lib/weekly');

const LEDGER   = path.join(__dirname, 'fixtures', 'ledger-sample.csv');
const PERIODIC = path.join(__dirname, 'fixtures', 'periodic-sample.csv');
const WEEK     = { weekStart: '08-31-2026', weekEnd: '09-06-2026' };

test('both reports are produced from one pass over the exports', () => {
  const { accounts, referrals } = load([PERIODIC, LEDGER]);
  const report = buildWeeklyReport(accounts, referrals);
  assert.ok(report.bonus.eligible.length > 0);
  assert.strictEqual(report.referral.referrerCount, 1);
});

test('a referred client carries its referrer, and the referrer its clients', () => {
  const { accounts } = load([PERIODIC, LEDGER]);
  // AA100 referred BB200 and CC300 in the ledger fixture.
  assert.strictEqual(accounts.get('BB200').referredBy, 'AA100');
  assert.strictEqual(accounts.get('CC300').referredBy, 'AA100');
  assert.deepStrictEqual(accounts.get('AA100').referred.sort(), ['BB200', 'CC300']);
  assert.strictEqual(accounts.get('AA100').referredBy, null, 'the referrer was not referred');
});

test('clients who both win a bonus and were referred are called out', () => {
  const { accounts, referrals } = load([PERIODIC, LEDGER]);
  const report = buildWeeklyReport(accounts, referrals);

  // CC300 tops the leaderboard and was referred by AA100.
  const overlap = report.paidAndReferred.find(entry => entry.account === 'CC300');
  assert.ok(overlap, 'CC300 should appear in the overlap');
  assert.strictEqual(overlap.referrer, 'AA100');
  assert.ok(overlap.bonus > 0);
});

test('the overlap is empty when no paid account was referred', () => {
  const { accounts } = load([PERIODIC]);      // no ledger, so no referral edges
  const report = buildWeeklyReport(accounts, []);
  assert.deepStrictEqual(report.paidAndReferred, []);
});

test('the payload carries the leaderboard and the referral figures together', () => {
  const { accounts, referrals } = load([PERIODIC, LEDGER]);
  const payload = toWeeklyPayload(buildWeeklyReport(accounts, referrals), WEEK);

  assert.strictEqual(payload.week_end, '09-06-2026');
  assert.ok(Array.isArray(payload.bonuses), 'the leaderboard payload is preserved');
  assert.strictEqual(payload.threshold_basis, 'total_pnl');
  assert.strictEqual(payload.referrals.referrers, 1);
  assert.strictEqual(payload.referrals.commission_rate, 0.20);
  assert.ok(Array.isArray(payload.referrals.payable));
});

test('only referrers actually owed money appear in the payable list', () => {
  const accounts = new Map([
    ['R1', { player: 'R1', key: 'R1', pnl: 0,    volume: 0, betTypes: {} }],
    ['C1', { player: 'C1', key: 'C1', pnl: -500, volume: 0, betTypes: { PreMatch: -500 } }],
    ['R2', { player: 'R2', key: 'R2', pnl: 0,    volume: 0, betTypes: {} }],
    ['C2', { player: 'C2', key: 'C2', pnl:  500, volume: 0, betTypes: { PreMatch:  500 } }],
  ]);
  const edges = [
    { referrer: 'R1', referrerKey: 'R1', referred: 'C1', referredKey: 'C1', bonusPaid: 0 },
    { referrer: 'R2', referrerKey: 'R2', referred: 'C2', referredKey: 'C2', bonusPaid: 0 },
  ];
  const payload = toWeeklyPayload(buildWeeklyReport(accounts, edges, { bonus: { minEligible: 2 } }), WEEK);

  assert.strictEqual(payload.referrals.payable.length, 1, 'R2 is owed nothing');
  assert.strictEqual(payload.referrals.payable[0].referrer, 'R1');
  assert.strictEqual(payload.referrals.payable[0].commission, 100);
  assert.strictEqual(payload.referrals.total_commission, 100);
});

test('report options reach each half independently', () => {
  const { accounts, referrals } = load([PERIODIC, LEDGER]);
  const report = buildWeeklyReport(accounts, referrals, {
    bonus:    { pool: 1000, minEligible: 2 },
    referral: { commissionRate: 0.5 },
  });
  assert.strictEqual(report.bonus.config.pool, 1000);
  assert.strictEqual(report.bonus.eligibleCount, 2);
  assert.strictEqual(report.referral.config.commissionRate, 0.5);
});
