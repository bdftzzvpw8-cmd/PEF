'use strict';
// Minimal ZIP reader — enough to pull entries out of an .xlsx (which is a zip
// of XML parts). Avoids a dependency on a spreadsheet library.
//
// Reading the entry table is separated from decompressing it: Node inflates
// synchronously via zlib, while the browser build has to go through the async
// DecompressionStream. Everything else about the format is shared.

// Locate the End Of Central Directory record by scanning backwards for its
// signature. The trailing comment is almost always empty, so this exits fast.
function findEocd(view) {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error('Not a zip file (no end-of-central-directory record)');
}

// Returns [{ name, method, raw }] with `raw` still compressed.
function readEntryTable(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const eocd  = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  let offset  = view.getUint32(eocd + 16, true);
  const entries = [];

  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method     = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLen    = view.getUint16(offset + 28, true);
    const extraLen   = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localPos   = view.getUint32(offset + 42, true);
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLen));

    // The local header repeats the name/extra with its own lengths, and the
    // extra field can differ from the central one — always read it fresh.
    const lNameLen  = view.getUint16(localPos + 26, true);
    const lExtraLen = view.getUint16(localPos + 28, true);
    const dataStart = localPos + 30 + lNameLen + lExtraLen;

    if (!name.endsWith('/')) {
      entries.push({ name, method, raw: data.subarray(dataStart, dataStart + compressed) });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Node-only: inflate the whole archive up front. Returns { name: Buffer }.
function readEntries(bytes) {
  const zlib = require('zlib');
  const out = {};
  for (const entry of readEntryTable(bytes)) {
    out[entry.name] = entry.method === 0
      ? Buffer.from(entry.raw)
      : zlib.inflateRawSync(entry.raw);
  }
  return out;
}

module.exports = { readEntryTable, readEntries };
