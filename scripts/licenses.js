#!/usr/bin/env node
/*
 * THIRD_PARTY_NOTICES.md（同梱しているライブラリのライセンス一覧と本文）を作り直す。
 *
 *   node scripts/licenses.js
 *
 * 対象:
 *   ・画面で使うライブラリ（vendor/。versions.json と *.LICENSE.txt）と、mermaid が内部にまとめているライブラリ
 *   ・アプリ本体（Rust）に組み込まれるクレート（Windows 版のビルドに入るもの。cargo tree で調べる）
 * 必要なもの: cargo（Rust）と、一度ビルドしてクレートのソースが ~/.cargo/registry に入っていること。
 * ライブラリやクレートの版を上げたら実行し直してコミットする。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
const TARGET = process.env.KS_LICENSE_TARGET || 'x86_64-pc-windows-msvc';

// ---- 画面で使うライブラリ（vendor/） ----
const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'versions.json'), 'utf8'));
const WEB = [
  { name: 'markdown-it', version: versions['markdown-it'], license: 'MIT', url: 'https://github.com/markdown-it/markdown-it', file: 'markdown-it.LICENSE.txt' },
  { name: 'mermaid', version: versions.mermaid, license: 'MIT', url: 'https://github.com/mermaid-js/mermaid', file: 'mermaid.LICENSE.txt' },
  { name: 'highlight.js', version: versions['@highlightjs/cdn-assets'], license: 'BSD-3-Clause', url: 'https://github.com/highlightjs/highlight.js', file: 'highlight.LICENSE.txt' },
  { name: 'CodeMirror 6（@codemirror/*・@lezer/*）', version: versions['@codemirror/view'], license: 'MIT', url: 'https://codemirror.net/', file: 'codemirror.LICENSE.txt' },
];
// mermaid（vendor/mermaid.min.js）が内部に含んでいる主なライブラリ（mermaid の package.json の dependencies）
const MERMAID_DEPS = [
  ['d3', 'ISC', 'https://github.com/d3/d3'],
  ['d3-sankey', 'BSD-3-Clause', 'https://github.com/d3/d3-sankey'],
  ['dagre-d3-es', 'MIT', 'https://github.com/tbo47/dagre-es'],
  ['cytoscape / cytoscape-fcose / cytoscape-cose-bilkent / cose-base / layout-base', 'MIT', 'https://github.com/cytoscape/cytoscape.js'],
  ['elkjs（Eclipse Layout Kernel）', 'EPL-2.0 OR GPL-3.0-or-later（ここでは EPL-2.0 を選択）', 'https://github.com/kieler/elkjs'],
  ['DOMPurify', 'MPL-2.0 OR Apache-2.0（ここでは Apache-2.0 を選択）', 'https://github.com/cure53/DOMPurify'],
  ['KaTeX', 'MIT', 'https://github.com/KaTeX/KaTeX'],
  ['marked', 'MIT', 'https://github.com/markedjs/marked'],
  ['chevrotain', 'Apache-2.0', 'https://github.com/chevrotain/chevrotain'],
  ['langium / @mermaid-js/parser / vscode-languageserver-types', 'MIT', 'https://github.com/eclipse-langium/langium'],
  ['khroma', 'MIT', 'https://github.com/fabiospampinato/khroma'],
  ['roughjs', 'MIT', 'https://github.com/rough-stuff/rough'],
  ['dayjs', 'MIT', 'https://github.com/iamkun/dayjs'],
  ['stylis', 'MIT', 'https://github.com/thysultan/stylis'],
  ['es-toolkit / lodash-es', 'MIT', 'https://github.com/toss/es-toolkit'],
  ['@iconify/utils', 'MIT', 'https://github.com/iconify/iconify'],
  ['@upsetjs/venn.js', 'MIT', 'https://github.com/upsetjs/venn.js'],
  ['@braintree/sanitize-url', 'MIT', 'https://github.com/braintree/sanitize-url'],
  ['ts-dedent', 'MIT', 'https://github.com/tamino-martinius/node-ts-dedent'],
];

// ---- Rust のクレート ----
function crates() {
  const out = execFileSync('cargo', ['tree', '-e', 'normal', '--target', TARGET, '--prefix', 'none', '--format', '{p}|{l}|{r}'],
    { cwd: path.join(ROOT, 'src-tauri'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const map = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+) v(\S+)(?: \(([^)]*)\))?[^|]*\|([^|]*)\|(.*)$/.exec(line.replace(/ \(\*\)/, ''));
    if (!m) continue;
    const [, name, version, extra, license, repo] = m;
    if (name === 'kamishibai') continue; // このアプリ自身
    const key = name + '@' + version;
    if (!map.has(key)) map.set(key, { name, version, license: license.trim() || '（記載なし）', repo: repo.trim(), macro: /proc-macro/.test(extra || '') });
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** クレートのソース（~/.cargo/registry/src/<index>/<name>-<version>/）にあるライセンスの本文 */
function crateLicenseTexts(c) {
  const base = path.join(process.env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'registry', 'src');
  if (!fs.existsSync(base)) return [];
  for (const idx of fs.readdirSync(base)) {
    const dir = path.join(base, idx, c.name + '-' + c.version);
    if (!fs.existsSync(dir)) continue;
    return fs.readdirSync(dir)
      .filter((f) => /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)/i.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }));
  }
  return [];
}

function main() {
  const list = crates();
  const lines = [];
  const p = (s) => lines.push(s == null ? '' : s);
  p('# サードパーティのライセンス（THIRD_PARTY_NOTICES）');
  p();
  p('Kamishibai 本体は MIT License です（`LICENSE`）。Kamishibai には、次のオープンソースのソフトウェアが含まれています。');
  p('各ソフトウェアの著作権は、それぞれの作者に帰属します。');
  p();
  p('このファイルは `node scripts/licenses.js` で作っています（手で書き換えないでください）。');
  p();
  p('## 1. 画面で使うライブラリ（vendor/ に同梱）');
  p();
  p('| ライブラリ | 版 | ライセンス | ソース |');
  p('| --- | --- | --- | --- |');
  for (const w of WEB) p('| ' + w.name + ' | ' + w.version + ' | ' + w.license + ' | ' + w.url + ' |');
  p();
  p('### mermaid に含まれているライブラリ');
  p();
  p('`vendor/mermaid.min.js` は mermaid の配布ファイルそのままで、次のライブラリを内部に含みます。');
  p();
  p('| ライブラリ | ライセンス | ソース |');
  p('| --- | --- | --- |');
  for (const [n, l, u] of MERMAID_DEPS) p('| ' + n + ' | ' + l + ' | ' + u + ' |');
  p();
  p('elkjs（EPL-2.0）は変更せずにそのまま含んでいます。ソースコードは上の URL から入手できます。');
  p('EPL-2.0 の本文: https://www.eclipse.org/legal/epl-2.0/ 。Apache-2.0 の本文は、このファイルの「ライセンスの本文」にあります。');
  p();
  p('## 2. アプリ本体（Rust）に組み込まれるクレート');
  p();
  p('Windows 版（' + TARGET + '）のビルドに入るクレートです（`cargo tree -e normal` で調べたもの。* はビルド時だけ使うマクロ）。');
  p('複数のライセンスから選べるもの（「A OR B」）は、そのうち 1 つに従います。MPL-2.0 のクレートは変更せずに使っており、ソースは crates.io から入手できます。');
  p();
  p('| クレート | 版 | ライセンス |');
  p('| --- | --- | --- |');
  for (const c of list) p('| ' + c.name + (c.macro ? ' *' : '') + ' | ' + c.version + ' | ' + c.license + ' |');
  p();
  p('## 3. そのほか');
  p();
  p('- Windows のインストーラーは NSIS（zlib/libpng License。https://nsis.sourceforge.io/License ）で作っています。');
  p('- 画面の表示には OS の WebView（Windows は Microsoft Edge WebView2）を使います。WebView2 は OS の部品で、Kamishibai には含まれていません。');
  p('- 同梱テーマは OS に入っているフォントだけを指定しており、フォントのファイルは含んでいません。');
  p();
  p('## 4. ライセンスの本文');
  p();
  p('### 画面で使うライブラリ');
  for (const w of WEB) {
    p();
    p('#### ' + w.name);
    p();
    p('```');
    p(fs.readFileSync(path.join(ROOT, 'vendor', w.file), 'utf8').replace(/\r\n/g, '\n').trim());
    p('```');
  }
  // 同じ本文はまとめる（MIT / Apache の定型文は多くのクレートで同じ）
  p();
  p('### Rust のクレート');
  p();
  p('同じ本文のものはまとめ、使っているクレートを見出しに並べています。');
  const groups = new Map();
  const missing = [];
  for (const c of list) {
    const texts = crateLicenseTexts(c);
    if (!texts.length) { missing.push(c); continue; }
    for (const t of texts) {
      // 改行・字下げの違いだけの本文は同じものとみなす
      const key = t.text.replace(/\s+/g, ' ').trim();
      const g = groups.get(key) || { text: t.text, names: [] };
      g.names.push(c.name + ' ' + c.version);
      groups.set(key, g);
    }
  }
  for (const g of groups.values()) {
    p();
    p('#### ' + g.names.join('、'));
    p();
    p('```');
    p(g.text.replace(/```/g, "'''"));
    p('```');
  }
  if (missing.length) {
    p();
    p('#### ソースにライセンスの本文が入っていないクレート');
    p();
    p('次のクレートは、上の表のライセンス（SPDX 名）の標準の本文に従います: ' + missing.map((c) => c.name + ' ' + c.version).join('、'));
  }
  p();
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log('書き出しました: ' + path.relative(ROOT, OUT) + '（クレート ' + list.length + ' 件・本文 ' + groups.size + ' 種類・本文なし ' + missing.length + ' 件・' + Math.round(fs.statSync(OUT).size / 1024) + 'KB）');
}

main();
