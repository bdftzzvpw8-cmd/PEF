'use strict';
// Merging the two export shapes into one view of the week.
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { load, classify } = require('../lib/load');
const { readFile } = require('../lib/sheet');

const LEDGER   = path.join(__dirname, 'fixtures', 'ledger-sample.csv');
const PERIODIC = path.join(__dirname, 'fixtures', 'periodic-sample.csv');

test('each export shape is recognised from its columns', () => {
  assert.strictEqual(classify(readFile(PERIODIC)), 'periodic');
  assert.strictEqual(classify(readFile(LEDGER)), 'ledger');
  assert.strictEqual(classify([{ Foo: 'bar' }]), 'unknown');
});

test('volume comes from the ledger and bet-type p&l from the periodic summary', () => {
  const { accounts } = load([PERIODIC, LEDGER]);
  const aa = accounts.get('AA100');
  assert.deepStrictEqual(aa.sources.sort(), ['ledger', 'periodic']);
  assert.strictEqual(aa.volume, 100, 'volume is only in the ledger');
  assert.strictEqual(aa.byCategory.sports, 30, 'bet-type split is only in the periodic file');
});

test('the periodic p&l wins over the ledger, which sees only graded bets', () => {
  const { accounts } = load([PERIODIC, LEDGER]);
  const aa = accounts.get('AA100');
  assert.strictEqual(aa.periodicPnl, 18.5);
  assert.strictEqual(aa.ledgerPnl, -60);
  assert.strictEqual(aa.pnl, 18.5, 'the full-week figure is authoritative');
});

test('order of files does not change the result', () => {
  const a = load([PERIODIC, LEDGER]).accounts.get('AA100');
  const b = load([LEDGER, PERIODIC]).accounts.get('AA100');
  assert.strictEqual(a.pnl, b.pnl);
  assert.strictEqual(a.volume, b.volume);
});

test('the ledger p&l is used when there is no periodic figure', () => {
  const { accounts } = load([LEDGER]);
  assert.strictEqual(accounts.get('AA100').pnl, -60);
  assert.strictEqual(accounts.get('AA100').periodicPnl, null);
});

test('referral edges survive the merge and resolve against periodic accounts', () => {
  const { accounts, referrals } = load([PERIODIC, LEDGER]);
  assert.strictEqual(referrals.length, 2);
  for (const edge of referrals) assert.ok(accounts.has(edge.referredKey));
});

test('flags accounts that have p&l but no volume, without overstating the effect', () => {
  const { warnings } = load([PERIODIC]);
  const warning = warnings.find(w => /no wagering volume/.test(w));
  assert.ok(warning, 'the volume gap should be reported');
  assert.ok(/rank normally on P&L/.test(warning),
    'a P&L-ranked board is unaffected, so the warning must not claim exclusion');
});

test('warns when only a ledger is supplied', () => {
  const { warnings } = load([LEDGER]);
  assert.ok(warnings.some(w => /No periodic summary/.test(w)));
});

test('the week is taken from whichever export supplies one', () => {
  assert.strictEqual(load([PERIODIC]).week.weekStart, '08-31-2026');
  assert.strictEqual(load([LEDGER]).week.weekEnd, '09-06-2026');
});
