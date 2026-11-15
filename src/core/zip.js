/*
 * zip.js — zip を読み書きする最小限の実装（.kami、Word / ODF / PowerPoint の書き出しで使う）。
 * Node / ブラウザ両対応（UMD）。圧縮・展開の関数は外から渡す:
 *   Node     … src/node/zip.js が zlib を渡す（同期）
 *   ブラウザ … writeZipAsync / readZipAsync が CompressionStream('deflate-raw') を使う
 *
 *   entries: [{ name: 'a/b.xml', data: Uint8Array | string, store?: true（圧縮しない） }]
 *
 * ファイル名は UTF-8（フラグ 0x0800）。暗号化・ZIP64・分割アーカイブには対応しない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.KS = root.KS || {}).zip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = (data) => (typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));

  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /**
   * 圧縮済みの項目から zip を組み立てる
   * @param {Array<{name, raw: Uint8Array, body: Uint8Array, method: 0|8}>} items
   */
  function assemble(items) {
    const now = dosTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const it of items) {
      const name = enc.encode(it.name.replace(/\\/g, '/'));
      const crc = crc32(it.raw);
      const local = new Uint8Array(30);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, it.method, true);
      lv.setUint16(10, now.time, true);
      lv.setUint16(12, now.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, it.body.length, true);
      lv.setUint32(22, it.raw.length, true);
      lv.setUint16(26, name.length, true);
      locals.push(local, name, it.body);
      const central = new Uint8Array(46);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, it.method, true);
      cv.setUint16(12, now.time, true);
      cv.setUint16(14, now.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, it.body.length, true);
      cv.setUint32(24, it.raw.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      centrals.push(central, name);
      offset += local.length + name.length + it.body.length;
    }
    const cd = concat(centrals);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, items.length, true);
    ev.setUint16(10, items.length, true);
    ev.setUint32(12, cd.length, true);
    ev.setUint32(16, offset, true);
    return concat(locals.concat([cd, end]));
  }

  function prepare(e, deflated) {
    const raw = bytes(e.data);
    const useDeflate = !e.store && deflated && deflated.length < raw.length;
    return { name: e.name, raw, body: useDeflate ? deflated : raw, method: useDeflate ? 8 : 0 };
  }

  /** 同期版。deflate(Uint8Array) → Uint8Array を渡すと圧縮する（無ければ無圧縮） */
  function writeZip(entries, opts) {
    const deflate = opts && opts.deflate;
    return assemble(entries.map((e) => prepare(e, !e.store && deflate ? deflate(bytes(e.data)) : null)));
  }

  async function streamThrough(data, Stream, format) {
    const s = new Blob([data]).stream().pipeThrough(new Stream(format));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  /** ブラウザ版（非同期）。CompressionStream が無ければ無圧縮 */
  async function writeZipAsync(entries) {
    const can = typeof CompressionStream === 'function';
    const items = [];
    for (const e of entries) {
      const raw = bytes(e.data);
      // 画像など既に圧縮されているものは縮まないので、そのまま入れる
      const skip = e.store || !can || /\.(png|jpe?g|gif|webp|avif|zip|kami)$/i.test(e.name);
      items.push(prepare(e, skip ? null : await streamThrough(raw, CompressionStream, 'deflate-raw')));
    }
    return assemble(items);
  }

  /** zip の目次を読む（中身はまだ展開しない） */
  function directory(buf) {
    buf = bytes(buf);
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip 形式ではありません');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out = [];
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('zip の目次が壊れています');
      const method = v.getUint16(p + 10, true);
      const csize = v.getUint32(p + 20, true);
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      const localOffset = v.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue; // フォルダの項目
      const start = localOffset + 30 + v.getUint16(localOffset + 26, true) + v.getUint16(localOffset + 28, true);
      if (method !== 0 && method !== 8) throw new Error('対応していない圧縮方式です: ' + name);
      out.push({ name, method, body: buf.subarray(start, start + csize) });
    }
    return out;
  }

  /** 同期版。inflate(Uint8Array) → Uint8Array を渡す */
  function readZip(buf, opts) {
    const inflate = opts && opts.inflate;
    return directory(buf).map((e) => {
      if (e.method === 8 && !inflate) throw new Error('展開する関数がありません');
      return { name: e.name, data: e.method === 8 ? inflate(e.body) : e.body.slice() };
    });
  }

  async function readZipAsync(buf) {
    const out = [];
    for (const e of directory(buf)) {
      out.push({ name: e.name, data: e.method === 8 ? await streamThrough(e.body, DecompressionStream, 'deflate-raw') : e.body.slice() });
    }
    return out;
  }

  return { writeZip, writeZipAsync, readZip, readZipAsync, crc32 };
});
