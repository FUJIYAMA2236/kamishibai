/*
 * office-common.js — Word / ODF / PowerPoint 書き出しで共通に使う小道具（XML のエスケープ・色・画像の大きさ）。
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.KS = root.KS || {}).office = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** XML の文字としてエスケープ（XML で使えない制御文字も落とす） */
  const x = (s) => String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- 色 ----
  function parseColor(c) {
    const s = String(c || '').trim();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (m) {
      let hx = m[1];
      if (hx.length === 3) hx = hx.replace(/./g, '$&$&');
      return { r: parseInt(hx.slice(0, 2), 16), g: parseInt(hx.slice(2, 4), 16), b: parseInt(hx.slice(4, 6), 16), a: hx.length === 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1 };
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
    if (m) {
      let a = m[4] == null ? 1 : parseFloat(m[4]);
      if (m[4] && m[4].endsWith('%')) a /= 100;
      return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a };
    }
    return null;
  }
  /** "RRGGBB"（# なし。Office の XML 用）。読めない色は fallback */
  function hex6(c, fallback) {
    const p = parseColor(c);
    if (!p) return fallback == null ? null : fallback;
    return [p.r, p.g, p.b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  const alpha = (c) => { const p = parseColor(c); return p ? p.a : 0; };
  function luminance(c) {
    const p = parseColor(c);
    if (!p) return 1;
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b);
  }
  function mix(a, b, t) {
    const p = parseColor(a);
    const q = parseColor(b);
    if (!p || !q) return a;
    return '#' + [[p.r, q.r], [p.g, q.g], [p.b, q.b]].map(([u, v]) => Math.round(u * t + v * (1 - t)).toString(16).padStart(2, '0')).join('');
  }
  /** 白い紙の上で読める濃さにする（明るすぎる色を暗くする） */
  function onPaper(c) {
    let col = parseColor(c) ? c : '#333333';
    for (let i = 0; i < 6 && luminance(col) > 0.32; i++) col = mix(col, '#000000', 0.82);
    return col;
  }
  /** 背景色の上の文字色 */
  const textOn = (c) => (luminance(c) > 0.42 ? '#1b1b1f' : '#ffffff');

  // ---- 画像の大きさ ----
  /**
   * 文書に置く画像の幅・高さ（mm）
   * @param {Object} img { width, height }（{width=…} の指定。'50%' / '300'(px) / '300px'）
   * @param {Object} natural { width, height }（画像そのものの px）
   * @param {number} maxW 置ける幅（mm）
   * @param {number} maxH 置ける高さ（mm）
   */
  function fitImage(img, natural, maxW, maxH) {
    const PX = 25.4 / 96; // 1px = 0.2646mm
    const nw = natural.width || 800;
    const nh = natural.height || 600;
    const ratio = nh / nw;
    let w;
    const spec = (v) => (v == null ? null : String(v));
    const ws = spec(img.width);
    const hs = spec(img.height);
    if (ws && /%$/.test(ws)) w = (maxW * parseFloat(ws)) / 100;
    else if (ws && /^[\d.]+(px)?$/.test(ws)) w = parseFloat(ws) * PX;
    else if (hs && /^[\d.]+(px)?$/.test(hs)) w = (parseFloat(hs) * PX) / ratio;
    else w = Math.min(nw * PX, maxW);
    w = Math.min(w, maxW);
    let hh = w * ratio;
    if (hh > maxH) { hh = maxH; w = hh / ratio; }
    return { w, h: hh };
  }

  /** PNG / JPEG / GIF / WebP のバイト列から px の大きさを読む（読めなければ null） */
  function imageSize(data) {
    const b = data;
    if (!b || b.length < 24) return null;
    const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    if (b[0] === 0x89 && b[1] === 0x50) return { width: u32(16), height: u32(20) };
    if (b[0] === 0x47 && b[1] === 0x49) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      while (o < b.length - 9) {
        if (b[o] !== 0xff) { o++; continue; }
        const marker = b[o + 1];
        const len = (b[o + 2] << 8) | b[o + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: (b[o + 7] << 8) | b[o + 8], height: (b[o + 5] << 8) | b[o + 6] };
        }
        o += 2 + len;
      }
    }
    return null;
  }

  /**
   * 文字の箱を少し広げる（PowerPoint などはブラウザと文字の幅がわずかに違い、早めに折り返してしまうため）。
   * 中央揃え・右揃えの文字がずれないよう、広げた分だけ左へ動かす。1 行の文字（single）は折り返さない設定にするので広げない
   */
  function widen(it, roomy) {
    // roomy: 1 行の文字も広げる（「折り返さない」設定が効かないソフト向け。ODP 用）
    if (it.single && !roomy) return it;
    const dw = it.single ? it.w * 0.15 + 10 : it.w * 0.04 + 4;
    const align = it.paras && it.paras[0] && it.paras[0].align;
    const dx = align === 'ctr' ? dw / 2 : align === 'r' ? dw : 0;
    return Object.assign({}, it, { x: it.x - dx, w: it.w + dw });
  }

  const MM_TO_EMU = 36000;
  const PX_TO_EMU = 9525;
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

  return { x, parseColor, hex6, alpha, luminance, mix, onPaper, textOn, fitImage, imageSize, widen, MM_TO_EMU, PX_TO_EMU, EXT };
});
