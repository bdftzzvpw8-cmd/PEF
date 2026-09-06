'use strict';
// Reads the activity export in either format the platform emits: the .csv or
// the .xlsx (an ag-grid export). Both yield the same array of row objects
// keyed by the header labels.
const fs   = require('fs');
const path = require('path');
const { readEntries } = require('./zip');

// ── CSV ──────────────────────────────────────────────────────────────────────
// Handles quoted fields, embedded commas/newlines and doubled quotes.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"')                     { quoted = true; }
    else if (c === ',')                { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    }
    else field += c;
  }
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

// ── XLSX ─────────────────────────────────────────────────────────────────────
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (m, dec, hex, name) => {
    if (dec)  return String.fromCodePoint(parseInt(dec, 10));
    if (hex)  return String.fromCodePoint(parseInt(hex, 16));
    return name in XML_ENTITIES ? XML_ENTITIES[name] : m;
  });
}

// Concatenates the <t> runs inside a shared-string or inline-string element.
function textOf(xml) {
  const parts = xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
  return parts.map(p => unescapeXml(p.replace(/<t[^>]*>|<\/t>/g, ''))).join('');
}

function columnIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(buf) {
  const entries = readEntries(buf);

  const sharedXml = entries['xl/sharedStrings.xml'];
  const shared = sharedXml
    ? (sharedXml.toString('utf8').match(/<si>[\s\S]*?<\/si>/g) || []).map(textOf)
    : [];

  const sheetName = Object.keys(entries)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('No worksheet found in workbook');
  const sheet = entries[sheetName].toString('utf8');

  const rows = [];
  for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const cellXml of rowXml.match(/<c[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref  = (cellXml.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (cellXml.match(/\bt="([^"]+)"/)     || [])[1];
      const idx  = ref ? columnIndex(ref) : cells.length;

      let value = '';
      if (type === 's') {
        const i = (cellXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = i !== undefined ? (shared[Number(i)] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOf(cellXml);
      } else {
        const v = (cellXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = v !== undefined ? unescapeXml(v) : '';
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    if (cells.some(v => v !== '')) rows.push(cells);
  }
  return rows;
}

// ── Shared ───────────────────────────────────────────────────────────────────
// Turns a header row + data rows into objects. Duplicate or blank headers are
// given positional names so no column is silently dropped.
function toObjects(rows) {
  if (!rows.length) return [];
  const seen = new Set();
  const headers = rows[0].map((h, i) => {
    let name = String(h).trim() || `column_${i + 1}`;
    while (seen.has(name)) name = `${name}_${i + 1}`;
    seen.add(name);
    return name;
  });
  return rows.slice(1).map(cells => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  });
}

function readFile(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const rows = ext === '.xlsx' || ext === '.xlsm'
    ? parseXlsx(buf)
    : parseCsv(buf.toString('utf8'));
  return toObjects(rows);
}

module.exports = { readFile, parseCsv, parseXlsx, toObjects };
