'use strict';
// Loads a mixed set of exports and merges them into one view of the week.
//
// The platform emits two shapes, and the reports need both:
//
//   transaction ledger   per-player rows; the only source of wagering VOLUME,
//                        and where referral edges live
//   periodic summary     the whole book's P&L, broken down by bet type, but
//                        with no volume
//
// Whichever files are supplied, this returns a single account map plus the
// referral edges found.

const { readFile }        = require('./sheet');
const { loadLedger }      = require('./ledger');
const { parsePeriodic, verifyPeriodic, CATEGORIES, EXCLUDED_BET_TYPES } = require('./periodic');

function classify(rows) {
  if (!rows.length) return 'empty';
  const keys = Object.keys(rows[0]).map(k => k.toLowerCase());
  if (keys.includes('group')) return 'periodic';
  if (keys.includes('player') || keys.includes('customer')) return 'ledger';
  return 'unknown';
}

function emptyAccount(name, key) {
  return {
    player: name, key, account: name,
    group: null, agent: null,
    volume: 0, staked: 0, returned: 0, bets: 0,
    pnl: 0,
    byCategory: Object.fromEntries(CATEGORIES.map(c => [c, 0])),
    betTypes: {},
    excludedBetTypes: {},
    excludedPnl: 0,
    reportedPnl: null,
    referredBy: null,
    referred: null,
    sources: [],
    // Realized P&L from the ledger, kept apart from the periodic figure: the
    // ledger only reflects graded wagers, so the two differ while bets are open.
    ledgerPnl: null,
    periodicPnl: null,
    pending: 0,
    endBalance: null,
  };
}

function load(files, options = {}) {
  // `includeExcluded: true` keeps casino products in, for comparison.
  const exclude = options.includeExcluded ? [] : (options.exclude ?? EXCLUDED_BET_TYPES);
  const accounts  = new Map();
  const referrals = [];
  const warnings  = [];
  const seen      = { ledger: 0, periodic: 0 };
  let week = null;

  const get = (name, key) => {
    let rec = accounts.get(key);
    if (!rec) { rec = emptyAccount(name, key); accounts.set(key, rec); }
    return rec;
  };

  for (const file of files) {
    const rows = readFile(file);
    const kind = classify(rows);

    if (kind === 'periodic') {
      seen.periodic++;
      for (const issue of verifyPeriodic(rows)) warnings.push(`${file}: ${issue}`);
      const parsed = parsePeriodic(rows, { exclude });
      if (parsed.week && !week) week = parsed.week;

      for (const rec of parsed.accounts.values()) {
        const target = get(rec.account, rec.key);
        target.group       = rec.group;
        target.agent       = target.agent || rec.group;
        target.periodicPnl = rec.pnl;
        target.pnl         = rec.pnl;          // authoritative for the week
        target.byCategory  = rec.byCategory;
        target.betTypes    = rec.betTypes;
        target.excludedBetTypes = rec.excludedBetTypes;
        target.excludedPnl = rec.excludedPnl;
        target.reportedPnl = rec.reportedPnl;
        target.pending     = rec.pending;
        target.endBalance  = rec.endBalance;
        if (!target.sources.includes('periodic')) target.sources.push('periodic');
      }
      continue;
    }

    if (kind === 'ledger') {
      seen.ledger++;
      const parsed = loadLedger(rows);
      if (parsed.week && !week) week = parsed.week;
      referrals.push(...parsed.referrals);

      for (const rec of parsed.players.values()) {
        const target = get(rec.player, rec.key);
        target.agent    = target.agent || rec.agent;
        target.volume  += rec.volume;
        target.staked  += rec.staked;
        target.returned += rec.returned;
        target.bets    += rec.bets;
        target.ledgerPnl = (target.ledgerPnl ?? 0) + rec.pnl;
        // Only fall back to the ledger's P&L when no periodic figure exists.
        if (target.periodicPnl === null) target.pnl = target.ledgerPnl;
        if (!target.sources.includes('ledger')) target.sources.push('ledger');
      }
      continue;
    }

    warnings.push(`${file}: unrecognised export — no Group or Player column.`);
  }

  // Referral edges name accounts that may only appear in the periodic file;
  // make sure every one of them exists so the report can list it.
  for (const edge of referrals) {
    const referred = accounts.get(edge.referredKey) ?? get(edge.referred, edge.referredKey);
    const referrer = accounts.get(edge.referrerKey) ?? get(edge.referrer, edge.referrerKey);
    // Cross-link both directions so the leaderboard can show a client's
    // referrer without re-walking the edge list.
    referred.referredBy = referrer.player ?? referrer.account;
    (referrer.referred ??= []).push(referred.player ?? referred.account);
  }

  // Volume only exists in the ledger. That matters when the leaderboard is
  // ranked on volume; ranking on P&L needs only the periodic summary. The
  // caller picks the basis, so state the gap rather than predict the effect.
  const withoutVolume = [...accounts.values()]
    .filter(a => a.sources.includes('periodic') && !a.sources.includes('ledger'));
  if (withoutVolume.length) {
    warnings.push(`${withoutVolume.length} of ${accounts.size} account(s) have no ledger `
      + 'file, so no wagering volume. They rank normally on P&L, but would be missing '
      + 'from a volume-ranked leaderboard.');
  }
  if (seen.ledger && !seen.periodic) {
    warnings.push('No periodic summary supplied — P&L reflects graded wagers only, '
      + 'and there is no bet-type breakdown.');
  }

  const excludedTotal = [...accounts.values()]
    .reduce((sum, a) => sum + Math.abs(a.excludedPnl || 0), 0);
  const excludedAccounts = [...accounts.values()]
    .filter(a => Object.keys(a.excludedBetTypes || {}).length).length;

  return { accounts, referrals, week, warnings, seen, exclude, excludedTotal, excludedAccounts };
}

module.exports = { load, classify };
