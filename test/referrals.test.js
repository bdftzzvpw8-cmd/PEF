'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildReferralReport } = require('../lib/referrals');

function playerMap(entries) {
  const map = new Map();
  for (const [key, volume, pnl] of entries) {
    map.set(key, { player: key, key, agent: null, volume, pnl, bets: 1 });
  }
  return map;
}
const edge = (referrer, referred, bonusPaid = 0) => ({
  referrer, referrerKey: referrer, referred, referredKey: referred, bonusPaid,
});

test('a referrer earns 20% of their clients net losses', () => {
  const report = buildReferralReport(
    playerMap([['C1', 1000, -300], ['C2', 500, -200]]),
    [edge('R1', 'C1'), edge('R1', 'C2')],
  );
  const group = report.groups[0];
  assert.strictEqual(group.pnl, -500);
  assert.strictEqual(group.commission, 100);
});

test('a group that is net up for the player owes no commission', () => {
  const report = buildReferralReport(
    playerMap([['C1', 1000, 400]]),
    [edge('R1', 'C1')],
  );
  assert.strictEqual(report.groups[0].commission, 0);
});

test('commission nets across a group, not per client', () => {
  // One client lost 500, the other won 400 → the group is only down 100.
  const report = buildReferralReport(
    playerMap([['C1', 1000, -500], ['C2', 1000, 400]]),
    [edge('R1', 'C1'), edge('R1', 'C2')],
  );
  assert.strictEqual(report.groups[0].commission, 20);
});

test('referral bonuses already credited do not change the commission', () => {
  const withBonus = buildReferralReport(
    playerMap([['C1', 1000, -300]]), [edge('R1', 'C1', 50)],
  );
  const withoutBonus = buildReferralReport(
    playerMap([['C1', 1000, -300]]), [edge('R1', 'C1', 0)],
  );
  assert.strictEqual(withBonus.groups[0].commission, withoutBonus.groups[0].commission);
  assert.strictEqual(withBonus.groups[0].commission, 60);
});

test('one referrer can carry many clients', () => {
  const report = buildReferralReport(
    playerMap([['C1', 100, -10], ['C2', 200, -20], ['C3', 300, -30]]),
    [edge('R1', 'C1'), edge('R1', 'C2'), edge('R1', 'C3')],
  );
  assert.strictEqual(report.referrerCount, 1);
  assert.strictEqual(report.groups[0].clientCount, 3);
  assert.strictEqual(report.groups[0].commission, 12);
});

test('a referred client with no activity is listed at zero, not dropped', () => {
  const report = buildReferralReport(playerMap([]), [edge('R1', 'BTCB50')]);
  const client = report.groups[0].clients[0];
  assert.strictEqual(client.account, 'BTCB50');
  assert.strictEqual(client.volume, 0);
  assert.strictEqual(client.hasActivity, false);
  assert.strictEqual(report.groups[0].activeClientCount, 0);
});

test('referrers owed commission sort above those who are not', () => {
  const report = buildReferralReport(
    playerMap([['C1', 10_000, 500], ['C2', 100, -1000]]),
    [edge('BIG', 'C1'), edge('SMALL', 'C2')],
  );
  assert.strictEqual(report.groups[0].referrer, 'SMALL',
    'the referrer owed money leads, despite lower volume');
});

test('totals aggregate across every referrer', () => {
  const report = buildReferralReport(
    playerMap([['C1', 100, -100], ['C2', 200, -200]]),
    [edge('R1', 'C1'), edge('R2', 'C2')],
  );
  assert.strictEqual(report.referrerCount, 2);
  assert.strictEqual(report.totalVolume, 300);
  assert.strictEqual(report.totalCommission, 60);
});

test('csv subtotals the payable, which can differ from the per-client column', () => {
  const report = buildReferralReport(
    playerMap([['C1', 1000, -500], ['C2', 1000, 400]]),
    [edge('R1', 'C1'), edge('R1', 'C2')],
  );
  const lines = require('../lib/referrals').toCsv(report).split('\n');
  const subtotal = lines.find(l => l.includes('SUBTOTAL'));

  // C1 alone would suggest $100, but the group nets to -100, so only $20 is owed.
  assert.ok(lines.some(l => l.includes('"C1"') && l.includes('"100.00"')));
  assert.ok(subtotal.endsWith('"20.00"'), `payable should be 20.00, got: ${subtotal}`);
});
