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
const { parseWagers } = require('./wagers');
const { hasNotes, parseRosterReferrals } = require('./roster');
const { looksLikeReferralMap, parseReferralMap } = require('./referral-map');

function classify(rows) {
  if (!rows.length) return 'empty';
  const keys = Object.keys(rows[0]).map(k => k.toLowerCase().trim());
  const has = name => keys.includes(name);

  // The maintained referral list: relationships and nothing else.
  if (has('referrer') && (has('referred') || has('client'))) return 'referral-map';
  if (has('group')) return 'periodic';
  // The wagers export is one row per bet, so it carries a stake.
  if ((has('player') || has('customer')) && has('risk')) return 'wagers';
  // A transaction ledger is one row per event, so it must say what each event
  // was. The player roster also has a Player column but no transactions —
  // distinguishing them stops a roster being parsed as activity.
  if ((has('player') || has('customer')) && (has('type') || has('credit') || has('debit'))) {
    return 'ledger';
  }
  if (has('player') && (has('creation time') || has('player id') || has('email'))) {
    return 'roster';
  }
  return 'unknown';
}

function emptyAccount(name, key) {
  return {
    player: name, key, account: name,
    group: null, agent: null,
    volume: 0, staked: 0, returned: 0, bets: 0,
    casinoVolume: 0, casinoBets: 0,
    pnl: 0,
    // Kept apart from `pnl` so the sources can be compared rather than merged
    // into one unattributable number.
    wagersPnl: null,
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

// Merges already-parsed exports. `entries` is [{ name, rows }] — the browser
// build calls this directly with rows it parsed itself, so the merge and every
// rule below it are shared with the CLI rather than reimplemented.
function loadRows(entries, options = {}) {
  // Relationships supplied outside the export set — the maintained list.
  const seededReferrals = options.referrals ?? [];
  // `includeExcluded: true` keeps casino products in, for comparison.
  const exclude = options.includeExcluded ? [] : (options.exclude ?? EXCLUDED_BET_TYPES);
  const accounts  = new Map();
  const referrals = [...seededReferrals];
  const warnings  = [];
  const seen      = { ledger: 0, periodic: 0, wagers: 0, roster: 0, rosterReferrals: 0, referralMap: 0 };
  let week = null;

  const get = (name, key) => {
    let rec = accounts.get(key);
    if (!rec) { rec = emptyAccount(name, key); accounts.set(key, rec); }
    return rec;
  };

  for (const { name: file, rows } of entries) {
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

    if (kind === 'referral-map') {
      seen.referralMap++;
      const parsed = parseReferralMap(rows, { source: file });
      referrals.push(...parsed.edges);
      for (const problem of parsed.problems) warnings.push(`${file}: ${problem}`);
      continue;
    }

    if (kind === 'wagers') {
      seen.wagers++;
      const parsed = parseWagers(rows, { excludeCasino: exclude.length > 0 });
      if (parsed.week) {
        if (!week) week = parsed.week;
        else if (week.weekEnd !== parsed.week.weekEnd) {
          warnings.push(`${file}: covers ${parsed.week.weekStart}–${parsed.week.weekEnd}, but another `
            + `file covers ${week.weekStart}–${week.weekEnd}. Mixing weeks gives a meaningless report.`);
        }
      }
      for (const rec of parsed.players.values()) {
        const target = get(rec.player, rec.key);
        target.agent        = target.agent || rec.agent;
        target.volume      += rec.volume;
        target.bets        += rec.bets;
        target.casinoVolume += rec.casinoVolume;
        target.casinoBets  += rec.casinoBets;
        target.wagersPnl    = (target.wagersPnl ?? 0) + rec.wagersPnl;
        // Only stand in for the periodic figure when there is not one.
        if (target.periodicPnl === null) target.pnl = target.wagersPnl;
        if (!target.sources.includes('wagers')) target.sources.push('wagers');
      }
      continue;
    }

    if (kind === 'roster') {
      seen.roster++;
      // A roster with a notes column is where referral relationships live;
      // without one there is nothing in it the reports can use.
      if (hasNotes(rows)) {
        const parsed = parseRosterReferrals(rows);
        referrals.push(...parsed.edges);
        seen.rosterReferrals += parsed.edges.length;
        if (parsed.unparsed.length) {
          warnings.push(`${file}: ${parsed.unparsed.length} note(s) mention a referral but `
            + 'do not match "Referred <CODE>" or "Referred by <CODE>", so no relationship '
            + `could be read from them — e.g. ${parsed.unparsed[0].account}: `
            + `"${parsed.unparsed[0].note.slice(0, 60)}".`);
        }
        if (!parsed.edges.length) {
          warnings.push(`${file}: has a "${parsed.notesColumn}" column but no referral `
            + 'relationships were found in it.');
        }
      } else {
        warnings.push(`${file}: player roster with no notes column, so no referral data. `
          + 'Add the notes column to the export to read referrals from it. It does contain '
          + 'personal data; keep it out of the repo.');
      }
      continue;
    }
    warnings.push(`${file}: unrecognised export — expected the periodic summary `
      + '(a Group column) or the transaction ledger (Player plus Type).');
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
  const withoutVolume = [...accounts.values()].filter(a => a.volume <= 0);
  if (withoutVolume.length && withoutVolume.length < accounts.size) {
    warnings.push(`${withoutVolume.length} of ${accounts.size} account(s) have no wagering `
      + 'volume, so they cannot appear on a volume-ranked leaderboard.');
  } else if (!seen.wagers && !seen.ledger) {
    warnings.push('No wagers or ledger file supplied, so there is no wagering volume — '
      + 'only the P&L-based ranking is available.');
  }
  if ((seen.ledger || seen.wagers) && !seen.periodic) {
    warnings.push('No periodic summary supplied, so there is no PreMatch/InPlay breakdown '
      + 'and P&L comes from the bet-level data alone.');
  }

  // Casino is excluded from two different sources: the periodic summary names
  // it by provider, the wagers file by the bet's own details. Report both.
  const excludedTotal = [...accounts.values()]
    .reduce((sum, a) => sum + Math.abs(a.excludedPnl || 0), 0);
  const excludedWagered = [...accounts.values()]
    .reduce((sum, a) => sum + (a.casinoVolume || 0), 0);
  const excludedAccounts = [...accounts.values()]
    .filter(a => Object.keys(a.excludedBetTypes || {}).length || a.casinoBets > 0).length;

  return { accounts, referrals, week, warnings, seen, exclude,
    excludedTotal, excludedWagered, excludedAccounts };
}

// Node entry point: read the files from disk, then merge.
function load(files, options = {}) {
  return loadRows(files.map(file => ({ name: file, rows: readFile(file) })), options);
}

module.exports = { load, loadRows, classify };
