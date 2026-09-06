'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  num, parseDate, fmtDate,
  parseTransactions, aggregatePlayers, parseReferrals, weekRange,
} = require('../lib/ledger');

const row = (over = {}) => ({
  Player: 'P1', Type: 'Wager Placed', ID: '1', Credit: '', Debit: '-10',
  'Final Balance': '0', Date: '09/01/26', Details: '', Agent: 'AG', ...over,
});

test('parses money with commas, currency symbols and accounting negatives', () => {
  assert.strictEqual(num('1,234.56'), 1234.56);
  assert.strictEqual(num('$50'), 50);
  assert.strictEqual(num('-25'), -25);
  assert.strictEqual(num('(12.34)'), -12.34);
  assert.strictEqual(num(''), 0);
  assert.strictEqual(num('n/a'), 0);
});

test('reads the export MM/DD/YY date format', () => {
  assert.strictEqual(fmtDate(parseDate('09/06/26')), '09-06-2026');
  assert.strictEqual(fmtDate(parseDate('12/31/25')), '12-31-2025');
  assert.strictEqual(parseDate('not a date'), null);
});

test('skips total and repeated-header rows', () => {
  const txs = parseTransactions([
    row(), row({ Player: 'Total' }), row({ Player: 'Accounts' }), row({ Player: '' }),
  ]);
  assert.strictEqual(txs.length, 1);
});

test('volume counts wagers placed only', () => {
  const players = aggregatePlayers(parseTransactions([
    row({ Debit: '-100' }),
    row({ Debit: '-50' }),
    row({ Type: 'Wager Graded', Debit: '', Credit: '120' }),
    row({ Type: 'Promotional Credit', Debit: '', Credit: '50' }),
    row({ Type: 'Credit Adjustment', Debit: '', Credit: '26' }),
    row({ Type: 'Balance Carryover', Debit: '', Credit: '0.17' }),
    row({ Type: 'Withdrawal (Processor)', Debit: '0', Credit: '' }),
  ]));
  const p = players.get('P1');
  assert.strictEqual(p.volume, 150, 'only the two wagers count toward volume');
  assert.strictEqual(p.bets, 2);
});

test('p&l is payouts minus stakes; promo credits do not affect it', () => {
  const players = aggregatePlayers(parseTransactions([
    row({ Debit: '-100' }),
    row({ Type: 'Wager Graded', Debit: '', Credit: '40' }),
    row({ Type: 'Promotional Credit', Debit: '', Credit: '500' }),
  ]));
  // Staked 100, returned 40 → house won 60, so p&l is negative.
  assert.strictEqual(players.get('P1').pnl, -60);
});

test('a winning player produces positive p&l', () => {
  const players = aggregatePlayers(parseTransactions([
    row({ Debit: '-100' }),
    row({ Type: 'Wager Graded', Debit: '', Credit: '250' }),
  ]));
  assert.strictEqual(players.get('P1').pnl, 150);
});

test('account keys collapse case and whitespace variants', () => {
  const players = aggregatePlayers(parseTransactions([
    row({ Player: 'gd070', Debit: '-10' }),
    row({ Player: ' GD070 ', Debit: '-15' }),
  ]));
  assert.strictEqual(players.size, 1);
  assert.strictEqual(players.get('GD070').volume, 25);
});

test('referral edges point from the referrer to each client they referred', () => {
  const edges = parseReferrals(parseTransactions([
    row({ Player: 'GD070', Type: 'Promotional Credit', Debit: '', Credit: '50', Details: 'Referred BTCB50 ' }),
    row({ Player: 'GD070', Type: 'Credit Adjustment', Debit: '', Credit: '26', Details: 'Referred BTCB51' }),
  ]));
  assert.strictEqual(edges.length, 2);
  assert.deepStrictEqual(edges.map(e => e.referred), ['BTCB50', 'BTCB51']);
  for (const edge of edges) assert.strictEqual(edge.referrer, 'GD070');
});

test('ignores details that are not referral notes', () => {
  const edges = parseReferrals(parseTransactions([
    row({ Details: 'Approval of $121.00 has been rejected at 09/05/26 14:32:31. Currency: LTC' }),
    row({ Details: '' }),
  ]));
  assert.strictEqual(edges.length, 0);
});

test('the same referral appearing twice yields one edge', () => {
  const edges = parseReferrals(parseTransactions([
    row({ Player: 'A', Details: 'Referred BTCB50' }),
    row({ Player: 'A', Details: 'Referred BTCB50' }),
  ]));
  assert.strictEqual(edges.length, 1);
});

test('the week ends on the latest transaction and runs back six days', () => {
  const week = weekRange(parseTransactions([
    row({ Date: '09/01/26' }), row({ Date: '09/06/26' }), row({ Date: '09/04/26' }),
  ]));
  assert.strictEqual(week.weekEnd, '09-06-2026');
  assert.strictEqual(week.weekStart, '08-31-2026');
});

test('throws a clear error when the export has no player column', () => {
  assert.throws(() => parseTransactions([{ Foo: 'bar', Type: 'Wager Placed' }]), /player\/account column/);
});
