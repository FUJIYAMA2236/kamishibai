/*
 * tauri-host.js — デスクトップアプリ（Tauri）のときだけ働く。バックエンド（backend.js）をこの画面の中で動かし、
 * ファイル操作は Rust（src-tauri/src/main.rs の fs_* など）に頼む。
 *
 * 画面（editor.js）から見える窓口:
 *   window.KSDesktop  … api(method, url, body, type)（ブラウザ版の fetch('/api/…') の代わり）/ fileUrl(相対パス) / present / docPreview
 *   window.kamishibaiApp … ファイルメニューの操作（OS のダイアログで選んで開く・作る・保存し直す・書き出し先を選ぶ）
 *
 * ブラウザ版（Node のサーバー）では window.__TAURI__ が無いので、何もしない。
 */
(function () {
  'use strict';
  const T = window.__TAURI__;
  if (!T) return;
  const KS = window.KS;
  const P = KS.pathx;
  const invoke = T.core.invoke;
  const enc = new TextEncoder();
  const KAMI = { name: 'Kamishibai ファイル', extensions: ['kami'] };

  const wrap = (p) => p.catch((e) => { throw new Error(typeof e === 'string' ? e : (e && e.message) || String(e)); });

  // ---- 同梱ファイル（app-dist/ の themes/・sample/・runtime/・vendor/） ----
  let manifest = null;
  const bundleList = async () => manifest || (manifest = await (await fetch('/bundle.json')).json());

  let info = null;
  const host = {
    platform: 'tauri',
    async readFile(p) { return new Uint8Array(await wrap(invoke('fs_read', { path: p }))); },
    async writeFile(p, data) {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      await wrap(invoke('fs_write', bytes, { headers: { 'x-path': encodeURIComponent(p) } }));
    },
    stat: (p) => wrap(invoke('fs_stat', { path: p })),
    readDir: (p) => wrap(invoke('fs_list', { path: p })),
    mkdir: (p) => wrap(invoke('fs_mkdir', { path: p })),
    removeFile: (p) => wrap(invoke('fs_remove_file', { path: p })),
    removeDir: (p) => wrap(invoke('fs_remove_dir', { path: p })),
    rename: (a, b) => wrap(invoke('fs_rename', { from: a, to: b })),
    userDataDir: () => info.userData,
    tempDir: () => info.temp,
    absolute: (p) => P.normalize(String(p || '')),
    bundled: {
      async read(rel) {
        // 同梱の一覧（bundle.json）に無いものは読まない。アプリの中の URL は、無いファイルでも index.html を返すことがあるため
        const parts = rel.split('/');
        if (parts[0] === 'themes' || parts[0] === 'sample') {
          let node = await bundleList();
          for (const part of parts) { node = node && Object.prototype.hasOwnProperty.call(node, part) ? node[part] : undefined; }
          if (node !== null) return null; // null = ファイル（ある）、undefined = 無い、オブジェクト = フォルダ
        }
        const res = await fetch('/' + parts.map(encodeURIComponent).join('/'));
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      },
      async list(rel) {
        let node = await bundleList();
        for (const part of rel.split('/')) { node = node && node[part]; }
        return node ? Object.keys(node).map((name) => ({ name, isDir: node[name] !== null })) : [];
      },
    },
    zip: { write: (entries) => KS.zip.writeZipAsync(entries), read: (bytes) => KS.zip.readZipAsync(bytes) },
    async pdf(html, pdf, o) {
      try {
        await wrap(invoke('print_pdf', { html, pdf, kind: o.kind, width: o.width || 1280, height: o.height || 720 }));
      } catch (e) {
        if (/unsupported/.test(e.message)) {
          throw new KS.backend.UserError('この OS では、まだ PDF を直接作れません。HTML を書き出して開き、印刷（Ctrl+P / ⌘P）→「PDF に保存」をお使いください。', 501);
        }
        throw new KS.backend.UserError('PDF の生成に失敗しました: ' + e.message, 500);
      }
    },
    reveal: (p) => wrap(invoke('reveal', { path: p })),
  };

  const backend = KS.backend.createBackend(host, { desktop: true });
  const ready = (async () => { info = await invoke('app_info'); })();

  // ---- API（ブラウザ版の /api/… と同じ） ----
  async function api(method, url, body) {
    await ready;
    const u = new URL(url, 'http://app');
    const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let data = body;
    if (body instanceof Blob) data = new Uint8Array(await body.arrayBuffer());
    const r = await backend.api(method, seg, Object.fromEntries(u.searchParams), data);
    if (r.status >= 400) throw new Error((r.json && r.json.error) || String(r.status));
    // 保存先の無いプロジェクト（サンプルなど）を書き換えたら覚えておく（閉じるときの確認に使う）
    if (method !== 'GET' && seg[1] === 'project' && seg[2] !== 'export' && seg[2] !== 'export-file' && backend.project && backend.project.temporary) unsavedEdits = true;
    return r.json;
  }
  let unsavedEdits = false;

  /** プロジェクト内のファイル（画像）を画面で表示する URL（asset プロトコル） */
  function fileUrl(rel) {
    const p = backend.project;
    if (!p) return rel;
    let clean = String(rel).split(/[?#]/)[0];
    try { clean = decodeURI(clean); } catch (e) { /* そのまま */ }
    // プロジェクトの外（../ や絶対パス）を指すものは表示しない
    const full = P.inside(p.dir, clean);
    return full ? T.core.convertFileSrc(full) : '';
  }

  // ---- 発表・資料のプレビュー（別ウィンドウ） ----
  async function openPage(kind, hash, notes) {
    await ready;
    const p = backend.project;
    if (!p) return;
    // 画像は HTML に埋め込む（発表者ビューは window.open の別ウィンドウで、そこからは asset プロトコルの画像を読めないため）
    const o = { assets: 'embed', scriptUrl: location.origin + '/vendor/mermaid.min.js', notes };
    const built = kind === 'present' ? await backend.buildDeck(p, o) : await backend.buildDocument(p, o);
    const dir = P.join(info.userData, 'preview');
    await host.mkdir(dir);
    const file = P.join(dir, kind + '.html');
    await host.writeFile(file, built.html);
    // ウィンドウは Rust 側で作る（発表者ビューの別ウィンドウ＝window.open を許可するため）
    // 開けるのは preview フォルダの HTML だけ（Rust 側で確かめる）
    await wrap(invoke('open_page', {
      label: kind === 'present' ? 'present' : 'doc',
      file,
      hash: hash || '',
      title: (built.title || p.name) + (kind === 'present' ? ' — 発表' : ' — 資料'),
      width: kind === 'present' ? 1280 : 900,
      height: kind === 'present' ? 760 : 1000,
    }));
  }

  window.KSDesktop = {
    api,
    fileUrl,
    present: (index) => openPage('present', '#' + (index + 1)),
    docPreview: (notes) => openPage('doc', '', notes),
    backend,
    ready,
  };

  // ---- ファイルメニュー（OS のダイアログ） ----
  const D = T.dialog; // メッセージのダイアログだけに使う（ファイルを選ぶダイアログは Rust の pick）
  /**
   * ファイル / フォルダを選ぶ（kind: file / folder / save）。選んだ場所だけが、ファイル操作を許可される（main.rs の pick）。
   * @returns {Promise<string|null>}
   */
  const pickPath = (kind, o) => wrap(invoke('pick', { kind, title: o.title, defaultPath: o.defaultPath || null, filters: o.filters || null }));
  /** 許可していない場所（前の版の「最近使ったもの」など）なら、開いてよいか OS のダイアログで聞く */
  const allowed = (p) => wrap(invoke('confirm_open', { path: p }));
  const restart = () => window.KSE && window.KSE.restart();
  async function run(fn) {
    try {
      await ready;
      const before = backend.project;
      await fn();
      if (backend.project !== before || !(backend.project && backend.project.temporary)) unsavedEdits = false; // 開き直した・保存した
      await restart();
      updateTitle();
    } catch (e) {
      await D.message(e.message || String(e), { title: 'Kamishibai', kind: 'error' });
    }
  }

  /** 保存先を選んで .kami に保存する。保存したら true */
  async function saveAsKamiDialog() {
    const p = backend.project;
    const file = await pickPath('save', { title: '1 ファイル（.kami）として保存', defaultPath: (p ? p.name.replace(/（.*）/, '') : '発表') + '.kami', filters: [KAMI] });
    if (!file) return false;
    await backend.saveAsKami(/\.kami$/i.test(file) ? file : file + '.kami');
    unsavedEdits = false;
    return true;
  }

  /**
   * 保存先の無いプロジェクト（サンプル・新しいもの）を書き換えたまま、閉じる・別のものを開くときの確認。
   * 続けてよければ true（保存した / 保存しないを選んだ）、キャンセルなら false。
   */
  let asking = false;
  async function confirmLeave(what) {
    await ready;
    const p = backend.project;
    if (!p || !p.temporary || !unsavedEdits) return true;
    if (asking) return false; // 確認の最中にもう一度閉じようとした（× の連打など）
    asking = true;
    try { return await askLeave(p, what); } finally { asking = false; }
  }
  async function askLeave(p, what) {
    if (window.KSE && window.KSE.flushSave) await window.KSE.flushSave();
    const SAVE = '保存する', DISCARD = '保存しない', CANCEL = 'キャンセル';
    const r = await D.message(
      '「' + p.name.replace(/（.*）/, '') + '」はまだ保存していません。' + what + '前に保存しますか？\n\n保存しないと、加えた変更は失われます。',
      { title: 'Kamishibai', kind: 'warning', buttons: { yes: SAVE, no: DISCARD, cancel: CANCEL } });
    if (r === SAVE || r === 'Yes') {
      try { return await saveAsKamiDialog(); } catch (e) { await D.message(e.message || String(e), { title: 'Kamishibai', kind: 'error' }); return false; }
    }
    return r === DISCARD || r === 'No';
  }
  /** 確認してから run する */
  const leave = (what, fn) => async () => { if (await confirmLeave(what)) await run(fn); };
  function updateTitle() {
    const p = backend.project;
    T.window.getCurrentWindow().setTitle(p ? p.name + (p.kamiFile ? '.kami' : '') + ' — Kamishibai' : 'Kamishibai');
  }
  const pathOf = (r) => (r && typeof r === 'object' && r.path ? r.path : r);

  window.kamishibaiApp = {
    desktop: true,
    newProject: (kind) => leave('新しく作る', async () => {
      const target = kind === 'kami'
        ? await pickPath('save', { title: '新しい 1 ファイル（.kami）を作る', defaultPath: '新しい発表.kami', filters: [KAMI] })
        : await pickPath('save', { title: '新しいプロジェクトのフォルダを作る（フォルダ名を入力）', defaultPath: '新しい発表' });
      if (!target) return;
      if (kind === 'kami') await backend.createKami(/\.kami$/i.test(target) ? target : target + '.kami');
      else await backend.createFolder(target);
    })(),
    openFolder: leave('別のものを開く', async () => {
      const dir = pathOf(await pickPath('folder', { title: 'プロジェクトのフォルダを開く（slides.md のあるフォルダ）' }));
      if (dir) await backend.open(dir);
    }),
    openFile: leave('別のものを開く', async () => {
      const file = pathOf(await pickPath('file', { title: 'ファイルを開く', filters: [KAMI, { name: 'slides.md', extensions: ['md'] }] }));
      if (file) await backend.open(file);
    }),
    openPath: (p) => leave('別のものを開く', async () => { if (await allowed(p)) await backend.open(p); })(),
    openSample: leave('サンプルを開く', () => backend.openSample()),
    saveAsKami: () => run(saveAsKamiDialog),
    saveAsFolder: () => run(async () => {
      const dir = await pickPath('save', { title: 'フォルダとして保存（新しいフォルダ名を入力）', defaultPath: backend.project ? backend.project.name.replace(/（.*）/, '') : '発表' });
      if (dir) await backend.saveAsFolder(dir);
    }),
    close: leave('閉じる', () => backend.close()),
    reveal: async () => { const p = backend.project; if (p && !p.temporary) await wrap(invoke('reveal', { path: p.kamiFile || p.dir })); },
    openExported: (file) => wrap(invoke('open_exported', { path: file })),
    /** 読み込む自作テーマを選ぶ（kind: folder = フォルダ / file = theme.json か zip） */
    async pickThemeSource(kind) {
      await ready;
      const r = kind === 'folder'
        ? await pickPath('folder', { title: 'テーマのフォルダを選ぶ（theme.json の入ったフォルダ）' })
        : await pickPath('file', { title: 'テーマを選ぶ（theme.json か zip）', filters: [{ name: 'テーマ', extensions: ['json', 'zip'] }] });
      return pathOf(r) || null;
    },
    /** テーマの書き出し先（zip）を選ぶ */
    async pickThemeExport(id) {
      await ready;
      const file = await pickPath('save', { title: 'テーマを zip に書き出す', defaultPath: id + '.zip', filters: [{ name: 'zip', extensions: ['zip'] }] });
      if (!file) return null;
      return /\.zip$/i.test(file) ? file : file + '.zip';
    },
    /** 書き出し先を選ぶ（null ならキャンセル） */
    async chooseExportPath(o) {
      await ready;
      const p = backend.project;
      const ext = o.format;
      const names = { html: 'HTML', pdf: 'PDF', docx: 'Word', odt: 'OpenDocument テキスト', pptx: 'PowerPoint', odp: 'OpenDocument プレゼンテーション' };
      const base = (p ? p.name.replace(/（.*）/, '') : '発表') + (o.kind === 'doc' ? '-資料' : '');
      const dir = p ? p.defaultOutDir() : '';
      const file = await pickPath('save', {
        title: '書き出し先を選ぶ',
        defaultPath: dir && !p.temporary ? P.join(dir, base + '.' + ext) : base + '.' + ext,
        filters: [{ name: names[ext] || ext, extensions: [ext] }],
      });
      if (!file) return null;
      return new RegExp('\\.' + ext + '$', 'i').test(file) ? file : file + '.' + ext;
    },
  };

  // ---- 起動時に渡されたファイル（.kami のダブルクリックなど）と、2 つ目の起動 ----
  window.KSDesktop.startup = (async () => {
    await ready;
    if (info.args && info.args.length) {
      try { await backend.open(info.args[0]); } catch (e) { await D.message(e.message, { title: 'Kamishibai', kind: 'error' }); }
    } else {
      // 設定「起動したとき、前回開いていたファイルを開く」（既定で入）。開けなければスタート画面のまま
      let openLast = true;
      try { openLast = localStorage.getItem('ks.openLast') !== '0'; } catch (e) { /* 既定のまま */ }
      if (openLast) {
        try { const list = await backend.recent(); if (list[0]) await backend.open(list[0].path); } catch (e) { /* スタート画面を出す */ }
      }
    }
    updateTitle();
  })();
  T.event.listen('open-paths', (e) => { if (e.payload && e.payload[0]) window.kamishibaiApp.openPath(e.payload[0]); });

  // ブラウザとしての操作を止める。裏側（backend）が画面の中で動いているので、
  // 「最新の情報に更新」「戻る」をされると開いていたプロジェクトを見失ってスタート画面に戻ってしまう。
  //   ・右クリックのブラウザのメニュー … 入力欄（コピー・貼り付けに使う）以外では出さない
  //   ・F5 / Ctrl+R（再読み込み）、Alt+← / Alt+→ / BrowserBack（戻る・進む）… 無効
  const editable = (t) => !!(t && t.closest && t.closest('input, textarea, [contenteditable="true"], .cm-content'));
  window.addEventListener('contextmenu', (e) => { if (!editable(e.target)) e.preventDefault(); }, true);
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    const reload = k === 'F5' || ((e.ctrlKey || e.metaKey) && (k === 'r' || k === 'R'));
    const nav = (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) || k === 'BrowserBack' || k === 'BrowserForward';
    if (reload || nav) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // マウスの「戻る」ボタン
  window.addEventListener('mouseup', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);

  // 閉じる前に .kami への書き戻しを済ませる
  const win = T.window.getCurrentWindow();
  win.onCloseRequested(async (e) => {
    e.preventDefault();
    if (!(await confirmLeave('アプリを終了する'))) return;
    try { if (window.KSE && window.KSE.flushSave) await window.KSE.flushSave(); await backend.flush(); } finally { await win.destroy(); }
  });
})();
