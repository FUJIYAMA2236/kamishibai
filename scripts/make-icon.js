#!/usr/bin/env node
/*
 * アプリのアイコン（build/icon.svg → build/icon.png, build/icon.ico）を作る。
 *   npm run icon
 * PC の Chrome / Edge で SVG を各サイズの PNG にし、PNG をそのまま格納した ICO を組み立てる。
 * できたファイルはリポジトリにコミットする（exe を作るたびに作り直す必要はない）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { findBrowser } = require('../src/node/browser');
const { removeDir } = require('../src/node/fsutil');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'build');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
const browser = findBrowser();
if (!browser) throw new Error('Chrome / Edge が見つかりません');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kamishibai-icon-'));
function render(size) {
  const html = path.join(tmp, 'icon-' + size + '.html');
  fs.writeFileSync(html, '<!doctype html><html><body style="margin:0;background:transparent">' +
    svg.replace('<svg ', '<svg width="' + size + '" height="' + size + '" style="display:block" ') + '</body></html>');
  const png = path.join(tmp, 'icon-' + size + '.png');
  const profile = path.join(tmp, 'profile-' + size);
  execFileSync(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--user-data-dir=' + profile,
    '--default-background-color=00000000', '--window-size=' + size + ',' + size, '--screenshot=' + png, pathToFileURL(html).href],
  { stdio: 'ignore', timeout: 60000 });
  return fs.readFileSync(png);
}

try {
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = sizes.map(render);
  fs.writeFileSync(path.join(dir, 'icon.png'), render(512));
  // ICO: ヘッダー（6 バイト）+ 項目（16 バイト × 枚数）+ PNG データ
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
  console.log('wrote build/icon.png, build/icon.ico');
} finally {
  removeDir(tmp);
}
