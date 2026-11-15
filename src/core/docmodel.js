/*
 * docmodel.js — 原稿（slides.md）を「文書の部品の並び」に変換する。Word（.docx）/ ODF（.odt）書き出しの共通の中間形式。
 *
 * 資料（読み物）形式と同じく、スライドの区切りをなくして 1 本の文書にする（render.renderDocument と同じ考え方）。
 *
 * blocks:
 *   { type: 'heading', level: 1-6, runs }
 *   { type: 'para', runs, list?: { ordered, level, num }, quote?: 深さ }
 *   { type: 'code', text, lang }
 *   { type: 'table', aligns: ['left'|'center'|'right'|''], rows: [[runs…]…] }（1 行目が見出し）
 *   { type: 'image', src, alt, title, width?, height? }        … src は slides.md に書かれたパス
 *   { type: 'images', items: [image…] }                        … 横に並べた画像
 *   { type: 'mermaid', code }
 *   { type: 'columns', style: none|outline|fill|card, colors: [], cols: [[blocks]] }
 *   { type: 'note', blocks }                                   … 発表者ノート（載せる指定のときだけ）
 *   { type: 'hr' }
 * runs: [{ text, bold, italic, strike, code, mark, small, link, br }]
 *
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parse'), require('./render'));
  else (root.KS = root.KS || {}).docmodel = factory(root.KS.parse, root.KS.render);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (parse, render) {
  'use strict';

  const decodeEntities = (s) => String(s).replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[k]));

  /** markdown-it の inline トークン → runs */
  function inlineRuns(children) {
    const runs = [];
    const st = { bold: 0, italic: 0, strike: 0, mark: 0, small: 0, link: [] };
    const push = (text, extra) => {
      if (!text) return;
      runs.push(Object.assign({
        text,
        bold: st.bold > 0 || undefined,
        italic: st.italic > 0 || undefined,
        strike: st.strike > 0 || undefined,
        mark: st.mark > 0 || undefined,
        small: st.small > 0 || undefined,
        link: st.link.length ? st.link[st.link.length - 1] : undefined,
      }, extra));
    };
    for (const t of children || []) {
      switch (t.type) {
        case 'text': push(t.content); break;
        case 'softbreak':
        case 'hardbreak': runs.push({ text: '', br: true }); break;
        case 'strong_open': st.bold++; break;
        case 'strong_close': st.bold--; break;
        case 'em_open': st.italic++; break;
        case 'em_close': st.italic--; break;
        case 's_open': st.strike++; break;
        case 's_close': st.strike--; break;
        case 'code_inline': push(t.content, { code: true }); break;
        case 'link_open': st.link.push(t.attrGet('href') || ''); break;
        case 'link_close': st.link.pop(); break;
        case 'image': push(t.content || '[画像]'); break;
        case 'html_inline': {
          const tag = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(t.content);
          if (!tag) break;
          const close = !!tag[1];
          const name = tag[2].toLowerCase();
          if (name === 'br') runs.push({ text: '', br: true });
          else if (name === 'mark') st.mark += close ? -1 : 1;
          else if (name === 'b' || name === 'strong') st.bold += close ? -1 : 1;
          else if (name === 'i' || name === 'em') st.italic += close ? -1 : 1;
          else if (name === 's' || name === 'del') st.strike += close ? -1 : 1;
          else if (name === 'small') st.small += close ? -1 : 1;
          break;
        }
        default:
          if (t.content) push(t.content);
      }
    }
    for (const r of runs) if (r.text) r.text = decodeEntities(r.text);
    return runs;
  }

  function imageOf(t) {
    const info = (t.meta && t.meta.ks) || {};
    return {
      type: 'image',
      src: t.attrGet('src') || '',
      alt: (t.children || []).map((c) => c.content).join(''),
      title: t.attrGet('title') || '',
      width: info.width,
      height: info.height,
    };
  }

  /** トークン列 → blocks（入れ子のリスト・引用を平らにする） */
  function toBlocks(tokens) {
    const blocks = [];
    const lists = []; // [{ ordered, num }]
    let quote = 0;
    let table = null;
    let row = null;
    let cellAlign = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      switch (t.type) {
        case 'heading_open': {
          const inline = tokens[i + 1];
          blocks.push({ type: 'heading', level: Number(t.tag.slice(1)), runs: inlineRuns(inline.children) });
          i += 2;
          break;
        }
        case 'bullet_list_open': lists.push({ ordered: false, num: 0 }); break;
        case 'ordered_list_open': lists.push({ ordered: true, num: Number(t.attrGet('start') || 1) - 1 }); break;
        case 'bullet_list_close':
        case 'ordered_list_close': lists.pop(); break;
        case 'list_item_open': if (lists.length) { lists[lists.length - 1].num++; lists[lists.length - 1].fresh = true; } break;
        case 'blockquote_open': quote++; break;
        case 'blockquote_close': quote--; break;
        case 'paragraph_open': {
          const inline = tokens[i + 1];
          i += 2;
          const ch = inline.children || [];
          const imgs = ch.filter((c) => c.type === 'image');
          const onlyImages = imgs.length && ch.every((c) => c.type === 'image' || c.type === 'softbreak' || c.type === 'hardbreak' || (c.type === 'text' && !c.content.trim()));
          if (onlyImages && !lists.length) {
            const items = imgs.map(imageOf);
            blocks.push(items.length === 1 ? items[0] : { type: 'images', items });
            break;
          }
          const p = { type: 'para', runs: inlineRuns(ch) };
          if (lists.length) {
            const cur = lists[lists.length - 1];
            // 同じ項目の 2 つ目以降の段落は、記号なしで字下げだけ
            p.list = { ordered: cur.ordered, level: lists.length - 1, num: cur.num, cont: !cur.fresh };
            cur.fresh = false;
          }
          if (quote) p.quote = quote;
          blocks.push(p);
          break;
        }
        case 'fence':
        case 'code_block': {
          const lang = (t.info || '').trim().split(/\s+/)[0];
          if (lang === 'mermaid') blocks.push({ type: 'mermaid', code: t.content });
          else blocks.push({ type: 'code', text: t.content.replace(/\n$/, ''), lang });
          break;
        }
        case 'table_open': table = { type: 'table', aligns: [], rows: [] }; break;
        case 'tr_open': row = []; break;
        case 'th_open':
        case 'td_open': {
          const m = /text-align:\s*(left|center|right)/.exec(t.attrGet('style') || '');
          cellAlign = m ? m[1] : '';
          if (table.rows.length === 0) table.aligns.push(cellAlign);
          break;
        }
        case 'inline': if (row) row.push(inlineRuns(t.children)); break;
        case 'tr_close': table.rows.push(row); row = null; break;
        case 'table_close': blocks.push(table); table = null; break;
        case 'hr': blocks.push({ type: 'hr' }); break;
        case 'html_block': {
          const text = decodeEntities(t.content.replace(/<[^>]+>/g, '')).trim();
          if (text) blocks.push({ type: 'para', runs: [{ text }] });
          break;
        }
        default: break;
      }
    }
    return blocks;
  }

  /**
   * @param {string} text slides.md
   * @param {Object} design deck.json
   * @param {Object} theme
   * @param {Object} opts { md: render.createMarkdown(), notes: ノートも載せるか }
   * @returns {{ meta, blocks, resolved }}
   */
  function build(text, design, theme, opts) {
    const md = opts.md;
    const parsed = parse.parseDeck(text);
    const resolved = render.resolveDesign(design, theme);
    const blocks = [];
    const meta = parsed.meta;
    let hasH1 = false;
    const COL_STYLES = ['none', 'outline', 'fill', 'card'];
    const pick = (v, allowed, f) => (allowed.indexOf(v) >= 0 ? v : f);
    parsed.slides.forEach((slide) => {
      const sd = resolved.slides[slide.id] || {};
      const pre = toBlocks(md.parse(slide.pre || '', {}));
      const cols = (slide.columns || ['']).map((c) => toBlocks(md.parse(c, {}))).filter((c) => c.length);
      const post = toBlocks(md.parse(slide.post || '', {}));
      const first = pre[0] || (cols[0] && cols[0][0]);
      if (first && first.type === 'heading' && first.level === 1) hasH1 = true;
      blocks.push(...pre);
      if (slide.columns.length > 1 && cols.length > 1) {
        if (!pre.length && cols[0][0] && cols[0][0].type === 'heading') blocks.push(cols[0].shift());
        const style = pick(sd.colStyle, COL_STYLES, pick(resolved.tokens.colStyle, COL_STYLES, 'none'));
        const colors = cols.map((c, k) => (Array.isArray(sd.colColors) && sd.colColors[k]) || resolved.tokens['colColor' + ((k % 4) + 1)] || (k % 2 ? resolved.tokens.accent2 : resolved.tokens.accent));
        blocks.push({ type: 'columns', style, colors, cols });
      } else {
        for (const c of cols) blocks.push(...c);
      }
      blocks.push(...post);
      if (opts.notes && slide.notes) blocks.push({ type: 'note', blocks: toBlocks(md.parse(slide.notes, {})) });
    });
    if (!hasH1 && meta.title) blocks.unshift({ type: 'heading', level: 1, runs: [{ text: meta.title }] });
    // 表紙の見出しの後ろに作成者・日付
    if (meta.author || meta.date) {
      const at = blocks.findIndex((b) => b.type === 'heading' && b.level === 1);
      if (at >= 0) blocks.splice(at + 1, 0, { type: 'para', meta: true, runs: [{ text: [meta.author, meta.date].filter(Boolean).join('　·　'), small: true }] });
    }
    return { meta, blocks, resolved };
  }

  /** 書き出しに必要な画像（src）と mermaid の一覧 */
  function collectMedia(blocks, out) {
    out = out || { images: new Set(), mermaid: new Set() };
    for (const b of blocks) {
      if (b.type === 'image') out.images.add(b.src);
      if (b.type === 'images') b.items.forEach((i) => out.images.add(i.src));
      if (b.type === 'mermaid') out.mermaid.add(b.code);
      if (b.type === 'columns') b.cols.forEach((c) => collectMedia(c, out));
      if (b.type === 'note') collectMedia(b.blocks, out);
    }
    return out;
  }

  /** CSS の font-family の並びから、ラテン文字用と日本語用のフォント名を選ぶ */
  // Office の文書では、受け取った人の PC にもありそうなフォントを選ぶ（CSS の並びの先頭の Web フォントは避ける）
  const OFFICE_FONTS = ['BIZ UDPGothic', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'Meiryo UI', 'BIZ UDPMincho', 'Yu Mincho', 'MS Gothic', 'BIZ UDGothic', 'MS Mincho',
    'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Hiragino Mincho ProN', 'Noto Sans JP', 'Noto Serif JP'];
  const MONO_FONTS = ['Consolas', 'Cascadia Code', 'Courier New', 'BIZ UDGothic', 'MS Gothic'];
  function pickFonts(family) {
    const text = String(family || '');
    const names = text.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => s && !/^(sans-serif|serif|monospace|system-ui)$/i.test(s));
    if (/monospace\s*$/.test(text)) {
      const latin = names.find((n) => MONO_FONTS.indexOf(n) >= 0) || 'Consolas';
      return { latin, ja: names.find((n) => /gothic/i.test(n) && MONO_FONTS.indexOf(n) >= 0) || 'MS Gothic' };
    }
    const serif = /(^|[\s,])serif\s*$/.test(text) && !/sans-serif\s*$/.test(text);
    const ja = names.find((n) => OFFICE_FONTS.indexOf(n) >= 0) || (serif ? 'Yu Mincho' : 'Yu Gothic');
    // 日本語の文書では、英数字も同じフォントにそろえたほうが自然
    return { latin: ja, ja, serif };
  }

  return { build, toBlocks, inlineRuns, collectMedia, pickFonts };
});
