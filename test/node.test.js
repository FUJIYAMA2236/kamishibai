// バックエンド（src/app/backend.js）を Node の上で動かすテスト（プロジェクト・.kami・書き出し・サーバー）。
// デスクトップアプリ（Tauri）も同じバックエンドを使うので、ここで裏側の動きを確かめる。一時フォルダだけを使う。実行: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ユーザーの設定（最近使ったもの・テーマ）を本物の %APPDATA% に書かないよう、先に差し替える
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kamishibai-userdata-'));
process.env.KAMISHIBAI_USERDATA = USERDATA;

const { createBackend } = require('../src/app/backend');
const P = require('../src/app/pathx');
const { createNodeHost, TOOL_ROOT } = require('../src/node/host');
const { writeZip, readZip } = require('../src/node/zip');
const { createServer, listen } = require('../src/node/server');
const { removeDir, removeFile } = require('../src/node/fsutil');

const PNG_1PX = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const userThemes = path.join(USERDATA, 'themes');
test.after(() => removeDir(USERDATA));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kamishibai-test-'));
  t.after(() => removeDir(dir));
  return dir;
}
function newBackend(t) {
  return createBackend(createNodeHost(), {
    workRoot: path.join(tempDir(t), 'work'),
    markdownit: require(path.join(TOOL_ROOT, 'vendor', 'markdown-it.min.js')),
    hljs: require(path.join(TOOL_ROOT, 'vendor', 'highlight.min.js')),
  });
}
async function newProject(t, name) {
  const b = newBackend(t);
  const p = await b.createFolder(path.join(tempDir(t), name || 'talk'), { title: 'テスト発表' });
  return { b, p };
}

test('pathx: Windows と POSIX のパス', () => {
  assert.equal(P.join('C:\\a\\b', '..', 'c.txt'), 'C:\\a\\c.txt');
  assert.equal(P.join('/a/b', 'c'), '/a/b/c');
  assert.equal(P.dirname('C:\\a\\b.kami'), 'C:\\a');
  assert.equal(P.basename('C:\\a\\発表.kami', '.kami'), '発表');
  assert.equal(P.extname('a/b.diagram.svg'), '.svg');
  assert.equal(P.relative('C:\\a', 'C:\\a\\b\\c.png'), 'b/c.png');
  assert.equal(P.inside('C:\\a', '../b'), null);
  assert.equal(P.inside('/a', 'b/../c'), '/a/c');
  assert.ok(P.same('C:\\A\\b', 'c:/a/b'));
  assert.equal(P.resolve('C:\\a', 'D:\\x'), 'D:\\x');
});

test('プロジェクト: 作成・読み書き（LF・末尾改行・整形済み JSON）', async (t) => {
  const { b, p } = await newProject(t);
  assert.equal(p.name, 'talk');
  assert.match((await p.read()).md, /# テスト発表/);
  assert.ok(fs.existsSync(path.join(p.dir, '.gitignore')));
  await p.writeMd('# A\r\n\r\n---\r\n\r\n## B');
  assert.equal(fs.readFileSync(path.join(p.dir, 'slides.md'), 'utf8'), '# A\n\n---\n\n## B\n');
  await p.writeDesign({ theme: 'paper', tokens: { accent: '#ff0000', bg: '' } });
  assert.equal(fs.readFileSync(path.join(p.dir, 'deck.json'), 'utf8'), '{\n  "theme": "paper",\n  "tokens": {\n    "accent": "#ff0000"\n  }\n}\n');
  await assert.rejects(b.createProject(tempDir(t)), /slides\.md が見つかりません/);
});

test('画像の保存: 安全な名前・重複は連番・同じ内容は使い回し・図形の上書き', async (t) => {
  const { p } = await newProject(t);
  assert.equal(await p.saveAsset('../../evil name.png', PNG_1PX), 'assets/evil-name.png');
  assert.equal(await p.saveAsset('evil name.png', PNG_1PX), 'assets/evil-name.png');
  assert.equal(await p.saveAsset('evil name.png', Uint8Array.from([...PNG_1PX, 0])), 'assets/evil-name-2.png');
  await assert.rejects(p.saveAsset('x.exe', PNG_1PX), /対応していない/);
  assert.equal(await p.saveAsset('flow.diagram.svg', new TextEncoder().encode('<svg/>')), 'assets/flow.diagram.svg');
  assert.equal(await p.saveAsset('flow.diagram.svg', new TextEncoder().encode('<svg>2</svg>')), 'assets/flow-2.diagram.svg');
  await p.writeAsset('assets/flow.diagram.svg', new TextEncoder().encode('<svg>new</svg>'));
  assert.equal(fs.readFileSync(path.join(p.dir, 'assets', 'flow.diagram.svg'), 'utf8'), '<svg>new</svg>');
  await assert.rejects(p.writeAsset('../slides.md', PNG_1PX), /assets/);
  await assert.rejects(p.writeAsset('assets/../../x.png', PNG_1PX), /assets/);
});

test('テーマ: 同梱テーマが見え、作ったテーマはユーザーのテーマとして保存される', async (t) => {
  const { p } = await newProject(t);
  const themes = await p.listThemes();
  for (const id of ['snow', 'paper', 'midnight', 'ink']) assert.ok(themes[id], id);
  assert.equal(themes.midnight.editable, false);
  const saved = await p.writeTheme('my-theme', { name: '自分用', tokens: { accent: '#123456' }, css: '.x{}' });
  assert.equal(saved.editable, true);
  assert.ok(fs.existsSync(path.join(userThemes, 'my-theme', 'theme.css')));
  await assert.rejects(p.writeTheme('Bad Id', {}), /テーマID/);
});

test('zip: 書いて読むと同じ（日本語のファイル名・圧縮あり / なし）', () => {
  const entries = [
    { name: 'slides.md', data: Buffer.from('# あいう\n'.repeat(50)) },
    { name: 'assets/画像.png', data: Buffer.from(PNG_1PX) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const back = readZip(writeZip(entries));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  back.forEach((e, i) => assert.ok(e.data.equals(entries[i].data), e.name));
  assert.throws(() => readZip(Buffer.from('not a zip')), /zip/);
});

test('.kami: 使っているユーザーテーマも同梱し、展開すると元に戻る', async (t) => {
  const { b, p } = await newProject(t, '発表');
  await p.saveAsset('写真.png', PNG_1PX);
  await p.writeTheme('kami-theme', { name: '同梱テスト', tokens: { accent: '#00aa00' } });
  await p.writeDesign({ theme: 'kami-theme' });
  fs.mkdirSync(path.join(p.dir, 'dist'));
  fs.writeFileSync(path.join(p.dir, 'dist', 'out.html'), 'x');
  const dir = tempDir(t);
  const file = await b.packProject(p, path.join(dir, '発表.kami'));
  const names = readZip(fs.readFileSync(file)).map((e) => e.name).sort();
  assert.deepEqual(names, ['assets/写真.png', 'deck.json', 'slides.md', 'themes/kami-theme/theme.json']);
  // 別の PC（ユーザーテーマが無い）で開いても、同梱のテーマで表示できる
  removeDir(path.join(userThemes, 'kami-theme'));
  const out = await b.unpackKami(file, path.join(dir, 'open'));
  const opened = await b.createProject(out);
  assert.equal((await opened.readTheme('kami-theme')).name, '同梱テスト');
  await assert.rejects(b.unpackKami(path.join(dir, 'open', 'slides.md'), path.join(dir, 'x')), /開けませんでした/);
});

test('セッション: フォルダ / .kami を開く・新規作成・保存し直す・最近使ったもの', async (t) => {
  const dir = tempDir(t);
  const b = newBackend(t);
  assert.equal(b.project, null);

  const folder = await b.createFolder(path.join(dir, 'フォルダ版'), { title: 'フォルダ版' });
  assert.equal(folder.kamiFile, null);
  fs.mkdirSync(path.join(dir, '使用中'));
  fs.writeFileSync(path.join(dir, '使用中', 'memo.txt'), 'x');
  await assert.rejects(b.createFolder(path.join(dir, '使用中')), /空ではない/);

  // .kami として新規作成 → 編集すると少し後に .kami へ書き戻される
  const kamiPath = path.join(dir, '一枚.kami');
  const kami = await b.createKami(kamiPath);
  assert.equal(kami.kamiFile, kamiPath);
  assert.equal(kami.name, '一枚');
  await kami.writeMd('# 書き戻しテスト');
  await b.flush();
  assert.match(readZip(fs.readFileSync(kamiPath)).find((e) => e.name === 'slides.md').data.toString(), /書き戻しテスト/);

  // サンプル（未保存）→ .kami に保存すると、以後その .kami を編集する
  const sample = await b.openSample();
  assert.ok(sample.temporary);
  assert.ok(fs.existsSync(path.join(sample.dir, 'assets', 'process.diagram.svg')));
  const saved = await b.saveAsKami(path.join(dir, 'サンプル.kami'));
  assert.equal(saved.kamiFile, path.join(dir, 'サンプル.kami'));
  assert.ok(!saved.temporary);

  const asFolder = await b.saveAsFolder(path.join(dir, '展開'));
  assert.equal(asFolder.dir, path.join(dir, '展開'));
  assert.ok(fs.existsSync(path.join(dir, '展開', 'assets', 'dawn.svg')));

  assert.equal((await b.open(path.join(dir, 'フォルダ版', 'slides.md'))).dir, path.join(dir, 'フォルダ版'));
  await assert.rejects(b.open(path.join(dir, 'nope')), /見つかりません/);

  const recent = (await b.recent()).map((r) => r.path);
  assert.equal(recent[0], path.join(dir, 'フォルダ版'));
  assert.ok(recent.includes(kamiPath));
  await b.close();
  assert.equal(b.project, null);
});

test('書き出し: 埋め込み（1 ファイル）と フォルダ参照（_files）', async (t) => {
  const { b, p } = await newProject(t);
  await p.saveAsset('a.png', PNG_1PX);
  await p.writeMd('# 表紙\n\n---\n\n## 画像\n\n![](assets/a.png)\n\n![](assets/missing.png)\n\n---\n\n```mermaid\nflowchart LR\n  A --> B\n```');
  const out = tempDir(t);

  const embedded = await b.exportDeck(p, { out: path.join(out, 'one.html') });
  assert.match(embedded.html, /src="data:image\/png;base64,/);
  assert.ok(embedded.warnings.some((w) => /missing\.png/.test(w)));
  assert.ok(embedded.bytes > 1024 * 1024, 'mermaid を埋め込む');
  assert.ok(!fs.existsSync(path.join(out, 'one_files')));

  const ref = await b.exportDeck(p, { out: path.join(out, '発表.html'), embed: false });
  assert.match(ref.html, /src="%E7%99%BA%E8%A1%A8_files\/assets\/a\.png"/);
  assert.match(ref.html, /<script src="%E7%99%BA%E8%A1%A8_files\/mermaid\.min\.js"><\/script>/);
  assert.ok(ref.bytes < 300 * 1024);
  assert.ok(fs.existsSync(path.join(out, '発表_files', 'assets', 'a.png')));
  assert.ok(fs.existsSync(path.join(out, '発表_files', 'mermaid.min.js')));

  assert.equal((await b.exportDeck(p)).file, path.join(p.dir, 'dist', 'talk.html'));
  assert.equal((await b.exportDocument(p)).file, path.join(p.dir, 'dist', 'talk-資料.html'));
  // 画面で作ったファイル（Word など）の保存先
  assert.equal((await b.saveExportFile(p, 'doc', 'docx', null, PNG_1PX)).file, path.join(p.dir, 'dist', 'talk-資料.docx'));
  await assert.rejects(b.saveExportFile(p, 'doc', 'exe', null, PNG_1PX), /対応していない/);
});

test('書き出し: 1 ファイルの HTML・テーマが無ければ警告・資料は A4', async (t) => {
  const { b, p } = await newProject(t);
  await p.writeDesign({ theme: 'no-such-theme' });
  await p.writeMd('# 表紙\n\n---\n\n## 本文\n\nテキスト\n\n???\nメモ');
  const r = await b.buildDeck(p);
  assert.ok(r.warnings.some((w) => /no-such-theme/.test(w)));
  assert.doesNotMatch(r.html, /<script src=|<link rel="stylesheet"/);
  assert.match(r.html, /Kamishibai\.start\(/);
  assert.match(r.html, /@page \{ size: 1280px 720px/);
  assert.ok(r.html.includes("classList.add('ks-ready')"));
  const d = await b.buildDocument(p);
  assert.match(d.html, /@page \{ size: A4/);
  assert.doesNotMatch(d.html, /メモ/);
  assert.match((await b.buildDocument(p, { notes: true })).html, /ks-doc-note[\s\S]*メモ/);
});

test('同梱テーマ: 定義が正しく、シンプルなテーマにはグラデーションが無い', () => {
  const schema = require('../src/core/schema');
  const keys = new Set(schema.TOKENS.map((d) => d.key));
  const dir = path.join(__dirname, '..', 'themes');
  const ids = fs.readdirSync(dir).filter((id) => fs.existsSync(path.join(dir, id, 'theme.json')));
  assert.ok(ids.length >= 11);
  for (const id of ids) {
    const theme = JSON.parse(fs.readFileSync(path.join(dir, id, 'theme.json'), 'utf8'));
    assert.ok(theme.name && theme.description, id);
    assert.ok(['simple', 'decorative'].includes(theme.category), id + ' の category');
    for (const k of Object.keys(theme.tokens || {})) assert.ok(keys.has(k), id + ' の未知のトークン: ' + k);
    for (const def of schema.TOKENS.filter((d) => d.type === 'select')) {
      const v = (theme.tokens || {})[def.key];
      if (v !== undefined) assert.ok(def.options.some((o) => o[0] === v), id + ' の ' + def.key + '=' + v);
    }
    if (theme.category === 'simple') {
      const tk = theme.tokens || {};
      assert.doesNotMatch([tk.bgSlide, tk.bgTitle, tk.bgSection].join(''), /gradient/, id + ' はシンプルなのに背景がグラデーション');
      assert.notEqual(tk.headingStyle, 'gradient', id + ' はシンプルなのに見出しがグラデーション');
    }
  }
});

test('日本語を含むパスのファイル・フォルダを消してもプロセスが落ちない（fs.rmSync を使わない）', (t) => {
  const dir = path.join(tempDir(t), '日本語のフォルダ');
  fs.mkdirSync(path.join(dir, '中'), { recursive: true });
  fs.writeFileSync(path.join(dir, '資料.pdf'), 'x');
  fs.writeFileSync(path.join(dir, '中', '画像.png'), 'x');
  removeFile(path.join(dir, '資料.pdf'));
  removeFile(path.join(dir, '資料.pdf')); // 無くても例外にならない
  assert.ok(!fs.existsSync(path.join(dir, '資料.pdf')));
  removeDir(dir);
  assert.ok(!fs.existsSync(dir));
  for (const f of ['src/node/pdf.js', 'src/node/host.js', 'src/node/server.js', 'bin/kamishibai.js', 'scripts/update-vendor.js', 'scripts/prepare-app.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /\.rmSync\(/, f);
  }
});

function request(port, opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(Object.assign({ host: '127.0.0.1', port }, opts), (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('サーバー: 開く前はスタート状態・API・Host/Origin 検査・パストラバーサル', async (t) => {
  const dir = tempDir(t);
  const server = createServer({ workRoot: path.join(dir, 'work') });
  const port = await listen(server, 0, 0);
  t.after(() => server.close());
  const host = { Host: 'localhost:' + port };
  const json = Object.assign({ 'Content-Type': 'application/json' }, host);

  let state = JSON.parse((await request(port, { path: '/api/state', headers: host })).body);
  assert.equal(state.project, null);
  assert.ok(state.themes.snow);
  assert.equal((await request(port, { path: '/api/project', headers: host })).status, 409);

  const target = path.join(dir, 'ブラウザ版');
  assert.equal((await request(port, { method: 'POST', path: '/api/new', headers: json }, JSON.stringify({ path: target }))).status, 200);
  state = JSON.parse((await request(port, { path: '/api/state', headers: host })).body);
  assert.equal(state.project.dir, target);

  fs.writeFileSync(path.join(target, 'assets', 'a.png'), PNG_1PX);
  const put = await request(port, { method: 'PUT', path: '/api/project/md', headers: Object.assign({ 'Content-Type': 'text/plain' }, host) }, '# 更新\n\n![](assets/a.png)');
  assert.equal(put.status, 200);
  assert.equal(fs.readFileSync(path.join(target, 'slides.md'), 'utf8'), '# 更新\n\n![](assets/a.png)\n');

  const present = await request(port, { path: '/present', headers: host });
  assert.match(present.body, /<h1>更新<\/h1>/);
  assert.match(present.body, /src="\/files\/assets\/a\.png"/); // プレビューは画像を /files/ から読む
  assert.match((await request(port, { path: '/doc?notes=1', headers: host })).body, /class="ks-doc-page"/);

  const outFile = path.join(dir, 'out', 'スライド.html');
  const ex = await request(port, { method: 'POST', path: '/api/project/export', headers: json }, JSON.stringify({ kind: 'slides', format: 'html', out: outFile, embed: false }));
  assert.equal(ex.status, 200);
  assert.equal(JSON.parse(ex.body).file, outFile);
  const docx = await request(port, { method: 'POST', path: '/api/project/export-file?kind=doc&format=docx', headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, host) }, 'PK');
  assert.equal(JSON.parse(docx.body).file, path.join(target, 'dist', 'ブラウザ版-資料.docx'));
  assert.equal((await request(port, { method: 'POST', path: '/api/reveal', headers: json }, JSON.stringify({ path: path.join(dir, 'other.txt') }))).status, 404);

  assert.equal((await request(port, { path: '/', headers: host })).status, 200);
  assert.equal((await request(port, { path: '/app/backend.js', headers: host })).status, 200);
  assert.equal((await request(port, { path: '/api/state', headers: { Host: 'evil.example:' + port } })).status, 403);
  assert.equal((await request(port, { method: 'PUT', path: '/api/project/md', headers: Object.assign({ Origin: 'http://evil.example' }, host) }, 'x')).status, 403);
  assert.equal((await request(port, { path: '/files/..%2F..%2Fpackage.json', headers: host })).status, 404);
  assert.equal((await request(port, { path: '/core/..%2F..%2Fpackage.json', headers: host })).status, 404);
  assert.equal((await request(port, { method: 'POST', path: '/api/open', headers: json }, JSON.stringify({ path: path.join(dir, 'nope') }))).status, 404);

  await request(port, { method: 'POST', path: '/api/close', headers: json }, '{}');
  assert.equal(JSON.parse((await request(port, { path: '/api/state', headers: host })).body).project, null);
});
