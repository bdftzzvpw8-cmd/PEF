'use strict';
// Reads the wagers export — one row per bet, with the stake in `Risk` and the
// settled outcome in `Result`.
//
// This is the only export that carries real wagering volume. The periodic
// summary reports P&L alone, so a client who churns a large stake to a near-zero
// net is invisible there; here they are exactly what they are.

const { num, parseDate, fmtDate, findColumn } = require('./ledger');

// Casino bets are named directly in the details rather than inferred from a
// provider name. Only the table-games prefix appears in the data so far, so
// anything unrecognised is treated as sportsbook and reported, rather than
// being quietly swept into casino.
const CASINO_DETAIL_PATTERNS = [/^\s*Table\s*\//i, /^\s*Slots?\s*\//i];

// A cancelled bet never stood, so it is not volume.
const VOID_STATUSES = new Set(['cancel', 'cancelled', 'canceled', 'void', 'voided']);

const COLUMNS = {
  player:  ['player', 'customer', 'account'],
  agent:   ['agent'],
  status:  ['status'],
  placed:  ['place time', 'placed', 'date'],
  details: ['details', 'detail', 'description'],
  risk:    ['risk', 'stake', 'wagered'],
  toWin:   ['to win', 'towin', 'win amount'],
  result:  ['result', 'win/loss', 'outcome'],
  id:      ['wager #', 'wager', 'ticket', 'id'],
};

function isCasino(details) {
  return CASINO_DETAIL_PATTERNS.some(pattern => pattern.test(String(details ?? '')));
}

function isVoid(status) {
  return VOID_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

// `Place Time` is "MM/DD/YY HH:MM:SS"; only the date part matters here.
function placedDate(value) {
  const text = String(value ?? '').trim();
  return parseDate(text.split(/[\sT]/)[0]) ;
}

function parseWagers(rows, options = {}) {
  const excludeCasino = options.excludeCasino !== false;
  if (!rows.length) return { players: new Map(), week: null, bets: 0 };

  const cols = {};
  for (const [key, names] of Object.entries(COLUMNS)) cols[key] = findColumn(rows[0], names);
  if (!cols.player) throw new Error('No player column found in the wagers export');
  if (!cols.risk)   throw new Error('No risk/stake column found in the wagers export');

  const players = new Map();
  const dates = [];
  let counted = 0, voided = 0, casinoBets = 0;

  for (const row of rows) {
    const name = String(row[cols.player] ?? '').trim();
    if (!name) continue;

    const key = name.toUpperCase();
    let rec = players.get(key);
    if (!rec) {
      rec = {
        player: name, key,
        agent: cols.agent ? String(row[cols.agent] ?? '').trim() || null : null,
        volume: 0, wagersPnl: 0, bets: 0,
        casinoVolume: 0, casinoPnl: 0, casinoBets: 0,
        voidedBets: 0,
      };
      players.set(key, rec);
    }

    const date = cols.placed ? placedDate(row[cols.placed]) : null;
    if (date) dates.push(date);

    if (isVoid(cols.status ? row[cols.status] : '')) { rec.voidedBets++; voided++; continue; }

    const risk   = Math.abs(num(row[cols.risk]));
    const result = cols.result ? num(row[cols.result]) : 0;

    if (excludeCasino && isCasino(cols.details ? row[cols.details] : '')) {
      rec.casinoVolume += risk;
      rec.casinoPnl    += result;
      rec.casinoBets   += 1;
      casinoBets++;
      continue;
    }
    if (isCasino(cols.details ? row[cols.details] : '')) { casinoBets++; rec.casinoBets += 1; }

    rec.volume    += risk;
    rec.wagersPnl += result;
    rec.bets      += 1;
    counted++;
  }

  const week = dates.length ? (() => {
    const end   = new Date(Math.max(...dates.map(d => d.getTime())));
    const start = new Date(Math.min(...dates.map(d => d.getTime())));
    return { start, end, weekStart: fmtDate(start), weekEnd: fmtDate(end) };
  })() : null;

  return { players, week, bets: rows.length, counted, voided, casinoBets };
}

module.exports = { CASINO_DETAIL_PATTERNS, VOID_STATUSES, isCasino, isVoid, parseWagers };
