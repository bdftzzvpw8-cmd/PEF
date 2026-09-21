'use strict';
// Reads the player roster. Mostly account details the reports do not use, but
// when the export includes a notes column it is a source of referral
// relationships — which is where the previous reports read them from.

const { findColumn } = require('./ledger');

const COLUMNS = {
  player: ['player', 'customer', 'account', 'username'],
  agent:  ['agent'],
  notes:  ['player notes', 'player note', 'notes', 'note', 'comment', 'comments', 'remarks'],
  active: ['active'],
};

// Two directions are possible and they are opposites, so each is matched
// explicitly rather than inferred from a bare code:
//
//   "Referred BTCB50"      this account brought BTCB50 in
//   "Referred by BTCB50"   BTCB50 brought this account in
//
// A note holding only a code is genuinely ambiguous — it is reported as
// unparsed rather than guessed at, because guessing inverts the payout.
//
// Built fresh per note: a global regex carries `lastIndex` between calls, so a
// shared one would start mid-string on the next row and miss the match.
const patterns = () => ({
  referredBy: /referred\s*(?:by|from|through|via)\s*[:\-]?\s*([A-Za-z0-9_-]{2,32})/ig,
  referred:   /referred\s*[:\-]?\s*([A-Za-z0-9_-]{2,32})/ig,
});

function hasNotes(rows) {
  return Boolean(rows.length && findColumn(rows[0], COLUMNS.notes));
}

// Returns edges in the same shape ledger.parseReferrals produces, so both
// sources feed the referral report identically.
function parseRosterReferrals(rows) {
  const edges = [];
  const unparsed = [];
  if (!rows.length) return { edges, unparsed, notesColumn: null };

  const playerCol = findColumn(rows[0], COLUMNS.player);
  const notesCol  = findColumn(rows[0], COLUMNS.notes);
  if (!playerCol || !notesCol) return { edges, unparsed, notesColumn: null };

  const seen = new Set();
  const add = (referrer, referred, note) => {
    const referrerKey = referrer.toUpperCase();
    const referredKey = referred.toUpperCase();
    if (referrerKey === referredKey) return;          // self-referral
    const dedupe = `${referrerKey}->${referredKey}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    edges.push({
      referrer, referrerKey, referred, referredKey,
      bonusPaid: 0, bonusType: 'roster note', date: null, note,
    });
  };

  for (const row of rows) {
    const account = String(row[playerCol] ?? '').trim();
    const note    = String(row[notesCol] ?? '').trim();
    if (!account || !note) continue;

    let matched = false;
    const { referredBy, referred } = patterns();

    // "Referred by X" first — otherwise the looser pattern would read the
    // word "by" as the code.
    for (const m of note.matchAll(referredBy)) { add(m[1], account, note); matched = true; }
    if (!matched) {
      for (const m of note.matchAll(referred)) { add(account, m[1], note); matched = true; }
    }

    // A note that mentions nothing referral-shaped is just a note; one that
    // looks related but did not parse is worth surfacing.
    if (!matched && /refer|ref\b|invited|sponsor/i.test(note)) {
      unparsed.push({ account, note });
    }
  }

  return { edges, unparsed, notesColumn: notesCol };
}

module.exports = { COLUMNS, hasNotes, parseRosterReferrals };
