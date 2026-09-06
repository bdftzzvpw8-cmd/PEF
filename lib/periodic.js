'use strict';
// Reads the periodic (weekly) summary export — the hierarchical P&L grid whose
// Group column is an indented tree:
//
//     -> BITCOINBAY                     agent group
//     -> BITCOINBAY -> BTCB50           account
//     -> BITCOINBAY -> BTCB50 -> PreMatch   bet type
//
// Unlike the transaction ledger this covers the whole book and breaks P&L down
// by bet type, but it carries no wagering volume.

const { num, parseDate, fmtDate } = require('./ledger');

// The bet-type leaves the platform emits, mapped onto the categories the
// reports have always used.
const BET_TYPES = {
  PreMatch:  'sports',
  InPlay:    'live',
  Betsoft:   'casino',
  TFUSION:   'casino',
  PLAYGLOBE: 'casino',
};
const CATEGORIES = ['sports', 'live', 'casino', 'other'];

// Casino products are excluded from the reports: the bonus leaderboard and the
// referral commission are both sportsbook programmes, so casino action neither
// ranks a client nor earns a referrer anything.
//
// PreMatch and InPlay are unambiguously sportsbook. Of the three below, only
// Betsoft is a recognised casino provider by name — TFUSION and PLAYGLOBE were
// classified by inference, not from anything the export states. If either turns
// out to be a sportsbook product, move it out of this list and the figures
// follow automatically.
const EXCLUDED_BET_TYPES = ['Betsoft', 'TFUSION', 'PLAYGLOBE'];

function categoryOf(betType) {
  return BET_TYPES[betType] || 'other';
}

function isExcluded(betType, excluded) {
  return excluded.some(name => name.toLowerCase() === String(betType).toLowerCase());
}

function pathOf(group) {
  return String(group ?? '').split('->').map(s => s.trim()).filter(Boolean);
}

// The week is the header of the amount column, e.g. "08/31/26 - 09/06/26".
function findWeekColumn(row) {
  const keys = Object.keys(row);
  const dated = keys.find(k => /\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4}/.test(k));
  return dated || null;
}

function parseWeekHeader(header) {
  const m = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(header || '');
  if (!m) return null;
  const start = parseDate(m[1]);
  const end   = parseDate(m[2]);
  if (!start || !end) return null;
  return { start, end, weekStart: fmtDate(start), weekEnd: fmtDate(end) };
}

// Parses the grid into one record per account.
//
// Three quirks of this export are handled here, all verified across the whole
// file rather than assumed:
//
//  1. Every bet-type row is followed by a row with an empty Group that repeats
//     the same figures. Counting those would double every total, so rows
//     without a Group are dropped.
//  2. The column headed with the week range is the negated, truncated form of
//     the `Total` column. `Total` carries the sign and the precision, so P&L is
//     read from there and the week column is ignored.
//  3. `Pending` and `End Balance` are account-level values repeated on each of
//     the account's bet-type rows, which the grid then sums into the account
//     row — inflating both by the number of bet types. The de-duplicated leaf
//     value is reported as the true figure.
function parsePeriodic(rows, options = {}) {
  // Pass `exclude: []` to keep every product — used by the structural checks,
  // which must reconcile against the export's own untouched totals.
  const excluded = options.exclude ?? EXCLUDED_BET_TYPES;
  if (!rows.length) return { accounts: new Map(), week: null, groups: [] };

  const weekColumn = findWeekColumn(rows[0]);
  const week = parseWeekHeader(weekColumn);

  const accounts = new Map();
  const groups   = new Set();

  for (const row of rows) {
    const path = pathOf(row.Group);
    if (!path.length) continue;                    // quirk 1: duplicate row
    if (path.length === 1 && path[0] === 'Total') continue;  // grand total row

    const [group, account, betType] = path;

    if (path.length === 1) { groups.add(group); continue; }

    const key = account.toUpperCase();
    let rec = accounts.get(key);
    if (!rec) {
      rec = {
        account, key, group,
        pnl: 0,                                    // quirk 2: read from Total
        byCategory: Object.fromEntries(CATEGORIES.map(c => [c, 0])),
        betTypes: {},                              // products that count
        excludedBetTypes: {},                      // products that do not
        excludedPnl: 0,
        reportedPnl: 0,                            // the account row, untouched
        depositsWithdrawals: 0,
        pending: 0,
        endBalance: 0,
        pendingReported: 0,
        endBalanceReported: 0,
      };
      accounts.set(key, rec);
      groups.add(group);
    }

    if (path.length === 2) {
      // Recomputed below from the products that count, so the account row is
      // kept only for reference — it always includes everything.
      rec.reportedPnl = num(row.Total);
      rec.depositsWithdrawals = num(row['Dep/With']);
      // Keep what the grid claimed, so the inflation stays auditable.
      rec.pendingReported    = num(row.Pending);
      rec.endBalanceReported = num(row['End Balance']);
    } else if (path.length === 3) {
      const amount = num(row.Total);
      if (isExcluded(betType, excluded)) {
        rec.excludedBetTypes[betType] = (rec.excludedBetTypes[betType] || 0) + amount;
        rec.excludedPnl += amount;
      } else {
        rec.byCategory[categoryOf(betType)] += amount;
        rec.betTypes[betType] = (rec.betTypes[betType] || 0) + amount;
        rec.pnl += amount;
      }
      // quirk 3: every leaf repeats the same account-level figure.
      rec.pending    = num(row.Pending);
      rec.endBalance = num(row['End Balance']);
    }
  }

  return { accounts, week, weekColumn, groups: [...groups], excluded };
}

// Consistency checks worth running on each new export — if the platform changes
// the grid, these fail loudly rather than producing quietly wrong money.
function verifyPeriodic(rows) {
  const issues = [];
  const weekColumn = findWeekColumn(rows[0] || {});
  if (!weekColumn) issues.push('No week-range column found in the header.');

  const withGroup = rows.filter(r => pathOf(r.Group).length > 0);
  const blank     = rows.length - withGroup.length;
  const leaves    = withGroup.filter(r => pathOf(r.Group).length === 3);
  if (blank !== leaves.length) {
    issues.push(`Expected one blank duplicate row per bet-type row, `
      + `found ${blank} blank vs ${leaves.length} bet-type rows.`);
  }

  for (const row of withGroup) {
    const path = pathOf(row.Group);
    if (path.length < 2 || !weekColumn) continue;
    const total = num(row.Total);
    const shown = num(row[weekColumn]);
    if (Math.abs(shown - (-Math.trunc(total))) > 1.001) {
      issues.push(`${row.Group.trim()}: week column ${shown} is not the negated `
        + `Total ${total} — the sign convention may have changed.`);
    }
  }

  // Reconcile with nothing excluded — this checks the file, not the policy.
  const { accounts } = parsePeriodic(rows, { exclude: [] });
  for (const rec of accounts.values()) {
    const summed = CATEGORIES.reduce((s, c) => s + rec.byCategory[c], 0);
    if (Math.abs(summed - rec.reportedPnl) > 0.01) {
      issues.push(`${rec.account}: bet-type rows sum to ${summed.toFixed(2)} `
        + `but the account row says ${rec.reportedPnl.toFixed(2)}.`);
    }
  }
  return issues;
}

module.exports = { BET_TYPES, CATEGORIES, EXCLUDED_BET_TYPES, categoryOf, isExcluded, parsePeriodic, verifyPeriodic, parseWeekHeader, findWeekColumn };
