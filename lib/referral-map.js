'use strict';
// A maintained list of referral relationships, for when the platform's exports
// do not carry them.
//
// Same edge shape as the ledger and roster sources, so the referral report
// cannot tell them apart and needs no special case.

const { findColumn } = require('./ledger');

const COLUMNS = {
  referrer: ['referrer', 'referred by', 'referring account', 'sponsor', 'parent'],
  referred: ['referred', 'client', 'referred account', 'account', 'child'],
  since:    ['since', 'date', 'start', 'from'],
  note:     ['note', 'notes', 'source', 'comment'],
};

function looksLikeReferralMap(rows) {
  if (!rows.length) return false;
  return Boolean(findColumn(rows[0], COLUMNS.referrer) && findColumn(rows[0], COLUMNS.referred));
}

function parseReferralMap(rows, { source = 'referral list' } = {}) {
  const edges = [];
  const problems = [];
  if (!rows.length) return { edges, problems };

  const referrerCol = findColumn(rows[0], COLUMNS.referrer);
  const referredCol = findColumn(rows[0], COLUMNS.referred);
  if (!referrerCol || !referredCol) {
    throw new Error('The referral list needs a "referrer" column and a "referred" column');
  }
  const sinceCol = findColumn(rows[0], COLUMNS.since);
  const noteCol  = findColumn(rows[0], COLUMNS.note);

  const seen = new Set();
  for (const [i, row] of rows.entries()) {
    const referrer = String(row[referrerCol] ?? '').trim();
    const referred = String(row[referredCol] ?? '').trim();
    // A comment line read as data leaves a row with nothing in it.
    if (!referrer && !referred) continue;

    const line = i + 2;   // +1 for the header, +1 for 1-based counting
    if (!referrer || !referred) {
      problems.push(`row ${line}: needs both a referrer and a referred account`);
      continue;
    }
    const referrerKey = referrer.toUpperCase();
    const referredKey = referred.toUpperCase();
    if (referrerKey === referredKey) {
      problems.push(`row ${line}: ${referrer} cannot refer itself`);
      continue;
    }
    const dedupe = `${referrerKey}->${referredKey}`;
    if (seen.has(dedupe)) {
      problems.push(`row ${line}: ${referrer} → ${referred} is listed more than once`);
      continue;
    }
    seen.add(dedupe);

    edges.push({
      referrer, referrerKey, referred, referredKey,
      bonusPaid: 0,
      bonusType: source,
      date: null,
      since: sinceCol ? String(row[sinceCol] ?? '').trim() || null : null,
      note:  noteCol  ? String(row[noteCol]  ?? '').trim() || null : null,
    });
  }

  // One client with two different referrers is a real conflict, not a duplicate.
  const byReferred = new Map();
  for (const edge of edges) {
    const existing = byReferred.get(edge.referredKey);
    if (existing && existing !== edge.referrerKey) {
      problems.push(`${edge.referred} is listed under two referrers `
        + `(${existing} and ${edge.referrerKey}) — commission would be paid twice`);
    }
    byReferred.set(edge.referredKey, edge.referrerKey);
  }

  return { edges, problems };
}

module.exports = { COLUMNS, looksLikeReferralMap, parseReferralMap };
