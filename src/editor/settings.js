/*
 * settings.js — アプリの設定（スライドの見た目とは関係ないもの）。上のバーの歯車ボタン / Ctrl+, で開く。
 *
 *   画面の文字の大きさ … アプリでは WebView の拡大率（ブラウザの Ctrl + + と同じ）。画面全体が均等に大きくなるので、
 *                         プレビュー・図形エディタ・書き出しの位置計算はそのまま正しい。Ctrl + + / − / 0 でも変えられる。
 *                         ブラウザ版はブラウザ自身の拡大機能を使ってもらう（ページから拡大率は変えられない）
 *   原稿の文字の大きさ / 配色（OS に合わせる・ダーク・ライト）/ 編集パネルの位置 / 原稿の表示（ライブ・ソース）
 *   起動時に前回のファイルを開く（アプリだけ。tauri-host.js が読む）/ 書き出しの既定（画像の埋め込み・資料のノート）
 *
 * 値はこの PC の localStorage（ks.*）に入れる。プロジェクト（slides.md / deck.json）には入れない。
 */
(function () {
  'use strict';
  const app = window.KSE;
  const { h, toast } = app;
  const T = window.__TAURI__;
  const root = document.documentElement;

  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) { /* 保存できない環境 */ } };

  const UI_SIZES = [[0.9, '小さめ'], [1, '標準'], [1.15, '大きめ'], [1.3, '大'], [1.5, '特大']];
  const EDITOR_SIZES = [[13, '小さめ'], [15, '標準'], [17, '大きめ'], [19, '大'], [22, '特大']];
  const KEYS = ['ks.uiScale', 'ks.editorFont', 'ks.scheme', 'ks.sideLeft', 'ks.editorMode', 'ks.openLast', 'ks.embed', 'ks.docNotes'];

  // ---- 画面の文字の大きさ ----
  const uiScale = () => { const v = Number(get('ks.uiScale', 1)); return v >= 0.5 && v <= 3 ? v : 1; };
  function applyUiScale() {
    if (!T) return;
    try { T.webview.getCurrentWebview().setZoom(uiScale()).catch(() => {}); } catch (e) { /* 古い WebView */ }
  }
  function setUiScale(v) {
    set('ks.uiScale', Math.round(v * 100) / 100);
    applyUiScale();
  }
  function stepUiScale(dir) {
    const list = UI_SIZES.map((s) => s[0]);
    const cur = uiScale();
    // いまの値にいちばん近い段から 1 段上げ下げ（0 は標準に戻す）
    let near = 0;
    list.forEach((v, j) => { if (Math.abs(v - cur) < Math.abs(list[near] - cur)) near = j; });
    const i = dir === 0 ? list.indexOf(1) : Math.max(0, Math.min(list.length - 1, near + dir));
    setUiScale(list[i]);
    toast('画面の文字の大きさ: ' + Math.round(list[i] * 100) + '%');
    render();
  }

  // ---- 原稿の文字の大きさ ----
  const editorFont = () => { const v = Number(get('ks.editorFont', 15)); return v >= 10 && v <= 32 ? v : 15; };
  function applyEditorFont() {
    root.style.setProperty('--editor-fs', editorFont() + 'px');
    if (app.editor && app.editor.view) app.editor.view.requestMeasure();
  }

  // ---- 配色 ----
  const media = matchMedia('(prefers-color-scheme: light)');
  const schemePref = () => { const v = get('ks.scheme', 'auto'); return /^(auto|light|dark)$/.test(v) ? v : 'auto'; };
  function applyScheme() {
    const p = schemePref();
    root.dataset.scheme = p === 'auto' ? (media.matches ? 'light' : 'dark') : p;
  }
  media.addEventListener('change', applyScheme);
  /** 上のバーの明暗ボタン: いま見えているのと逆にする（OS に合わせる設定はここで解除） */
  function toggleScheme() {
    set('ks.scheme', root.dataset.scheme === 'light' ? 'dark' : 'light');
    applyScheme();
    render();
  }

  // ---- ダイアログ ----
  let dlg = null;
  let version = '';
  function seg(options, value, onChange) {
    const s = h('div', { class: 'seg' });
    for (const [v, label] of options) {
      s.append(h('button', { type: 'button', class: String(v) === String(value) ? 'is-active' : '', onclick: () => { onChange(v); render(); } }, label));
    }
    return s;
  }
  const row = (label, control, note) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('b', null, label), note ? h('small', null, note) : null), control);
  function check(key, def, label, onChange) {
    const input = h('input', { type: 'checkbox' });
    input.checked = get(key, def) === '1';
    input.addEventListener('change', () => { set(key, input.checked ? '1' : '0'); if (onChange) onChange(input.checked); });
    return h('label', { class: 'set-check' }, input, h('span', null, label));
  }
  const section = (title, ...rows) => h('section', { class: 'set-section' }, h('h3', null, title), ...rows);

  function render() {
    if (!dlg || !dlg.open) return;
    const body = dlg.querySelector('.set-body');
    body.innerHTML = '';
    const scale = uiScale();
    body.append(...[
      section('見た目',
        T
          ? row('画面の文字の大きさ', h('div', { class: 'set-ctl' }, seg(UI_SIZES, scale, setUiScale), h('span', { class: 'set-val' }, Math.round(scale * 100) + '%')),
            'ボタン・メニュー・パネルなど画面全体。Ctrl + + / − / 0 でも変えられます')
          : row('画面の文字の大きさ', h('p', { class: 'set-note' }, 'ブラウザ版では、ブラウザの拡大（Ctrl + + / −）をお使いください。')),
        row('原稿の文字の大きさ', h('div', { class: 'set-ctl' }, seg(EDITOR_SIZES, editorFont(), (v) => { set('ks.editorFont', v); applyEditorFont(); }), h('span', { class: 'set-val' }, editorFont() + 'px')), '「原稿」タブの文章だけ'),
        row('配色', seg([['auto', 'OS に合わせる'], ['dark', 'ダーク'], ['light', 'ライト']], schemePref(), (v) => { set('ks.scheme', v); applyScheme(); })),
        row('編集パネルの位置', seg([['0', '右（プレビューが左）'], ['1', '左']], get('ks.sideLeft', '0') === '1' ? '1' : '0', (v) => app.setLayout(v === '1')))),
      section('原稿',
        row('表示', seg([['live', 'ライブ（書きながら見た目に）'], ['source', 'ソース（記号をすべて表示）']], get('ks.editorMode', 'live') === 'source' ? 'source' : 'live', (v) => app.setMode(v)))),
      T ? section('起動', check('ks.openLast', '1', '起動したとき、前回開いていたファイルを開く')) : null,
      section('書き出しの既定',
        check('ks.embed', '1', 'HTML に画像を埋め込む（1 ファイルにまとめる）', (on) => { const c = document.getElementById('embedImages'); if (c) c.checked = on; }),
        check('ks.docNotes', '0', '資料に発表者ノートも載せる', (on) => { const c = document.getElementById('docNotes'); if (c) c.checked = on; })),
    ].filter(Boolean));
    dlg.querySelector('.set-version').textContent = version ? 'Kamishibai ' + version : '';
  }

  // ---- ライセンスの表示（LICENSE と THIRD_PARTY_NOTICES.md をそのまま見せる） ----
  let lic = null;
  async function showLicenses() {
    if (!lic) {
      lic = h('dialog', { class: 'dialog license-dialog', 'aria-label': 'ライセンス' },
        h('h2', null, 'ライセンス'),
        h('pre', { class: 'license-text' }, '読み込み中…'),
        h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => lic.close() }, '閉じる')));
      lic.addEventListener('click', (e) => { if (e.target === lic) lic.close(); });
      document.body.append(lic);
      const read = (f) => fetch('/legal/' + f).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))).catch(() => '（' + f + ' を読み込めませんでした）');
      const [mine, others] = await Promise.all([read('LICENSE'), read('THIRD_PARTY_NOTICES.md')]);
      lic.querySelector('.license-text').textContent = '■ Kamishibai\n\n' + mine.trim() + '\n\n\n■ 含まれているオープンソースのソフトウェア\n\n' + others;
    }
    if (!lic.open) lic.showModal();
  }

  function reset() {
    if (!confirm('設定をすべて既定に戻しますか？（スライドの内容やデザインは変わりません）')) return;
    for (const k of KEYS) { try { localStorage.removeItem(k); } catch (e) { /* 無視 */ } }
    applyAll();
    app.setLayout(false);
    app.setMode('live');
    const e1 = document.getElementById('embedImages'); if (e1) e1.checked = true;
    const e2 = document.getElementById('docNotes'); if (e2) e2.checked = false;
    render();
    toast('設定を既定に戻しました');
  }

  function open() {
    if (!dlg) {
      dlg = h('dialog', { class: 'dialog settings-dialog', 'aria-label': '設定' },
        h('div', { class: 'set-head' }, h('h2', null, '設定'), h('small', null, 'この PC での Kamishibai の使い心地。スライドの内容・デザインには影響しません')),
        h('div', { class: 'set-body' }),
        h('div', { class: 'dialog-actions' },
          h('span', { class: 'set-version' }),
          h('button', { type: 'button', class: 'btn ghost small', onclick: showLicenses, title: 'Kamishibai と、含まれているオープンソースのライセンス' }, 'ライセンス'),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn ghost', onclick: reset }, '既定に戻す'),
          h('button', { type: 'button', class: 'btn primary', onclick: () => dlg.close() }, '閉じる')));
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
      document.body.append(dlg);
    }
    if (!dlg.open) dlg.showModal();
    render();
    if (!version) app.api('GET', '/api/state').then((s) => { version = s.version || ''; render(); }).catch(() => {});
  }

  function applyAll() {
    applyScheme();
    applyEditorFont();
    applyUiScale();
  }

  // キー操作: Ctrl+, で設定を開く。アプリでは Ctrl + + / − / 0 で画面の文字の大きさ
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    if (e.key === ',') { e.preventDefault(); open(); return; }
    if (!T || (app.diagram && app.diagram.state)) return; // 図形エディタの中では、図形エディタの拡大縮小に任せる
    if (e.key === '+' || e.key === '=' || e.key === ';') { e.preventDefault(); stepUiScale(1); }
    else if (e.key === '-') { e.preventDefault(); stepUiScale(-1); }
    else if (e.key === '0') { e.preventDefault(); stepUiScale(0); }
  }, true);

  applyAll();
  app.settings = { open, toggleScheme, applyAll, uiScale, editorFont };
})();
