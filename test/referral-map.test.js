'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { parseReferralMap, looksLikeReferralMap } = require('../lib/referral-map');
const { readFile } = require('../lib/sheet');
const { load, classify } = require('../lib/load');

const rows = list => list.map(([referrer, referred]) => ({ referrer, referred }));

test('a referral list is recognised by its columns', () => {
  assert.ok(looksLikeReferralMap(rows([['A1', 'B1']])));
  assert.strictEqual(classify(rows([['A1', 'B1']])), 'referral-map');
  assert.ok(!looksLikeReferralMap([{ Player: 'A1', Risk: '10' }]));
});

test('relationships become edges in the shared shape', () => {
  const { edges } = parseReferralMap(rows([['GD070', 'BTCB50'], ['GD070', 'BTCB51']]));
  assert.strictEqual(edges.length, 2);
  assert.ok(edges.every(e => e.referrer === 'GD070'));
  assert.deepStrictEqual(edges.map(e => e.referredKey), ['BTCB50', 'BTCB51']);
});

test('codes match regardless of case', () => {
  const { edges } = parseReferralMap(rows([['gd070', ' btcb50 ']]));
  assert.strictEqual(edges[0].referrerKey, 'GD070');
  assert.strictEqual(edges[0].referredKey, 'BTCB50');
});

test('a half-filled row is reported, not half-applied', () => {
  const { edges, problems } = parseReferralMap(rows([['GD070', ''], ['', 'BTCB50']]));
  assert.deepStrictEqual(edges, []);
  assert.strictEqual(problems.length, 2);
  assert.ok(problems[0].includes('row 2'), 'the row number should locate the problem');
});

test('self-referral is refused', () => {
  const { edges, problems } = parseReferralMap(rows([['GD070', 'gd070']]));
  assert.deepStrictEqual(edges, []);
  assert.ok(problems[0].includes('cannot refer itself'));
});

test('an exact duplicate is dropped once and reported', () => {
  const { edges, problems } = parseReferralMap(rows([['A1', 'B1'], ['A1', 'B1']]));
  assert.strictEqual(edges.length, 1);
  assert.ok(problems.some(p => /more than once/.test(p)));
});

test('one client under two referrers is flagged as a double payment', () => {
  const { edges, problems } = parseReferralMap(rows([['A1', 'C1'], ['B1', 'C1']]));
  assert.strictEqual(edges.length, 2, 'both are kept so the conflict is visible');
  assert.ok(problems.some(p => /two referrers/.test(p) && /paid twice/.test(p)));
});

test('a list missing its columns is rejected with a usable message', () => {
  assert.throws(() => parseReferralMap([{ foo: 'A1', bar: 'B1' }]),
    /needs a "referrer" column and a "referred" column/);
});

test('the maintained list in the repo parses cleanly', () => {
  const file = path.join(__dirname, '..', 'data', 'referrals.csv');
  const { edges, problems } = parseReferralMap(readFile(file));
  assert.deepStrictEqual(problems, [], 'the committed list should have no problems');
  assert.ok(edges.length > 0);
  for (const edge of edges) {
    assert.ok(edge.referrer && edge.referred);
    assert.notStrictEqual(edge.referrerKey, edge.referredKey);
  }
});

test('comment lines in the list are not read as data', () => {
  const { parseCsv, toObjects, dropComments } = require('../lib/sheet');
  const parsed = toObjects(dropComments(parseCsv(
    '# who referred whom\n# second comment\nreferrer,referred\nGD070,BTCB50\n')));
  assert.deepStrictEqual(Object.keys(parsed[0]).sort(), ['referred', 'referrer']);
  assert.strictEqual(parsed.length, 1);
});

test('seeded relationships reach the report and merge with file-borne ones', () => {
  const fs = require('node:fs'), os = require('node:os');
  const periodic = path.join(__dirname, 'fixtures', 'periodic-sample.csv');
  const listFile = path.join(os.tmpdir(), `reflist-${process.pid}.csv`);
  fs.writeFileSync(listFile, 'referrer,referred\nAA100,FF600\n');
  try {
    const seeded = parseReferralMap(rows([['AA100', 'CC300']])).edges;
    const result = load([periodic, listFile], { referrals: seeded });
    assert.strictEqual(result.seen.referralMap, 1);
    assert.strictEqual(result.accounts.get('CC300').referredBy, 'AA100', 'from the seed');
    assert.strictEqual(result.accounts.get('FF600').referredBy, 'AA100', 'from the file');
  } finally {
    fs.unlinkSync(listFile);
  }
});
