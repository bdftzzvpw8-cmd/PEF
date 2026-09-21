'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { hasNotes, parseRosterReferrals } = require('../lib/roster');
const { load } = require('../lib/load');

const row = (player, note) => ({
  Agent: 'AG', 'Player Id': '1', Player: player, Email: 'a@b.c',
  'Creation Time': '07/27/26 18:33:04', 'Player Notes': note,
});

test('a roster without a notes column carries no referral data', () => {
  const rows = [{ Agent: 'AG', 'Player Id': '1', Player: 'P1', Email: 'a@b.c',
                  'Creation Time': '07/27/26 18:33:04' }];
  assert.strictEqual(hasNotes(rows), false);
  assert.deepStrictEqual(parseRosterReferrals(rows).edges, []);
});

test('"Referred X" makes this account the referrer', () => {
  const { edges } = parseRosterReferrals([row('GD070', 'Referred BTCB50')]);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].referrer, 'GD070');
  assert.strictEqual(edges[0].referred, 'BTCB50');
});

test('"Referred by X" reverses the direction', () => {
  const { edges } = parseRosterReferrals([row('BTCB50', 'Referred by GD070')]);
  assert.strictEqual(edges[0].referrer, 'GD070');
  assert.strictEqual(edges[0].referred, 'BTCB50',
    'the account named in the note is the referrer, not the referred');
});

test('"by" is never mistaken for the referral code', () => {
  const { edges } = parseRosterReferrals([row('BTCB1', 'Referred by BTCB2')]);
  assert.strictEqual(edges[0].referrer, 'BTCB2');
  assert.ok(!edges.some(e => e.referred === 'by' || e.referrer === 'by'));
});

test('one account can refer several clients from one note', () => {
  const { edges } = parseRosterReferrals([row('GD070', 'Referred BTCB1, Referred BTCB2')]);
  assert.deepStrictEqual(edges.map(e => e.referred), ['BTCB1', 'BTCB2']);
  assert.ok(edges.every(e => e.referrer === 'GD070'));
});

test('an ordinary note produces nothing and is not flagged', () => {
  const { edges, unparsed } = parseRosterReferrals([row('GD070', 'VIP customer, call before payout')]);
  assert.deepStrictEqual(edges, []);
  assert.deepStrictEqual(unparsed, []);
});

test('a referral-shaped note that will not parse is surfaced, not dropped', () => {
  const { edges, unparsed } = parseRosterReferrals([row('GD070', 'referral - ask Dave')]);
  assert.deepStrictEqual(edges, []);
  assert.strictEqual(unparsed.length, 1, 'guessing here would invert a payout');
  assert.strictEqual(unparsed[0].account, 'GD070');
});

test('self-referral and duplicates are ignored', () => {
  const { edges } = parseRosterReferrals([
    row('BTCB1', 'Referred BTCB1'),        // itself
    row('BTCB2', 'Referred BTCB9'),
    row('BTCB3', 'Referred BTCB9'),        // same client, different referrer
    row('BTCB2', 'Referred BTCB9'),        // exact repeat
  ]);
  assert.strictEqual(edges.length, 2, 'the self-referral and the repeat are dropped');
  assert.ok(!edges.some(e => e.referrerKey === e.referredKey));
  assert.deepStrictEqual(edges.map(e => e.referrer), ['BTCB2', 'BTCB3']);
});

test('a one-character code is not read as a referral', () => {
  // Real account codes are never a single character, and matching them would
  // turn stray words in a note into payouts.
  const { edges } = parseRosterReferrals([row('GD070', 'Referred X')]);
  assert.deepStrictEqual(edges, []);
});

test('roster referrals reach the merged report', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const file = path.join(os.tmpdir(), `roster-notes-${process.pid}.csv`);
  fs.writeFileSync(file,
    '"Agent","Player Id","Player","Email","Creation Time","Player Notes"\n'
    + '"AGENTA","1","AA100","a@b.c","07/27/26 18:33:04","Referred CC300"\n');
  try {
    const periodic = path.join(__dirname, 'fixtures', 'periodic-sample.csv');
    const result = load([periodic, file]);
    assert.strictEqual(result.seen.rosterReferrals, 1);
    assert.strictEqual(result.accounts.get('CC300').referredBy, 'AA100');
  } finally {
    fs.unlinkSync(file);
  }
});

test('a roster with no notes column says how to fix the export', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const file = path.join(os.tmpdir(), `roster-plain-${process.pid}.csv`);
  fs.writeFileSync(file,
    '"Agent","Player Id","Player","Email","Creation Time"\n'
    + '"AGENTA","1","AA100","a@b.c","07/27/26 18:33:04"\n');
  try {
    const warning = load([file]).warnings.find(w => /no notes column/.test(w));
    assert.ok(warning);
    assert.ok(/Add the notes column to the export/.test(warning));
  } finally {
    fs.unlinkSync(file);
  }
});
