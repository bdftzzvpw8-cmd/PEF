'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { readFile } = require('../lib/sheet');
const { parsePeriodic, verifyPeriodic, categoryOf, parseWeekHeader } = require('../lib/periodic');

const FIXTURE = path.join(__dirname, 'fixtures', 'periodic-sample.csv');
const rows = () => readFile(FIXTURE);

test('bet types map onto the reporting categories', () => {
  assert.strictEqual(categoryOf('PreMatch'), 'sports');
  assert.strictEqual(categoryOf('InPlay'), 'live');
  assert.strictEqual(categoryOf('Betsoft'), 'casino');
  assert.strictEqual(categoryOf('TFUSION'), 'casino');
  assert.strictEqual(categoryOf('PLAYGLOBE'), 'casino');
  assert.strictEqual(categoryOf('SomethingNew'), 'other');
});

test('the week comes from the amount column header', () => {
  const week = parseWeekHeader('08/31/26 - 09/06/26');
  assert.strictEqual(week.weekStart, '08-31-2026');
  assert.strictEqual(week.weekEnd, '09-06-2026');
});

test('the duplicate rows that follow each bet-type row are ignored', () => {
  const { accounts } = parsePeriodic(rows());
  // AA100 has PreMatch 30.00 and InPlay -11.50. Counting the duplicate rows
  // would double both.
  assert.strictEqual(accounts.get('AA100').byCategory.sports, 30);
  assert.strictEqual(accounts.get('AA100').byCategory.live, -11.5);
});

test('p&l is read from Total, not the negated week column', () => {
  const { accounts } = parsePeriodic(rows());
  assert.strictEqual(accounts.get('AA100').pnl, 18.5);
  assert.strictEqual(accounts.get('CC300').pnl, -400);
});

test('bet-type figures sum to the account figure', () => {
  const { accounts } = parsePeriodic(rows());
  for (const rec of accounts.values()) {
    const summed = Object.values(rec.byCategory).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(summed - rec.pnl) < 0.01, `${rec.account}: ${summed} vs ${rec.pnl}`);
  }
});

test('the inflated pending and end balance are corrected, and the original kept', () => {
  const { accounts } = parsePeriodic(rows());
  const aa = accounts.get('AA100');
  // Two bet-type rows each repeat 5.00 / 25, which the grid sums into 10.00 / 50.
  assert.strictEqual(aa.endBalance, 5);
  assert.strictEqual(aa.endBalanceReported, 10);
  assert.strictEqual(aa.pending, 25);
  assert.strictEqual(aa.pendingReported, 0, 'the account row understated pending as 0');
});

test('accounts carry their agent group', () => {
  const { accounts, groups } = parsePeriodic(rows());
  assert.strictEqual(accounts.get('AA100').group, 'AGENTA');
  assert.strictEqual(accounts.get('CC300').group, 'AGENTB');
  assert.deepStrictEqual(groups.sort(), ['AGENTA', 'AGENTB']);
});

test('a well-formed export raises no issues', () => {
  assert.deepStrictEqual(verifyPeriodic(rows()), []);
});

test('verification catches a flipped sign convention', () => {
  const broken = rows().map(r => ({ ...r }));
  const target = broken.find(r => r.Group.includes('AA100 -> PreMatch'));
  target['08/31/26 - 09/06/26'] = '999';   // no longer the negated Total
  const issues = verifyPeriodic(broken);
  assert.ok(issues.some(i => /sign convention/.test(i)), issues.join('; '));
});

test('verification catches bet-type rows that stop summing to the account', () => {
  const broken = rows().map(r => ({ ...r }));
  const target = broken.find(r => r.Group.includes('AA100 -> PreMatch'));
  target.Total = '999';
  target['08/31/26 - 09/06/26'] = '-999';  // keep the sign check happy
  assert.ok(verifyPeriodic(broken).some(i => /but the account row says/.test(i)));
});
