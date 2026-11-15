#!/usr/bin/env node
/*
 * vendor/ に同梱しているブラウザ用ライブラリを、npm レジストリから取得し直すスクリプト。
 *
 *   node scripts/update-vendor.js
 *
 * 通常の利用では実行不要（vendor/ はリポジトリにコミット済み）。
 * ライブラリのバージョンを上げたいときだけ、下の VERSIONS を書き換えて実行する。
 * 必要なもの: npm と tar（Windows 10 以降 / macOS / Linux には標準で入っている）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { removeDir } = require('../src/node/fsutil');

const VERSIONS = {
  'markdown-it': '15.0.3',
  mermaid: '12.3.0',
  '@highlightjs/cdn-assets': '11.12.0',
};

// パッケージ内のパス → vendor/ 内のファイル名
const FILES = {
  'markdown-it': {
    'dist/browser/markdown-it.umd.min.js': 'markdown-it.min.js',
    LICENSE: 'markdown-it.LICENSE.txt',
  },
  mermaid: {
    'dist/mermaid.min.js': 'mermaid.min.js',
    LICENSE: 'mermaid.LICENSE.txt',
  },
  '@highlightjs/cdn-assets': {
    'highlight.min.js': 'highlight.min.js',
    LICENSE: 'highlight.LICENSE.txt',
  },
};

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'vendor');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kamishibai-vendor-'));
const isWin = process.platform === 'win32';

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: isWin, stdio: ['ignore', 'pipe', 'inherit'] });
}

fs.mkdirSync(vendorDir, { recursive: true });
const manifest = {};
try {
  for (const [pkg, version] of Object.entries(VERSIONS)) {
    console.log(`- ${pkg}@${version}`);
    const out = run('npm', ['pack', `${pkg}@${version}`, '--silent'], tmp).trim().split(/\r?\n/).pop();
    const dest = path.join(tmp, 'x-' + pkg.replace(/[^a-z0-9]/gi, '_'));
    fs.mkdirSync(dest);
    run('tar', ['-xzf', out, '-C', path.basename(dest)], tmp);
    for (const [from, to] of Object.entries(FILES[pkg])) {
      fs.copyFileSync(path.join(dest, 'package', from), path.join(vendorDir, to));
      console.log(`    ${from} -> vendor/${to}`);
    }
    manifest[pkg] = version;
  }
  fs.writeFileSync(path.join(vendorDir, 'versions.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('done.');
} finally {
  removeDir(tmp);
}
