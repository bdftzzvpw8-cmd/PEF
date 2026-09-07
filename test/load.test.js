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

test('an account left with nothing after exclusion drops out of the leaderboard', () => {
  const { buildBonusReport } = require('../lib/bonus');
  const { accounts } = load([PERIODIC]);
  const report = buildBonusReport(accounts, { basis: 'total_pnl' });
  // BB200 is casino-only in the fixture.
  assert.ok(report.inactive.some(a => a.account === 'BB200'));
  assert.ok(!report.eligible.some(a => a.account === 'BB200'));
});

test('the merge reports what the exclusion removed', () => {
  const result = load([PERIODIC]);
  assert.deepStrictEqual(result.exclude, ['Betsoft', 'TFUSION', 'PLAYGLOBE']);
  assert.strictEqual(result.excludedTotal, 100);
  assert.strictEqual(result.excludedAccounts, 1);
});

test('includeExcluded restores the casino figures', () => {
  const result = load([PERIODIC], { includeExcluded: true });
  assert.deepStrictEqual(result.exclude, []);
  assert.strictEqual(result.accounts.get('BB200').pnl, 100);
});

test('the player roster is told apart from the transaction ledger', () => {
  // Both have a Player column; only the ledger describes transactions.
  const roster = [{ Agent: 'A', 'Player Id': '1', Player: 'P1', Email: 'a@b.c',
                    'Creation Time': '07/27/26 18:33:04', 'Current Balance': '0' }];
  assert.strictEqual(classify(roster), 'roster');
  assert.strictEqual(classify([{ Player: 'P1', Type: 'Wager Placed', Debit: '-10' }]), 'ledger');
});

test('a roster is skipped with an explanation instead of crashing', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const file = path.join(os.tmpdir(), `roster-${process.pid}.csv`);
  fs.writeFileSync(file,
    '"Agent","Player Id","Player","Email","Creation Time","Current Balance"\n'
    + '"AGENTA","1","AA100","a@b.c","07/27/26 18:33:04","0"\n');
  try {
    const result = load([PERIODIC, file]);
    assert.strictEqual(result.seen.roster, 1);
    assert.strictEqual(result.seen.periodic, 1);
    assert.ok(result.warnings.some(w => /player roster/.test(w)));
    // The periodic file still loaded normally alongside it.
    assert.ok(result.accounts.get('AA100').sources.includes('periodic'));
  } finally {
    fs.unlinkSync(file);
  }
});
