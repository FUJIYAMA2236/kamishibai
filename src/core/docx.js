/*
 * docx.js — 文書モデル（docmodel.js）→ Word（.docx）の zip の中身。
 *
 *   buildDocx(doc, media, opts) → [{ name, data }]（zip.writeZip / writeZipAsync に渡す）
 *     doc   : docmodel.build() の結果
 *     media : { image(src) → { data: Uint8Array, mime, width, height } | null, mermaid(code) → 同じ | null }
 *             （画像の読み込み・図の画像化は呼び出し側＝ブラウザで済ませておく）
 *     opts  : { title, author }
 *
 * 用紙は A4 縦・余白 20mm。見出し・本文・引用・コード・表・リストは Word のスタイルとして定義するので、
 * Word 側でスタイルを変えれば全体の見た目を変えられる。
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./office-common'), require('./docmodel'));
  else (root.KS = root.KS || {}).docx = factory(root.KS.office, root.KS.docmodel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (O, docmodel) {
  'use strict';
  const { x, hex6, onPaper, textOn, fitImage, mix } = O;

  const PAGE = { w: 210, h: 297, margin: 20 };
  const CONTENT_W = PAGE.w - PAGE.margin * 2; // mm
  const TW = (mm) => Math.round((mm / 25.4) * 1440); // twips
  const EMU = (mm) => Math.round(mm * O.MM_TO_EMU);

  function buildDocx(doc, media, opts) {
    opts = opts || {};
    const tokens = doc.resolved.tokens;
    const fonts = docmodel.pickFonts(tokens.fontBody);
    const hfonts = docmodel.pickFonts(tokens.fontHeading);
    const mono = docmodel.pickFonts(tokens.fontMono);
    const accent = hex6(onPaper(tokens.accent), '2F5597');

    const rels = []; // [{ id, type, target, mode }]
    const files = [];
    let relN = 0;
    const addRel = (type, target, external) => {
      const id = 'rIdK' + ++relN;
      rels.push({ id, type, target, external });
      return id;
    };
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    let imageN = 0;
    let drawingN = 0;
    const imageCache = new Map();
    function embed(m) {
      if (imageCache.has(m.data)) return imageCache.get(m.data);
      const ext = O.EXT[m.mime] || 'png';
      const name = 'image' + ++imageN + '.' + ext;
      files.push({ name: 'word/media/' + name, data: m.data, store: true });
      const id = addRel(R + 'image', 'media/' + name);
      imageCache.set(m.data, id);
      return id;
    }

    // ---- 番号付きリスト: 新しいリストごとに番号を 1 から振り直す ----
    const nums = []; // [{ id, abs, start }]
    let curOrdered = null;
    const BULLET_NUM = 1;
    nums.push({ id: BULLET_NUM, abs: 0 });

    // ---- 文字 ----
    function runXml(r, base) {
      base = base || {};
      if (r.br) return '<w:r><w:br/></w:r>';
      const pr = [];
      if (r.code) pr.push('<w:rFonts w:ascii="' + x(mono.latin) + '" w:hAnsi="' + x(mono.latin) + '" w:eastAsia="' + x(mono.ja) + '"/>');
      if (r.bold || base.bold) pr.push('<w:b/><w:bCs/>');
      if (r.italic) pr.push('<w:i/>');
      if (r.strike) pr.push('<w:strike/>');
      if (base.color) pr.push('<w:color w:val="' + base.color + '"/>');
      else if (r.link) pr.push('<w:color w:val="' + accent + '"/>');
      if (r.small) pr.push('<w:sz w:val="18"/>');
      if (r.link) pr.push('<w:u w:val="single"/>');
      if (r.mark) pr.push('<w:highlight w:val="yellow"/>');
      if (r.code) pr.push('<w:shd w:val="clear" w:color="auto" w:fill="EEF0F4"/>');
      const parts = String(r.text).split('\t');
      const t = parts.map((p, i) => (i ? '<w:tab/>' : '') + '<w:t xml:space="preserve">' + x(p) + '</w:t>').join('');
      return '<w:r>' + (pr.length ? '<w:rPr>' + pr.join('') + '</w:rPr>' : '') + t + '</w:r>';
    }
    function runsXml(runs, base) {
      let out = '';
      let i = 0;
      while (i < runs.length) {
        const r = runs[i];
        if (r.link && /^(https?:|mailto:)/i.test(r.link)) {
          const href = r.link;
          let inner = '';
          while (i < runs.length && runs[i].link === href) inner += runXml(runs[i++], base);
          out += '<w:hyperlink r:id="' + addRel(R + 'hyperlink', href, true) + '">' + inner + '</w:hyperlink>';
        } else {
          out += runXml(r, base);
          i++;
        }
      }
      return out;
    }
    const para = (pPr, content) => '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + (content || '') + '</w:p>';

    // ---- 画像 ----
    function drawing(m, wmm, hmm, alt) {
      const rid = embed(m);
      const id = ++drawingN;
      const cx = EMU(wmm);
      const cy = EMU(hmm);
      return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
        '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + id + '" name="図 ' + id + '" descr="' + x(alt || '') + '"/>' +
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="' + id + '" name="image' + id + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
        '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    }
    function imageBlock(img, maxW) {
      const m = media.image(img.src);
      if (!m) return para('<w:pStyle w:val="Caption"/>', runXml({ text: '［画像: ' + (img.alt || img.src) + '］' }));
      const size = fitImage(img, m, maxW, 200);
      return para('<w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/>', drawing(m, size.w, size.h, img.alt)) +
        (img.title ? para('<w:pStyle w:val="Caption"/><w:jc w:val="center"/>', runXml({ text: img.title })) : '');
    }

    // ---- ブロック ----
    function blocksXml(blocks, ctx) {
      ctx = ctx || { width: CONTENT_W };
      return blocks.map((b) => blockXml(b, ctx)).join('');
    }
    function blockXml(b, ctx) {
      switch (b.type) {
        case 'heading': {
          const lvl = Math.min(4, b.level);
          return para('<w:pStyle w:val="' + (lvl === 1 ? 'Title' : 'Heading' + (lvl - 1)) + '"/>', runsXml(b.runs, ctx.base));
        }
        case 'para': {
          const pr = [];
          if (b.meta) pr.push('<w:pStyle w:val="Subtitle"/>');
          if (b.list) {
            let numId = BULLET_NUM;
            if (b.list.ordered) {
              if (!curOrdered || (b.list.level === 0 && b.list.num === 1 && !b.list.cont)) {
                curOrdered = { id: nums.length + 1, abs: 1 };
                nums.push(curOrdered);
              }
              numId = curOrdered.id;
            }
            if (b.list.cont) pr.push('<w:pStyle w:val="ListParagraph"/><w:ind w:left="' + (360 * (b.list.level + 1) + 360) + '"/>');
            else pr.push('<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="' + Math.min(8, b.list.level) + '"/><w:numId w:val="' + numId + '"/></w:numPr>');
          } else if (b.quote) {
            pr.push('<w:pStyle w:val="Quote"/>');
          }
          if (!b.list) curOrdered = b.list ? curOrdered : null;
          if (ctx.align) pr.push('<w:jc w:val="' + ctx.align + '"/>');
          return para(pr.join(''), runsXml(b.runs, ctx.base));
        }
        case 'code': {
          const lines = b.text.split('\n');
          return lines.map((l, i) => para('<w:pStyle w:val="Code"/>' + (i === 0 ? '<w:spacing w:before="120"/>' : '') + (i === lines.length - 1 ? '<w:spacing w:after="160"/>' : ''),
            runXml({ text: l || ' ' }))).join('');
        }
        case 'mermaid': {
          const m = media.mermaid(b.code);
          if (!m) return blockXml({ type: 'code', text: b.code }, ctx);
          const size = fitImage({}, m, ctx.width, 200);
          return para('<w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/>', drawing(m, size.w, size.h, '図'));
        }
        case 'image': return imageBlock(b, ctx.width);
        case 'images': {
          const n = b.items.length;
          const w = (ctx.width - (n - 1) * 4) / n;
          const runs = b.items.map((img) => {
            const m = media.image(img.src);
            if (!m) return runXml({ text: '［画像］' });
            const s = fitImage({}, m, w, 120);
            return drawing(m, s.w, s.h, img.alt);
          }).join(runXml({ text: '  ' }));
          return para('<w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/>', runs);
        }
        case 'table': return tableXml(b, ctx);
        case 'columns': return columnsXml(b, ctx);
        case 'note': {
          return para('<w:pStyle w:val="NoteLabel"/>', runXml({ text: 'ノート' })) +
            b.blocks.map((nb) => (nb.type === 'para' ? para('<w:pStyle w:val="Note"/>', runsXml(nb.runs)) : blockXml(nb, ctx))).join('');
        }
        case 'hr': return para('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D4DC"/></w:pBdr><w:spacing w:after="200"/>', '');
        default: return '';
      }
    }

    const border = (side, val, sz, color) => '<w:' + side + ' w:val="' + val + '" w:sz="' + sz + '" w:space="0" w:color="' + color + '"/>';
    function tableXml(b, ctx) {
      const n = Math.max(1, ...b.rows.map((r) => r.length));
      const colW = Math.floor(TW(ctx.width) / n);
      const grid = '<w:tblGrid>' + Array(n).fill('<w:gridCol w:w="' + colW + '"/>').join('') + '</w:tblGrid>';
      const rows = b.rows.map((row, ri) => {
        const cells = Array.from({ length: n }, (_, ci) => {
          const runs = row[ci] || [];
          const al = b.aligns[ci];
          const shade = ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF1F6"/>' : '';
          return '<w:tc><w:tcPr><w:tcW w:w="' + colW + '" w:type="dxa"/>' + shade + '</w:tcPr>' +
            para('<w:spacing w:before="40" w:after="40"/>' + (al ? '<w:jc w:val="' + (al === 'right' ? 'right' : al) + '"/>' : ''), runsXml(runs, ri === 0 ? { bold: true } : null)) + '</w:tc>';
        }).join('');
        return '<w:tr>' + (ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '') + cells + '</w:tr>';
      }).join('');
      const borders = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => border(s, 'single', 4, 'C9CED8')).join('') + '</w:tblBorders>';
      return '<w:tbl><w:tblPr><w:tblW w:w="' + colW * n + '" w:type="dxa"/>' + borders + '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>' + grid + rows + '</w:tbl>' + para('<w:spacing w:after="0"/>', '');
    }

    function columnsXml(b, ctx) {
      const n = b.cols.length;
      const gap = 4; // mm
      const wmm = (ctx.width - gap * (n - 1)) / n;
      const totalTw = TW(ctx.width);
      const colTw = Math.floor(TW(wmm));
      const gapTw = n > 1 ? Math.floor((totalTw - colTw * n) / (n - 1)) : 0;
      // 隙間も列として持つ（箱どうしの間を空けるため）
      const widths = [];
      for (let i = 0; i < n; i++) { widths.push(colTw); if (i < n - 1) widths.push(gapTw); }
      const grid = '<w:tblGrid>' + widths.map((w) => '<w:gridCol w:w="' + w + '"/>').join('') + '</w:tblGrid>';
      const cells = [];
      b.cols.forEach((col, i) => {
        const color = b.colors[i] || tokens.accent;
        let shade = '';
        let bd = '<w:tcBorders>' + ['top', 'left', 'bottom', 'right'].map((s) => border(s, 'nil', 0, 'auto')).join('') + '</w:tcBorders>';
        let base = null;
        if (b.style === 'outline') {
          bd = '<w:tcBorders>' + ['top', 'left', 'bottom', 'right'].map((s) => border(s, 'single', 12, hex6(color, '888888'))).join('') + '</w:tcBorders>';
          shade = '<w:shd w:val="clear" w:color="auto" w:fill="' + hex6(mix(color, '#ffffff', 0.08)) + '"/>';
        } else if (b.style === 'fill') {
          shade = '<w:shd w:val="clear" w:color="auto" w:fill="' + hex6(color, '888888') + '"/>';
          base = { color: hex6(textOn(color)) };
        } else if (b.style === 'card') {
          bd = '<w:tcBorders>' + border('top', 'single', 24, hex6(color, '888888')) + ['left', 'bottom', 'right'].map((s) => border(s, 'single', 4, 'D5D9E2')).join('') + '</w:tcBorders>';
          shade = '<w:shd w:val="clear" w:color="auto" w:fill="F7F8FB"/>';
        }
        const inner = blocksXml(col, { width: wmm - 6, base, align: b.style !== 'none' ? null : null }) || para('', '');
        cells.push('<w:tc><w:tcPr><w:tcW w:w="' + colTw + '" w:type="dxa"/>' + bd + shade + '<w:tcMar><w:top w:w="140" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="140" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tcMar></w:tcPr>' + inner + '</w:tc>');
        if (i < n - 1) cells.push('<w:tc><w:tcPr><w:tcW w:w="' + gapTw + '" w:type="dxa"/><w:tcBorders>' + ['top', 'left', 'bottom', 'right'].map((s) => border(s, 'nil', 0, 'auto')).join('') + '</w:tcBorders></w:tcPr>' + para('', '') + '</w:tc>');
      });
      const noBorders = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => border(s, 'nil', 0, 'auto')).join('') + '</w:tblBorders>';
      return '<w:tbl><w:tblPr><w:tblW w:w="' + totalTw + '" w:type="dxa"/>' + noBorders + '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
        grid + '<w:tr><w:trPr><w:cantSplit/></w:trPr>' + cells.join('') + '</w:tr></w:tbl>' + para('<w:spacing w:after="80"/>', '');
    }

    // ---- 本文 ----
    const body = blocksXml(doc.blocks);
    const sect = '<w:sectPr><w:pgSz w:w="' + TW(PAGE.w) + '" w:h="' + TW(PAGE.h) + '"/><w:pgMar w:top="' + TW(PAGE.margin) + '" w:right="' + TW(PAGE.margin) + '" w:bottom="' + TW(PAGE.margin) + '" w:left="' + TW(PAGE.margin) + '" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ' + NS + '><w:body>' + body + sect + '</w:body></w:document>';

    // ---- スタイル ----
    const rFonts = (f) => '<w:rFonts w:ascii="' + x(f.latin) + '" w:hAnsi="' + x(f.latin) + '" w:eastAsia="' + x(f.ja) + '" w:cs="' + x(f.latin) + '"/>';
    const pStyle = (id, name, ppr, rpr, extra) => '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' + (extra || '') + '<w:qFormat/>' +
      (ppr ? '<w:pPr>' + ppr + '</w:pPr>' : '') + (rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '') + '</w:style>';
    const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' + rFonts(fonts) + '<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="22252C"/></w:rPr></w:style>' +
      pStyle('Title', 'Title', '<w:spacing w:before="240" w:after="120"/><w:keepNext/>', rFonts(hfonts) + '<w:b/><w:sz w:val="52"/><w:color w:val="15171C"/>') +
      pStyle('Subtitle', 'Subtitle', '<w:spacing w:after="360"/>', '<w:sz w:val="20"/><w:color w:val="6B7280"/>') +
      pStyle('Heading1', 'heading 1', '<w:keepNext/><w:spacing w:before="420" w:after="160"/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="' + accent + '"/></w:pBdr><w:outlineLvl w:val="0"/>', rFonts(hfonts) + '<w:b/><w:sz w:val="34"/><w:color w:val="15171C"/>') +
      pStyle('Heading2', 'heading 2', '<w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/>', rFonts(hfonts) + '<w:b/><w:sz w:val="26"/><w:color w:val="' + accent + '"/>') +
      pStyle('Heading3', 'heading 3', '<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/>', rFonts(hfonts) + '<w:b/><w:sz w:val="22"/><w:color w:val="374151"/>') +
      pStyle('ListParagraph', 'List Paragraph', '<w:spacing w:after="60"/><w:contextualSpacing/>', '') +
      pStyle('Quote', 'Quote', '<w:ind w:left="400"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="' + accent + '"/></w:pBdr>', '<w:color w:val="4B5563"/>') +
      pStyle('Code', 'Code', '<w:spacing w:after="0" w:line="260" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F7"/><w:ind w:left="120" w:right="120"/>', rFonts(mono) + '<w:sz w:val="18"/>') +
      pStyle('Caption', 'caption', '<w:spacing w:after="200"/>', '<w:sz w:val="18"/><w:color w:val="6B7280"/>') +
      pStyle('NoteLabel', 'Note Label', '<w:keepNext/><w:spacing w:before="120" w:after="20"/><w:shd w:val="clear" w:color="auto" w:fill="FFF8E1"/><w:ind w:left="120"/>', '<w:b/><w:sz w:val="17"/><w:color w:val="9A6B00"/>') +
      pStyle('Note', 'Note', '<w:shd w:val="clear" w:color="auto" w:fill="FFF8E1"/><w:ind w:left="120" w:right="120"/><w:spacing w:after="60"/>', '<w:sz w:val="19"/><w:color w:val="5B4A1A"/>') +
      '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="' + accent + '"/><w:u w:val="single"/></w:rPr></w:style>' +
      '</w:styles>';

    const BULLETS = ['●', '○', '■', '●', '○', '■', '●', '○', '■'];
    const lvl = (i, ordered) => '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + (ordered ? 'decimal' : 'bullet') + '"/>' +
      '<w:lvlText w:val="' + (ordered ? '%' + (i + 1) + '.' : BULLETS[i]) + '"/><w:lvlJc w:val="left"/>' +
      '<w:pPr><w:ind w:left="' + (420 * (i + 1)) + '" w:hanging="300"/></w:pPr>' + (ordered ? '' : '<w:rPr><w:color w:val="' + accent + '"/><w:sz w:val="16"/></w:rPr>') + '</w:lvl>';
    const numberingXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + Array.from({ length: 9 }, (_, i) => lvl(i, false)).join('') + '</w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' + Array.from({ length: 9 }, (_, i) => lvl(i, true)).join('') + '</w:abstractNum>' +
      nums.map((n) => '<w:num w:numId="' + n.id + '"><w:abstractNumId w:val="' + n.abs + '"/>' + (n.abs === 1 ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : '') + '</w:num>').join('') +
      '</w:numbering>';

    const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdStyles" Type="' + R + 'styles" Target="styles.xml"/>' +
      '<Relationship Id="rIdNumbering" Type="' + R + 'numbering" Target="numbering.xml"/>' +
      '<Relationship Id="rIdSettings" Type="' + R + 'settings" Target="settings.xml"/>' +
      rels.map((r) => '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + x(r.target) + '"' + (r.external ? ' TargetMode="External"' : '') + '/>').join('') +
      '</Relationships>';
    const settingsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="840"/><w:characterSpacingControl w:val="compressPunctuation"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + x(opts.title || '') + '</dc:title><dc:creator>' + x(opts.author || '') + '</dc:creator>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>';
    const appXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Kamishibai</Application></Properties>';
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + R + 'officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="' + R + 'extended-properties" Target="docProps/app.xml"/></Relationships>';

    return [
      { name: '[Content_Types].xml', data: types },
      { name: '_rels/.rels', data: rootRels },
      { name: 'docProps/core.xml', data: coreXml },
      { name: 'docProps/app.xml', data: appXml },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: stylesXml },
      { name: 'word/numbering.xml', data: numberingXml },
      { name: 'word/settings.xml', data: settingsXml },
      { name: 'word/_rels/document.xml.rels', data: docRels },
    ].concat(files);
  }

  return { buildDocx };
});
