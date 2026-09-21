'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { parseWagers, isCasino, isVoid } = require('../lib/wagers');

const bet = (over = {}) => ({
  Status: 'Loss', 'Place Time': '09/14/26 10:00:00', Agent: 'AG', Player: 'P1',
  'Wager #': '1', Details: 'KC Chiefs -5.5 +174', Risk: '100', 'To Win': '57', Result: '-100',
  ...over,
});

test('casino bets are recognised from the bet details', () => {
  assert.ok(isCasino('Table / American Blackjack'));
  assert.ok(isCasino('  Table / Roulette'));
  assert.ok(!isCasino('KC Chiefs -5.5 +174'));
  // A tennis match reads "Player A / Player B" — a slash alone is not casino.
  assert.ok(!isCasino('Francisca Jorge / Matilde Jorge'));
});

test('cancelled and voided bets are identified', () => {
  assert.ok(isVoid('Cancel'));
  assert.ok(isVoid('  voided '));
  assert.ok(!isVoid('Loss'));
  assert.ok(!isVoid('Push'));
});

test('volume is the stake, and p&l the settled result', () => {
  const { players } = parseWagers([
    bet({ Risk: '100', Result: '-100' }),
    bet({ Risk: '50', Status: 'Win', Result: '75' }),
  ]);
  const p = players.get('P1');
  assert.strictEqual(p.volume, 150, 'both stakes count as volume');
  assert.strictEqual(p.wagersPnl, -25, 'lost 100, won 75');
  assert.strictEqual(p.bets, 2);
});

test('a cancelled bet is not volume', () => {
  const { players, voided } = parseWagers([
    bet({ Risk: '100' }),
    bet({ Risk: '999', Status: 'Cancel', Result: '0' }),
  ]);
  assert.strictEqual(players.get('P1').volume, 100);
  assert.strictEqual(players.get('P1').voidedBets, 1);
  assert.strictEqual(voided, 1);
});

test('a push counts as volume but moves no money', () => {
  const { players } = parseWagers([bet({ Risk: '80', Status: 'Push', Result: '0' })]);
  assert.strictEqual(players.get('P1').volume, 80);
  assert.strictEqual(players.get('P1').wagersPnl, 0);
});

test('casino stakes are held separately and left out of volume', () => {
  const { players } = parseWagers([
    bet({ Risk: '100' }),
    bet({ Risk: '40', Details: 'Table / American Blackjack', Result: '-40' }),
  ]);
  const p = players.get('P1');
  assert.strictEqual(p.volume, 100, 'only the sportsbook stake counts');
  assert.strictEqual(p.casinoVolume, 40);
  assert.strictEqual(p.casinoPnl, -40);
});

test('casino can be kept in when asked', () => {
  const { players } = parseWagers([
    bet({ Risk: '100' }),
    bet({ Risk: '40', Details: 'Table / American Blackjack', Result: '-40' }),
  ], { excludeCasino: false });
  assert.strictEqual(players.get('P1').volume, 140);
  assert.strictEqual(players.get('P1').casinoBets, 1, 'still counted, just not excluded');
});

test('the week spans the first and last bet placed', () => {
  const { week } = parseWagers([
    bet({ 'Place Time': '09/14/26 23:40:20' }),
    bet({ 'Place Time': '09/20/26 01:02:03' }),
    bet({ 'Place Time': '09/17/26 12:00:00' }),
  ]);
  assert.strictEqual(week.weekStart, '09-14-2026');
  assert.strictEqual(week.weekEnd, '09-20-2026');
});

test('accounts are keyed case-insensitively', () => {
  const { players } = parseWagers([
    bet({ Player: 'btcb1', Risk: '10' }),
    bet({ Player: ' BTCB1 ', Risk: '15' }),
  ]);
  assert.strictEqual(players.size, 1);
  assert.strictEqual(players.get('BTCB1').volume, 25);
});

test('a file without a stake column is rejected rather than read as zero volume', () => {
  assert.throws(() => parseWagers([{ Player: 'P1', Status: 'Loss' }]), /risk\/stake column/);
});
