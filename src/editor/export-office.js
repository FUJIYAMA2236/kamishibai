/*
 * export-office.js — Word（.docx）/ OpenDocument テキスト（.odt）/ PowerPoint（.pptx）/ OpenDocument プレゼンテーション（.odp）の書き出し。
 *
 *   原稿 → 文書   : core/docmodel.js で部品の並びにし、core/docx.js / odt.js で中身を作る
 *   スライド → 発表資料: 描画済みのスライドから export-scene.js でシーンを取り出し、core/pptx.js / odp.js で中身を作る
 *
 * 画像の読み込み・SVG や mermaid の画像化はブラウザ（この画面）でしかできないので、ここで済ませてから組み立てる。
 * できたバイト列は app.saveExport（保存先へ書く）に渡す。
 */
(function () {
  'use strict';
  const app = window.KSE;
  const KS = window.KS;
  const RT = window.Kamishibai;
  const O = KS.office;

  const FORMATS = {
    docx: { kind: 'doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    odt: { kind: 'doc', mime: 'application/vnd.oasis.opendocument.text' },
    pptx: { kind: 'slides', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    odp: { kind: 'slides', mime: 'application/vnd.oasis.opendocument.presentation' },
  };

  // ------------------------------------------------------------------
  // 原稿 → 文書（Word / ODT）
  // ------------------------------------------------------------------
  /** 画像（slides.md に書かれたパス）を読み込む。SVG・WebP などは PNG にする */
  async function loadImage(src) {
    const url = app.assetUrl(src);
    const isSvg = /\.svg(\?|#|$)/i.test(src) || /^data:image\/svg/.test(src);
    if (!isSvg) {
      const m = await app.exportScene.fetchBytes(url);
      if (/^image\/(png|jpeg|gif)$/.test(m.mime)) {
        const size = O.imageSize(m.data);
        if (size) return Object.assign(m, size);
      }
    }
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 800;
    const h = img.naturalHeight || 600;
    const k = isSvg ? 2 : 1; // SVG はくっきり見えるよう 2 倍で
    const r = await app.exportScene.rasterize(url, w * k, h * k);
    return Object.assign(r, { width: w, height: h });
  }

  /** mermaid の図を、白い紙に合う色で描いて PNG にする */
  async function renderMermaidPng(code, tokens) {
    const host = document.createElement('div');
    const paper = Object.assign({}, tokens, { bg: '#ffffff', text: '#22252c', surface: '#f3f4f7', muted: '#6b7280' });
    host.setAttribute('style', KS.render.tokensToStyle(paper) + ';position:fixed;left:-10000px;top:0;width:900px;background:#fff;color:#22252c');
    host.className = 'ks-deck';
    const box = document.createElement('div');
    box.className = 'ks-mermaid';
    const pre = document.createElement('pre');
    pre.className = 'ks-mermaid-src';
    pre.textContent = code;
    const outEl = document.createElement('div');
    outEl.className = 'ks-mermaid-out';
    box.append(pre, outEl);
    host.append(box);
    document.body.append(host);
    try {
      // 文字も SVG で描いた図にする（画面用の図は文字が HTML なので画像にできない）
      const text = await RT.mermaidPlainSvg(code, host);
      if (!text) return null;
      const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
      const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      const w = Math.round(vb[2] || 600);
      const h = Math.round(vb[3] || 300);
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.removeAttribute('style');
      const png = await app.exportScene.svgToPng(new XMLSerializer().serializeToString(svg), w, h, 2);
      return Object.assign(png, { width: w, height: h });
    } finally {
      host.remove();
    }
  }

  async function buildDocument(format, warn) {
    const st = app.state;
    const theme = app.currentTheme();
    const doc = KS.docmodel.build(st.md, st.design, theme, { md: app.md, notes: localStorage.getItem('ks.docNotes') === '1' });
    const need = KS.docmodel.collectMedia(doc.blocks);
    const images = new Map();
    const mermaid = new Map();
    for (const src of need.images) {
      try { images.set(src, await loadImage(src)); } catch (e) { warn('画像を読み込めませんでした: ' + src); }
    }
    for (const code of need.mermaid) {
      try { mermaid.set(code, await renderMermaidPng(code, doc.resolved.tokens)); } catch (e) { warn('図（mermaid）を画像にできませんでした'); }
    }
    const media = { image: (src) => images.get(src) || null, mermaid: (code) => mermaid.get(code) || null };
    const opts = { title: doc.meta.title || st.name, author: doc.meta.author };
    return format === 'docx' ? KS.docx.buildDocx(doc, media, opts) : KS.odt.buildOdt(doc, media, opts);
  }

  // ------------------------------------------------------------------
  // スライド → PowerPoint / ODP
  // ------------------------------------------------------------------
  /** ノートの Markdown を、読みやすいプレーンテキストに */
  function plainNotes(text) {
    return String(text || '')
      .replace(/^\s*[-*+]\s+/gm, '・')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`|~~)/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
  }

  async function buildSlides(format, warn) {
    const st = app.state;
    const slides = app.slideElements();
    // mermaid の図がまだ描かれていなければ描く（mermaid は後から読み込まれるので、届くまで少し待つ）
    if (slides.some((s) => s && s.querySelector('.ks-mermaid'))) {
      for (let i = 0; i < 50 && !window.mermaid; i++) await new Promise((r) => setTimeout(r, 200));
      for (const s of slides) {
        if (s && Array.from(s.querySelectorAll('.ks-mermaid-out')).some((o) => !o.querySelector('svg'))) await RT.renderMermaid(s);
      }
      await RT.renderMermaid(document.createElement('div')); // 描画中の仕事が終わるのを待つ
    }
    const W = st.out.width;
    const H = st.out.height;
    const scenes = [];
    for (let i = 0; i < slides.length; i++) {
      const el = slides[i];
      if (!el) continue;
      const scene = app.exportScene.sceneOf(el, W, H);
      scene.notes = plainNotes(st.parsed.slides[i] && st.parsed.slides[i].notes);
      scenes.push(await app.exportScene.resolveMedia(scene, warn));
    }
    const tokens = st.out.resolved.tokens;
    const fonts = KS.docmodel.pickFonts(tokens.fontBody);
    const opts = { title: st.out.title || st.name, author: st.parsed.meta.author, accent: tokens.accent, accent2: tokens.accent2, font: fonts.ja };
    return format === 'pptx' ? KS.pptx.buildPptx(scenes, opts) : KS.odp.buildOdp(scenes, opts);
  }

  /**
   * @param {string} format docx | odt | pptx | odp
   * @param {string|null} out 書き出し先（null なら既定の場所）
   * @returns {Promise<{file, bytes, warnings}>}
   */
  async function exportOffice(format, out) {
    const f = FORMATS[format];
    if (!f) throw new Error('不明な形式です: ' + format);
    const warnings = [];
    const warn = (m) => { if (warnings.indexOf(m) < 0) warnings.push(m); };
    const entries = f.kind === 'doc' ? await buildDocument(format, warn) : await buildSlides(format, warn);
    const bytes = await KS.zip.writeZipAsync(entries);
    const r = await app.saveExport({ kind: f.kind, format, out, data: new Blob([bytes], { type: f.mime }) });
    return Object.assign({}, r, { warnings: warnings.concat(r.warnings || []) });
  }

  app.exportOffice = exportOffice;
  app.exportOfficeFormats = FORMATS;
})();
