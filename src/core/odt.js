/*
 * odt.js — 文書モデル（docmodel.js）→ OpenDocument テキスト（.odt）の zip の中身。
 * LibreOffice Writer・Word・Google ドキュメントで開ける国際標準（ISO/IEC 26300）の形式。
 *
 *   buildOdt(doc, media, opts) → [{ name, data, store? }]（引数は docx.js の buildDocx と同じ）
 *
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./office-common'), require('./docmodel'));
  else (root.KS = root.KS || {}).odt = factory(root.KS.office, root.KS.docmodel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (O, docmodel) {
  'use strict';
  const { x, hex6, onPaper, textOn, fitImage, mix } = O;

  const PAGE = { w: 210, h: 297, margin: 20 };
  const CONTENT_W = PAGE.w - PAGE.margin * 2;
  const mm = (v) => (Math.round(v * 100) / 100) + 'mm';
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0" office:version="1.3"';

  /** 文字列 → ODF のテキスト（連続した空白・タブ・改行を要素にする） */
  function textNodes(s) {
    return String(s).split('\n').map((line) => x(line)
      .replace(/\t/g, '<text:tab/>')
      .replace(/ {2,}/g, (m) => ' <text:s text:c="' + (m.length - 1) + '"/>')
      .replace(/^ /, '<text:s/>')).join('<text:line-break/>');
  }

  function buildOdt(doc, media, opts) {
    opts = opts || {};
    const tokens = doc.resolved.tokens;
    const fonts = docmodel.pickFonts(tokens.fontBody);
    const hfonts = docmodel.pickFonts(tokens.fontHeading);
    const mono = docmodel.pickFonts(tokens.fontMono);
    const accent = '#' + hex6(onPaper(tokens.accent), '2F5597');

    const files = [];
    const auto = []; // 自動スタイル（content.xml の office:automatic-styles）
    const autoKeys = new Map();
    /** 同じ内容の自動スタイルは使い回す */
    function autoStyle(family, props, parent) {
      const key = family + '|' + (parent || '') + '|' + props;
      if (autoKeys.has(key)) return autoKeys.get(key);
      const name = family[0].toUpperCase() + (autoKeys.size + 1);
      autoKeys.set(key, name);
      auto.push('<style:style style:name="' + name + '" style:family="' + family + '"' + (parent ? ' style:parent-style-name="' + parent + '"' : '') + '>' + props + '</style:style>');
      return name;
    }

    // ---- 画像 ----
    let imgN = 0;
    const imgCache = new Map();
    function picture(m) {
      if (imgCache.has(m.data)) return imgCache.get(m.data);
      const name = 'Pictures/image' + ++imgN + '.' + (O.EXT[m.mime] || 'png');
      files.push({ name, data: m.data, store: true, mime: m.mime });
      imgCache.set(m.data, name);
      return name;
    }
    let frameN = 0;
    function frame(m, w, h, alt) {
      const href = picture(m);
      return '<draw:frame draw:name="図' + ++frameN + '" text:anchor-type="as-char" svg:width="' + mm(w) + '" svg:height="' + mm(h) + '" draw:z-index="0">' +
        '<draw:image xlink:href="' + href + '" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' + (alt ? '<svg:desc>' + x(alt) + '</svg:desc>' : '') + '</draw:frame>';
    }

    // ---- 文字 ----
    function spanStyle(r, base) {
      const p = [];
      if (r.bold || (base && base.bold)) p.push('fo:font-weight="bold" style:font-weight-asian="bold"');
      if (r.italic) p.push('fo:font-style="italic" style:font-style-asian="italic"');
      if (r.strike) p.push('style:text-line-through-style="solid" style:text-line-through-type="single"');
      if (r.mark) p.push('fo:background-color="#fff2a8"');
      if (r.small) p.push('fo:font-size="9pt" style:font-size-asian="9pt"');
      if (r.code) p.push('style:font-name="' + x(mono.latin) + '" style:font-name-asian="' + x(mono.ja) + '" fo:background-color="#eef0f4"');
      if (base && base.color) p.push('fo:color="' + base.color + '"');
      else if (r.link) p.push('fo:color="' + accent + '" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
      return p.length ? autoStyle('text', '<style:text-properties ' + p.join(' ') + '/>') : null;
    }
    function runsXml(runs, base) {
      return (runs || []).map((r) => {
        if (r.br) return '<text:line-break/>';
        const s = spanStyle(r, base);
        let t = textNodes(r.text);
        if (s) t = '<text:span text:style-name="' + s + '">' + t + '</text:span>';
        if (r.link && /^(https?:|mailto:)/i.test(r.link)) t = '<text:a xlink:type="simple" xlink:href="' + x(r.link) + '">' + t + '</text:a>';
        return t;
      }).join('');
    }
    const p = (style, content) => '<text:p text:style-name="' + style + '">' + (content || '') + '</text:p>';
    const centered = () => autoStyle('paragraph', '<style:paragraph-properties fo:text-align="center" fo:margin-top="2mm" fo:margin-bottom="2mm"/>', 'Standard');

    // ---- リスト（平らにした段落から入れ子の text:list を組み立てる） ----
    function listXml(items, ctx) {
      let i = 0;
      function level(lv) {
        const style = items[i].list.ordered ? 'L_num' : 'L_bullet';
        let out = '<text:list text:style-name="' + style + '">';
        while (i < items.length && items[i].list.level >= lv) {
          if (items[i].list.level > lv) { out += '<text:list-item>' + level(lv + 1) + '</text:list-item>'; continue; }
          out += '<text:list-item>' + p('List_20_Paragraph', runsXml(items[i].runs, ctx.base));
          i++;
          // 同じ項目の続きの段落・より深い項目は、この項目の中に入れる
          while (i < items.length && (items[i].list.cont && items[i].list.level === lv)) out += p('List_20_Paragraph', runsXml(items[i++].runs, ctx.base));
          if (i < items.length && items[i].list.level > lv) out += level(lv + 1);
          out += '</text:list-item>';
        }
        return out + '</text:list>';
      }
      let out = '';
      while (i < items.length) out += level(Math.min(items[i].list.level, 0));
      return out;
    }

    // ---- ブロック ----
    function blocksXml(blocks, ctx) {
      ctx = ctx || { width: CONTENT_W };
      let out = '';
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type === 'para' && b.list) {
          const run = [];
          while (i < blocks.length && blocks[i].type === 'para' && blocks[i].list) run.push(blocks[i++]);
          i--;
          out += listXml(run, ctx);
          continue;
        }
        out += blockXml(b, ctx);
      }
      return out;
    }
    function imageXml(img, maxW) {
      const m = media.image(img.src);
      if (!m) return p('Caption', x('［画像: ' + (img.alt || img.src) + '］'));
      const s = fitImage(img, m, maxW, 200);
      return p(centered(), frame(m, s.w, s.h, img.alt)) + (img.title ? p('Caption', textNodes(img.title)) : '');
    }
    function blockXml(b, ctx) {
      switch (b.type) {
        case 'heading': {
          if (b.level === 1) return p('Title', runsXml(b.runs, ctx.base));
          const lvl = Math.min(3, b.level - 1);
          return '<text:h text:style-name="Heading_20_' + lvl + '" text:outline-level="' + lvl + '">' + runsXml(b.runs, ctx.base) + '</text:h>';
        }
        case 'para':
          if (b.meta) return p('Subtitle', runsXml(b.runs));
          if (b.quote) return p('Quotations', runsXml(b.runs, ctx.base));
          return p(ctx.base && ctx.base.color ? autoStyle('paragraph', '<style:text-properties fo:color="' + ctx.base.color + '"/>', 'Standard') : 'Standard', runsXml(b.runs, ctx.base));
        case 'code': return p('Code', textNodes(b.text));
        case 'mermaid': {
          const m = media.mermaid(b.code);
          if (!m) return p('Code', textNodes(b.code));
          const s = fitImage({}, m, ctx.width, 200);
          return p(centered(), frame(m, s.w, s.h, '図'));
        }
        case 'image': return imageXml(b, ctx.width);
        case 'images': {
          const n = b.items.length;
          const w = (ctx.width - (n - 1) * 4) / n;
          return p(centered(), b.items.map((img) => {
            const m = media.image(img.src);
            if (!m) return x('［画像］');
            const s = fitImage({}, m, w, 120);
            return frame(m, s.w, s.h, img.alt);
          }).join('<text:s text:c="2"/>'));
        }
        case 'table': return tableXml(b, ctx);
        case 'columns': return columnsXml(b, ctx);
        case 'note':
          return p('Note_20_Label', 'ノート') + b.blocks.map((nb) => (nb.type === 'para' ? p('Note', runsXml(nb.runs)) : blockXml(nb, ctx))).join('');
        case 'hr': return p('Horizontal_20_Line', '');
        default: return '';
      }
    }

    let tableN = 0;
    function tableXml(b, ctx) {
      const n = Math.max(1, ...b.rows.map((r) => r.length));
      const tname = 'Table' + ++tableN;
      const tstyle = autoStyle('table', '<style:table-properties style:width="' + mm(ctx.width) + '" table:align="margins" fo:margin-bottom="3mm"/>');
      const head = autoStyle('table-cell', '<style:table-cell-properties fo:padding="1.2mm" fo:border="0.5pt solid #c9ced8" fo:background-color="#eef1f6"/>');
      const cell = autoStyle('table-cell', '<style:table-cell-properties fo:padding="1.2mm" fo:border="0.5pt solid #c9ced8"/>');
      const aligned = (al) => (al ? autoStyle('paragraph', '<style:paragraph-properties fo:text-align="' + (al === 'right' ? 'end' : al) + '"/>', 'Table_20_Contents') : 'Table_20_Contents');
      const rows = b.rows.map((row, ri) => '<table:table-row>' + Array.from({ length: n }, (_, ci) =>
        '<table:table-cell table:style-name="' + (ri === 0 ? head : cell) + '" office:value-type="string">' + p(aligned(b.aligns[ci]), runsXml(row[ci] || [], ri === 0 ? { bold: true } : null)) + '</table:table-cell>').join('') + '</table:table-row>');
      return '<table:table table:name="' + tname + '" table:style-name="' + tstyle + '"><table:table-column table:number-columns-repeated="' + n + '"/>' +
        '<table:table-header-rows>' + rows[0] + '</table:table-header-rows>' + rows.slice(1).join('') + '</table:table>';
    }

    function columnsXml(b, ctx) {
      const n = b.cols.length;
      const gap = 4;
      const w = (ctx.width - gap * (n - 1)) / n;
      const tname = 'Table' + ++tableN;
      const tstyle = autoStyle('table', '<style:table-properties style:width="' + mm(ctx.width) + '" table:align="margins" fo:margin-bottom="3mm"/>');
      const colStyle = autoStyle('table-column', '<style:table-column-properties style:column-width="' + mm(w) + '"/>');
      const gapStyle = autoStyle('table-column', '<style:table-column-properties style:column-width="' + mm(gap) + '"/>');
      let cols = '';
      let cells = '';
      b.cols.forEach((col, i) => {
        const color = b.colors[i] || tokens.accent;
        let props = 'fo:padding="3mm"';
        let base = null;
        if (b.style === 'outline') props += ' fo:border="1.2pt solid ' + color + '" fo:background-color="' + mix(color, '#ffffff', 0.08) + '"';
        else if (b.style === 'fill') { props += ' fo:border="none" fo:background-color="' + color + '"'; base = { color: textOn(color) }; }
        else if (b.style === 'card') props += ' fo:border-top="2.5pt solid ' + color + '" fo:border-left="0.5pt solid #d5d9e2" fo:border-right="0.5pt solid #d5d9e2" fo:border-bottom="0.5pt solid #d5d9e2" fo:background-color="#f7f8fb"';
        else props += ' fo:border="none"';
        const cs = autoStyle('table-cell', '<style:table-cell-properties ' + props + '/>');
        cols += '<table:table-column table:style-name="' + colStyle + '"/>' + (i < n - 1 ? '<table:table-column table:style-name="' + gapStyle + '"/>' : '');
        cells += '<table:table-cell table:style-name="' + cs + '" office:value-type="string">' + (blocksXml(col, { width: w - 6, base }) || p('Standard', '')) + '</table:table-cell>';
        if (i < n - 1) cells += '<table:table-cell office:value-type="string">' + p('Standard', '') + '</table:table-cell>';
      });
      return '<table:table table:name="' + tname + '" table:style-name="' + tstyle + '">' + cols + '<table:table-row>' + cells + '</table:table-row></table:table>';
    }

    const body = blocksXml(doc.blocks);

    // ---- 名前付きスタイル（styles.xml） ----
    const font = (f) => 'style:font-name="' + x(f.latin) + '" style:font-name-asian="' + x(f.ja) + '"';
    const fontDecls = '<office:font-face-decls>' + Array.from(new Set([fonts.latin, fonts.ja, hfonts.latin, hfonts.ja, mono.latin, mono.ja]))
      .map((f) => '<style:font-face style:name="' + x(f) + '" svg:font-family="' + x("'" + f + "'") + '"/>').join('') + '</office:font-face-decls>';
    const ps = (name, display, parent, para, txt, extra) => '<style:style style:name="' + name + '" style:display-name="' + display + '" style:family="paragraph"' +
      (parent ? ' style:parent-style-name="' + parent + '"' : '') + (extra || '') + '>' +
      (para ? '<style:paragraph-properties ' + para + '/>' : '') + (txt ? '<style:text-properties ' + txt + '/>' : '') + '</style:style>';
    const size = (pt) => 'fo:font-size="' + pt + 'pt" style:font-size-asian="' + pt + 'pt"';
    const bold = 'fo:font-weight="bold" style:font-weight-asian="bold"';
    const listLevel = (i, ordered) => ordered
      ? '<text:list-level-style-number text:level="' + i + '" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-5mm" fo:margin-left="' + (7 * i) + 'mm"/></style:list-level-properties></text:list-level-style-number>'
      : '<text:list-level-style-bullet text:level="' + i + '" text:bullet-char="' + ['●', '○', '■'][(i - 1) % 3] + '"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-5mm" fo:margin-left="' + (7 * i) + 'mm"/></style:list-level-properties><style:text-properties fo:color="' + accent + '" fo:font-size="70%"/></text:list-level-style-bullet>';
    const stylesXml = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ' + NS + '>' + fontDecls +
      '<office:styles>' +
      '<style:default-style style:family="paragraph"><style:paragraph-properties fo:line-height="150%"/><style:text-properties ' + font(fonts) + ' ' + size(10.5) + ' fo:language="ja" fo:country="JP" style:language-asian="ja" style:country-asian="JP" fo:color="#22252c"/></style:default-style>' +
      ps('Standard', 'Standard', null, 'fo:margin-top="0mm" fo:margin-bottom="2.4mm"', '', ' style:class="text"') +
      ps('Title', 'Title', 'Standard', 'fo:margin-top="4mm" fo:margin-bottom="2mm" fo:keep-with-next="always"', font(hfonts) + ' ' + size(26) + ' ' + bold + ' fo:color="#15171c"') +
      ps('Subtitle', 'Subtitle', 'Standard', 'fo:margin-bottom="6mm"', size(10) + ' fo:color="#6b7280"') +
      ps('Heading', 'Heading', 'Standard', 'fo:keep-with-next="always"', font(hfonts) + ' ' + bold) +
      ps('Heading_20_1', 'Heading 1', 'Heading', 'fo:margin-top="7mm" fo:margin-bottom="2.6mm" fo:border-bottom="1pt solid ' + accent + '" fo:padding-bottom="1mm"', size(17) + ' fo:color="#15171c"', ' style:default-outline-level="1"') +
      ps('Heading_20_2', 'Heading 2', 'Heading', 'fo:margin-top="5mm" fo:margin-bottom="1.6mm"', size(13) + ' fo:color="' + accent + '"', ' style:default-outline-level="2"') +
      ps('Heading_20_3', 'Heading 3', 'Heading', 'fo:margin-top="3.5mm" fo:margin-bottom="1.2mm"', size(11) + ' fo:color="#374151"', ' style:default-outline-level="3"') +
      ps('List_20_Paragraph', 'List Paragraph', 'Standard', 'fo:margin-bottom="1mm"', '') +
      ps('Quotations', 'Quotations', 'Standard', 'fo:margin-left="5mm" fo:padding-left="3mm" fo:border-left="2pt solid ' + accent + '"', 'fo:color="#4b5563"') +
      ps('Code', 'Code', 'Standard', 'fo:background-color="#f3f4f7" fo:padding="2mm" fo:line-height="130%" fo:margin-bottom="3mm"', font(mono) + ' ' + size(9)) +
      ps('Caption', 'Caption', 'Standard', 'fo:text-align="center"', size(9) + ' fo:color="#6b7280"') +
      ps('Table_20_Contents', 'Table Contents', 'Standard', 'fo:margin-bottom="0mm"', '') +
      ps('Note_20_Label', 'Note Label', 'Standard', 'fo:background-color="#fff8e1" fo:padding="1mm" fo:margin-bottom="0mm" fo:keep-with-next="always"', size(8.5) + ' ' + bold + ' fo:color="#9a6b00"') +
      ps('Note', 'Note', 'Standard', 'fo:background-color="#fff8e1" fo:padding="1mm" fo:margin-bottom="0.6mm"', size(9.5) + ' fo:color="#5b4a1a"') +
      ps('Horizontal_20_Line', 'Horizontal Line', 'Standard', 'fo:border-bottom="0.75pt solid #d0d4dc" fo:padding="0mm" fo:margin-bottom="4mm"', size(4)) +
      '<text:list-style style:name="L_bullet">' + Array.from({ length: 9 }, (_, i) => listLevel(i + 1, false)).join('') + '</text:list-style>' +
      '<text:list-style style:name="L_num">' + Array.from({ length: 9 }, (_, i) => listLevel(i + 1, true)).join('') + '</text:list-style>' +
      '</office:styles>' +
      '<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="' + PAGE.w + 'mm" fo:page-height="' + PAGE.h + 'mm" style:print-orientation="portrait" fo:margin-top="' + PAGE.margin + 'mm" fo:margin-bottom="' + PAGE.margin + 'mm" fo:margin-left="' + PAGE.margin + 'mm" fo:margin-right="' + PAGE.margin + 'mm"/></style:page-layout></office:automatic-styles>' +
      '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>';

    const contentXml = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ' + NS + '>' + fontDecls +
      '<office:automatic-styles>' + auto.join('') + '</office:automatic-styles><office:body><office:text>' + body + '</office:text></office:body></office:document-content>';
    const metaXml = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ' + NS + '><office:meta><meta:generator>Kamishibai</meta:generator>' +
      '<dc:title>' + x(opts.title || '') + '</dc:title>' + (opts.author ? '<meta:initial-creator>' + x(opts.author) + '</meta:initial-creator>' : '') + '</office:meta></office:document-meta>';
    const MIME = 'application/vnd.oasis.opendocument.text';
    const manifest = '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
      '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="' + MIME + '"/>' +
      ['content.xml', 'styles.xml', 'meta.xml'].map((f) => '<manifest:file-entry manifest:full-path="' + f + '" manifest:media-type="text/xml"/>').join('') +
      files.map((f) => '<manifest:file-entry manifest:full-path="' + f.name + '" manifest:media-type="' + f.mime + '"/>').join('') +
      '</manifest:manifest>';

    return [
      { name: 'mimetype', data: MIME, store: true }, // ODF の決まり: 先頭・無圧縮
      { name: 'META-INF/manifest.xml', data: manifest },
      { name: 'content.xml', data: contentXml },
      { name: 'styles.xml', data: stylesXml },
      { name: 'meta.xml', data: metaXml },
    ].concat(files.map((f) => ({ name: f.name, data: f.data, store: true })));
  }

  return { buildOdt };
});
