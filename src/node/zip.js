/*
 * zip.js（Node 用）— core/zip.js に Node 標準の zlib を渡して、Buffer で読み書きする。
 *
 *   writeZip(entries)  entries: [{ name: 'slides.md', data: Buffer }] → Buffer
 *   readZip(buffer)    → [{ name, data: Buffer }]
 */
'use strict';
const zlib = require('zlib');
const core = require('../core/zip');

function writeZip(entries) {
  const out = core.writeZip(entries, { deflate: (raw) => zlib.deflateRawSync(raw, { level: 9 }) });
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function readZip(buf) {
  return core.readZip(buf, { inflate: (body) => zlib.inflateRawSync(body) }).map((e) => ({ name: e.name, data: Buffer.from(e.data) }));
}

module.exports = { writeZip, readZip, crc32: core.crc32 };
