#!/usr/bin/env node
/*
 * CodeMirror 6 を 1 ファイル（vendor/codemirror.min.js、window.CM）にまとめる。
 *
 *   npm install            （初回のみ。devDependencies を入れる）
 *   npm run vendor:editor
 *
 * 出力はリポジトリにコミットする。ソースから動かすだけなら npm install は不要なまま。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'vendor', 'codemirror.min.js');
const pkg = (name) => require(path.join(root, 'node_modules', name, 'package.json')).version;

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'codemirror-entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'CM',
  target: ['chrome110', 'firefox115', 'safari16'],
  outfile: out,
  legalComments: 'none',
  banner: { js: '/* CodeMirror 6 (MIT) — bundled for Kamishibai. https://codemirror.net/ */' },
});

const versions = path.join(root, 'vendor', 'versions.json');
const manifest = JSON.parse(fs.readFileSync(versions, 'utf8'));
for (const name of ['@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language', '@codemirror/lang-markdown', '@lezer/markdown', '@lezer/highlight']) {
  manifest[name] = pkg(name);
}
fs.writeFileSync(versions, JSON.stringify(manifest, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'node_modules', '@codemirror', 'view', 'LICENSE'), path.join(root, 'vendor', 'codemirror.LICENSE.txt'));
console.log('wrote ' + path.relative(root, out) + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
