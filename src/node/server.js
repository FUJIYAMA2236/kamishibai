/*
 * server.js — ブラウザ版のローカル HTTP サーバー（Node 標準モジュールのみ）。
 *
 * 役割:
 *   1. エディタの画面（src/editor）と、ブラウザで使うコード（src/core, src/runtime, src/app, vendor）を配る
 *   2. /api/* … バックエンド（src/app/backend.js）の JSON API をそのまま HTTP で出す
 *   3. /files/* … 開いているプロジェクトのファイル（プレビューの画像）
 *   4. /present, /doc … 発表用 / 資料用 HTML をその場で組み立てて返す
 *
 * デスクトップアプリ（Tauri）はこのサーバーを使わず、画面の中で同じバックエンドを直接呼ぶ。
 * 127.0.0.1 にしか bind せず、Host / Origin も検査する（他サイトからの書き込みを防ぐ）。
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createBackend } = require('../app/backend');
const { createNodeHost, TOOL_ROOT } = require('./host');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
};
const MAX_BODY = 64 * 1024 * 1024;

// URL の先頭 → 配信するフォルダ
const STATIC = {
  editor: path.join(TOOL_ROOT, 'src', 'editor'),
  core: path.join(TOOL_ROOT, 'src', 'core'),
  runtime: path.join(TOOL_ROOT, 'src', 'runtime'),
  app: path.join(TOOL_ROOT, 'src', 'app'),
  vendor: path.join(TOOL_ROOT, 'vendor'),
};

const LEGAL = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];

function resolveInside(base, relative) {
  const full = path.resolve(base, relative);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

function send(res, status, body, type, headers) {
  const buf = Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(String(body));
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' }, headers));
  res.end(buf);
}
const sendJson = (res, data, status) => send(res, status || 200, JSON.stringify(data), TYPES['.json']);

function sendFile(req, res, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
  const stat = fs.statSync(file);
  const etag = '"' + stat.size + '-' + Math.round(stat.mtimeMs) + '"';
  const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { const e = new Error('データが大きすぎます（上限 64MB）'); e.status = 413; e.expose = true; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { const b = Buffer.concat(chunks); resolve(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)); });
    req.on('error', reject);
  });
}

function isLocalHost(host) {
  const name = String(host || '').replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

/**
 * @param {Object} [opts] { backend: 既にあるバックエンド（無ければ作る）, workRoot }
 * @returns {http.Server}（server.backend でバックエンドにも触れる）
 */
function createServer(opts) {
  opts = opts || {};
  const backend = opts.backend || createBackend(createNodeHost(), {
    workRoot: opts.workRoot,
    markdownit: require(path.join(TOOL_ROOT, 'vendor', 'markdown-it.min.js')),
    hljs: require(path.join(TOOL_ROOT, 'vendor', 'highlight.min.js')),
  });

  // 発表・資料のプレビューでは、画像は /files/ から、mermaid は /vendor/ から読む（その場で組み立てるので軽く）
  const previewOpts = () => ({
    assets: 'url',
    assetUrl: (full) => '/files/' + path.relative(backend.project.dir, full).split(path.sep).map(encodeURIComponent).join('/'),
    scriptUrl: '/vendor/mermaid.min.js',
  });

  async function handle(req, res) {
    if (!isLocalHost(req.headers.host)) return send(res, 403, 'Forbidden');
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + req.headers.host) return send(res, 403, 'Forbidden');

    const url = new URL(req.url, 'http://localhost');
    let seg;
    try {
      seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch (e) {
      return send(res, 400, 'Bad request');
    }

    if (seg[0] === 'api') {
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      const r = await backend.api(req.method, seg, Object.fromEntries(url.searchParams), body);
      return sendJson(res, r.json, r.status);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    if (!seg.length) return sendFile(req, res, path.join(STATIC.editor, 'index.html'));
    // ライセンス（設定の「ライセンス」から読む。アプリでは app-dist/legal/）
    if (seg[0] === 'legal' && LEGAL.includes(seg[1])) return sendFile(req, res, path.join(TOOL_ROOT, seg[1]));
    if (STATIC[seg[0]]) return sendFile(req, res, resolveInside(STATIC[seg[0]], seg.slice(1).join('/')));

    if (!backend.project) return send(res, 409, 'プロジェクトが開かれていません');
    // プロジェクト内のファイル（プレビュー用の画像）
    if (seg[0] === 'files' && seg.length >= 2) {
      const f = await backend.projectFile(seg.slice(1).join('/'));
      if (!f) return send(res, 404, 'Not found');
      return send(res, 200, f.data, TYPES[path.extname(f.path).toLowerCase()] || f.mime, { 'Cache-Control': 'no-cache' });
    }
    // 発表用 HTML をその場で組み立てる（保存済みの内容が対象）
    if (seg[0] === 'present' && seg.length === 1) return send(res, 200, (await backend.buildDeck(backend.project, previewOpts())).html, TYPES['.html']);
    // 資料（読み物）形式。?notes=1 でノートも載せる
    if (seg[0] === 'doc' && seg.length === 1) {
      const notes = /^(1|true)$/.test(url.searchParams.get('notes') || '');
      return send(res, 200, (await backend.buildDocument(backend.project, Object.assign(previewOpts(), { notes }))).html, TYPES['.html']);
    }
    return send(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e && e.expose) return sendJson(res, { error: e.message }, e.status || 400);
      console.error(e);
      sendJson(res, { error: 'サーバー内部でエラーが起きました: ' + (e && e.message) }, 500);
    });
  });
  server.backend = backend;
  return server;
}

/** 空いているポートを探して listen する（指定ポートが使用中なら +1 ずつ試す） */
function listen(server, port, tries) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      const onError = (e) => {
        if (e.code === 'EADDRINUSE' && left > 0) attempt(p + 1, left - 1);
        else reject(e);
      };
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(server.address().port); // p=0（空きポートを自動で選ぶ）でも実際の番号を返す
      });
    };
    attempt(port, tries == null ? 20 : tries);
  });
}

module.exports = { createServer, listen, TOOL_ROOT };
