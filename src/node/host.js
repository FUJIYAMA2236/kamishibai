/*
 * host.js — バックエンド（src/app/backend.js）に、Node でのファイル操作などを渡す。
 * ブラウザ版のローカルサーバー（server.js）とコマンドライン（bin/kamishibai.js）が使う。
 * デスクトップアプリ（Tauri）では、同じ役目を src/app/tauri-host.js が Rust 経由で行う。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zip = require('./zip');
const { removeFile, removeDir } = require('./fsutil');
const { printToPdf } = require('./pdf');
const { reveal } = require('./browser');

const TOOL_ROOT = path.resolve(__dirname, '..', '..');
// 同梱ファイルの置き場所（backend からは 'themes/…' のような名前で読む）
const BUNDLED = {
  themes: path.join(TOOL_ROOT, 'themes'),
  sample: path.join(TOOL_ROOT, 'decks', 'demo'),
  runtime: path.join(TOOL_ROOT, 'src', 'runtime'),
  vendor: path.join(TOOL_ROOT, 'vendor'),
};

/** ユーザーごとの設定・テーマの置き場所（Windows: %APPDATA%\Kamishibai。アプリと同じ場所） */
function userDataDir() {
  if (process.env.KAMISHIBAI_USERDATA) return path.resolve(process.env.KAMISHIBAI_USERDATA);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Kamishibai');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Kamishibai');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Kamishibai');
}

function bundledPath(rel) {
  const parts = String(rel).split('/');
  const base = BUNDLED[parts[0]];
  if (!base) return null;
  const full = path.resolve(base, parts.slice(1).join('/'));
  const r = path.relative(base, full);
  return r.startsWith('..') || path.isAbsolute(r) ? null : full;
}
const u8 = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

function createNodeHost(opts) {
  opts = opts || {};
  return {
    platform: process.platform,
    async readFile(p) { return u8(await fs.promises.readFile(p)); },
    async writeFile(p, data) { await fs.promises.writeFile(p, typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)); },
    async stat(p) {
      try {
        const s = await fs.promises.stat(p);
        return { isDir: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtimeMs };
      } catch (e) { return null; }
    },
    async readDir(p) { return (await fs.promises.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })); },
    async mkdir(p) { await fs.promises.mkdir(p, { recursive: true }); },
    async removeFile(p) { removeFile(p); }, // fs.rmSync は日本語のパスで落ちるので使わない（fsutil.js）
    async removeDir(p) { removeDir(p); },
    async rename(a, b) { await fs.promises.rename(a, b); },
    userDataDir: opts.userDataDir || userDataDir,
    tempDir: () => os.tmpdir(),
    absolute: (p) => path.resolve(String(p || '')),
    bundled: {
      async read(rel) {
        const p = bundledPath(rel);
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
        return u8(fs.readFileSync(p));
      },
      async list(rel) {
        const p = bundledPath(rel);
        if (!p || !fs.existsSync(p)) return [];
        return fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      },
    },
    zip: {
      async write(entries) { return u8(zip.writeZip(entries.map((e) => ({ name: e.name, data: typeof e.data === 'string' ? Buffer.from(e.data) : Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength) })))); },
      async read(bytes) { return zip.readZip(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).map((e) => ({ name: e.name, data: u8(e.data) })); },
    },
    pdf: (html, pdf, o) => printToPdf(html, pdf, o),
    async reveal(p) { reveal(p); },
  };
}

module.exports = { createNodeHost, userDataDir, TOOL_ROOT, BUNDLED };
