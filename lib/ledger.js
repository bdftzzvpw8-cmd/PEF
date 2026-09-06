'use strict';
// Normalizes the platform's transaction ledger into per-player totals and
// referral edges. The ledger is one row per event; everything downstream works
// off the aggregates this produces.

const TX = {
  WAGER_PLACED:  'Wager Placed',
  WAGER_GRADED:  'Wager Graded',
  CREDIT_ADJUST: 'Credit Adjustment',
  PROMO_CREDIT:  'Promotional Credit',
  CARRYOVER:     'Balance Carryover',
  WITHDRAWAL:    'Withdrawal (Processor)',
};

// Only wagers move volume or P&L. Promotional credits, manual adjustments,
// carryover balances and withdrawals are deliberately excluded — a referrer's
// commission is calculated on their clients' betting losses alone.
const VOLUME_TYPES = new Set([TX.WAGER_PLACED]);
const PNL_TYPES    = new Set([TX.WAGER_PLACED, TX.WAGER_GRADED]);

// Rows whose account column holds a total or a repeated header rather than a
// real player.
const SKIP_ACCOUNTS = new Set([
  'total', 'totals', 'grand total', 'subtotal',
  'account', 'accounts', 'player', 'customer',
]);

function cleanStr(v) { return String(v ?? '').trim(); }

function num(v) {
  if (typeof v === 'number') return v;
  const s = cleanStr(v).replace(/[$,\s]/g, '');
  if (!s) return 0;
  // Accounting-style negatives: (12.34)
  const parenthesized = /^\((.*)\)$/.exec(s);
  const n = parseFloat(parenthesized ? parenthesized[1] : s);
  if (!Number.isFinite(n)) return 0;
  return parenthesized ? -n : n;
}

// The export writes dates as MM/DD/YY. Returns a Date at UTC midnight, or null.
function parseDate(v) {
  const s = cleanStr(v);
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2])));
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return null;
}

function fmtDate(d) {
  if (!d) return null;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}-${d.getUTCFullYear()}`;
}

// Case-insensitive header lookup: exact match first, then substring, so the
// report survives minor relabelling in the export.
function findColumn(row, candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const hit = keys.find(k => k.toLowerCase().trim() === c.toLowerCase());
    if (hit) return hit;
  }
  for (const c of candidates) {
    const hit = keys.find(k => k.toLowerCase().includes(c.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

const COLUMNS = {
  player:  ['player', 'customer', 'account', 'username', 'client'],
  type:    ['type', 'transaction type'],
  credit:  ['credit'],
  debit:   ['debit'],
  date:    ['date'],
  details: ['details', 'detail', 'notes', 'description'],
  agent:   ['agent'],
  id:      ['id', 'transaction id'],
};

// Flattens raw export rows (from one or many files) into normalized
// transactions. Rows without a recognisable player are dropped.
function parseTransactions(rows) {
  if (!rows.length) return [];
  const cols = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    cols[key] = findColumn(rows[0], names);
  }
  if (!cols.player) throw new Error('No player/account column found in export');
  if (!cols.type)   throw new Error('No transaction type column found in export');

  const out = [];
  for (const row of rows) {
    const player = cleanStr(row[cols.player]);
    if (!player || SKIP_ACCOUNTS.has(player.toLowerCase())) continue;
    out.push({
      player,
      key:     player.toUpperCase(),
      type:    cleanStr(row[cols.type]),
      credit:  cols.credit  ? num(row[cols.credit]) : 0,
      debit:   cols.debit   ? num(row[cols.debit])  : 0,
      date:    cols.date    ? parseDate(row[cols.date]) : null,
      details: cols.details ? cleanStr(row[cols.details]) : '',
      agent:   cols.agent   ? cleanStr(row[cols.agent]) : '',
      id:      cols.id      ? cleanStr(row[cols.id]) : '',
    });
  }
  return out;
}

// Per-player betting totals.
//   volume = total staked
//   pnl    = payouts - stakes, from the house's point of view:
//            negative means the house won and commission may be owed.
function aggregatePlayers(transactions) {
  const players = new Map();

  for (const tx of transactions) {
    let rec = players.get(tx.key);
    if (!rec) {
      rec = {
        player: tx.player, key: tx.key, agent: tx.agent || null,
        volume: 0, staked: 0, returned: 0, pnl: 0,
        bets: 0, firstDate: null, lastDate: null,
      };
      players.set(tx.key, rec);
    }
    if (!rec.agent && tx.agent) rec.agent = tx.agent;

    if (tx.date) {
      if (!rec.firstDate || tx.date < rec.firstDate) rec.firstDate = tx.date;
      if (!rec.lastDate  || tx.date > rec.lastDate)  rec.lastDate  = tx.date;
    }

    if (VOLUME_TYPES.has(tx.type)) {
      rec.volume += Math.abs(tx.debit);
      rec.staked += Math.abs(tx.debit);
      rec.bets   += 1;
    }
    if (PNL_TYPES.has(tx.type) && tx.type === TX.WAGER_GRADED) {
      rec.returned += tx.credit;
    }
  }

  for (const rec of players.values()) rec.pnl = rec.returned - rec.staked;
  return players;
}

// Referral edges live on the referrer's own ledger: a credit row whose details
// read "Referred <CODE>". One referrer can have many such rows.
const REFERRAL_PATTERN = /^referred\s+([A-Za-z0-9_-]{2,32})\b/i;

function parseReferrals(transactions) {
  const edges = [];
  const seen  = new Set();

  for (const tx of transactions) {
    const m = REFERRAL_PATTERN.exec(tx.details);
    if (!m) continue;
    const referred = m[1].toUpperCase();
    if (referred === tx.key) continue;           // self-referral, ignore
    const dedupe = `${tx.key}->${referred}`;
    if (seen.has(dedupe)) continue;              // one edge per pair
    seen.add(dedupe);
    edges.push({
      referrer:     tx.player,
      referrerKey:  tx.key,
      referred:     m[1],
      referredKey:  referred,
      bonusPaid:    tx.credit,      // recorded for reference only
      bonusType:    tx.type,
      date:         tx.date,
    });
  }
  return edges;
}

// Reporting week, taken from the data: ends on the latest transaction date and
// runs back six days, matching how the weekly files were always cut.
function weekRange(transactions, { today = new Date() } = {}) {
  const dates = transactions.map(t => t.date).filter(Boolean);
  const end = dates.length
    ? new Date(Math.max(...dates.map(d => d.getTime())))
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - 6);
  return { start, end, weekStart: fmtDate(start), weekEnd: fmtDate(end) };
}

// One-shot: raw rows in, everything the reports need out.
function loadLedger(rows) {
  const transactions = parseTransactions(rows);
  return {
    transactions,
    players:   aggregatePlayers(transactions),
    referrals: parseReferrals(transactions),
    week:      weekRange(transactions),
  };
}

module.exports = {
  TX, VOLUME_TYPES, PNL_TYPES,
  num, parseDate, fmtDate, findColumn,
  parseTransactions, aggregatePlayers, parseReferrals, weekRange, loadLedger,
};
