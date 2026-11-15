/*
 * prepare-app.js — デスクトップアプリ（Tauri）の画面に入れるファイルを app-dist/ にそろえる。
 * `npm run app` / `npm run dist`（tauri dev / build）の前に自動で実行される（src-tauri/tauri.conf.json の beforeBuildCommand）。
 *
 *   app-dist/index.html        ← src/editor/index.html
 *   app-dist/editor|core|runtime|app/  ← src/…
 *   app-dist/vendor/           ← vendor/
 *   app-dist/themes/           ← themes/（同梱テーマ）
 *   app-dist/sample/           ← decks/demo/（「サンプルを開く」の中身）
 *   app-dist/bundle.json       ← themes/ と sample/ のファイル一覧（画面からはフォルダの中身を調べられないため）
 *
 * app-dist/ は生成物（git 管理外）。中身は exe に埋め込まれる。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { removeDir } = require('../src/node/fsutil');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'app-dist');

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip && skip(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, skip);
    else fs.copyFileSync(a, b);
  }
}
/** フォルダの中身の一覧（{ 名前: 下の一覧 | null（ファイル） }） */
function tree(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) out[e.name] = e.isDirectory() ? tree(path.join(dir, e.name)) : null;
  return out;
}

removeDir(OUT);
fs.mkdirSync(OUT, { recursive: true });
const skipDist = (n) => n === 'dist' || n.startsWith('.');
copyDir(path.join(ROOT, 'src', 'editor'), path.join(OUT, 'editor'));
copyDir(path.join(ROOT, 'src', 'core'), path.join(OUT, 'core'));
copyDir(path.join(ROOT, 'src', 'runtime'), path.join(OUT, 'runtime'));
copyDir(path.join(ROOT, 'src', 'app'), path.join(OUT, 'app'));
copyDir(path.join(ROOT, 'vendor'), path.join(OUT, 'vendor'));
copyDir(path.join(ROOT, 'themes'), path.join(OUT, 'themes'));
copyDir(path.join(ROOT, 'decks', 'demo'), path.join(OUT, 'sample'), skipDist);
fs.copyFileSync(path.join(ROOT, 'src', 'editor', 'index.html'), path.join(OUT, 'index.html'));
// ライセンス（設定の「ライセンス」で表示する）
fs.mkdirSync(path.join(OUT, 'legal'), { recursive: true });
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, 'legal', f));
fs.writeFileSync(path.join(OUT, 'bundle.json'), JSON.stringify({ themes: tree(path.join(OUT, 'themes')), sample: tree(path.join(OUT, 'sample')) }));
console.log('app-dist/ を用意しました');
