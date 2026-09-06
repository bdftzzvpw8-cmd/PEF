'use strict';
// Minimal ZIP reader — enough to pull entries out of an .xlsx (which is a zip
// of XML parts). Avoids a dependency on a spreadsheet library.
const zlib = require('zlib');

// Locate the End Of Central Directory record by scanning backwards for its
// signature. The trailing comment is almost always empty, so this exits fast.
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Not a zip file (no end-of-central-directory record)');
}

// Returns { name: Buffer } for every file entry in the archive.
function readEntries(buf) {
  const eocd    = findEocd(buf);
  const count   = buf.readUInt16LE(eocd + 10);
  let   offset  = buf.readUInt32LE(eocd + 16);
  const entries = {};

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method     = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLen    = buf.readUInt16LE(offset + 28);
    const extraLen   = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localPos   = buf.readUInt32LE(offset + 42);
    const name       = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // The local header repeats the name/extra with its own lengths, and the
    // extra field can differ from the central one — always read it fresh.
    const lNameLen  = buf.readUInt16LE(localPos + 26);
    const lExtraLen = buf.readUInt16LE(localPos + 28);
    const dataStart = localPos + 30 + lNameLen + lExtraLen;
    const raw       = buf.subarray(dataStart, dataStart + compressed);

    if (!name.endsWith('/')) {
      entries[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

module.exports = { readEntries };
