/*
 * pdf.js — HTML ファイルを PDF にする（コマンドライン・ブラウザ版用）。
 *
 * 追加の依存を持たないために、PC に入っている Chrome / Edge / Chromium をヘッドレスで起動して「印刷 → PDF」させる。
 * ページの大きさや分割は、各 HTML の @media print と @page が決めている（スライド: 1 枚 1 ページ / 資料: A4 縦）。
 * デスクトップアプリ（Tauri）は、WebView2 の印刷機能で PDF を作る（src-tauri/src/pdf.rs）。
 *
 * ブラウザが見つからない環境では、HTML を開いて Ctrl+P →「PDF に保存」でも同じ結果になる。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { findBrowser } = require('./browser');
const { removeFile, removeDir } = require('./fsutil');

function fail(message, status) {
  const e = new Error(message);
  e.status = status || 500;
  e.expose = true;
  return e;
}

/** HTML ファイルを PDF にする */
async function printToPdf(htmlFile, pdfFile) {
  const browser = findBrowser();
  if (!browser) {
    throw fail(
      'PDF 出力に使える Chrome / Edge が見つかりませんでした。書き出した HTML を開いて Ctrl+P →「PDF に保存」でも同じ PDF を作れます。' +
        '（ブラウザの場所は環境変数 KAMISHIBAI_BROWSER で指定できます）',
      501
    );
  }
  fs.mkdirSync(path.dirname(pdfFile), { recursive: true });
  removeFile(pdfFile);
  // 起動中のブラウザと衝突しないよう、使い捨てのプロファイルで動かす
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kamishibai-pdf-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--user-data-dir=' + profile,
    '--no-pdf-header-footer',
    '--virtual-time-budget=20000', // mermaid の描画などページ内の非同期処理が終わるのを待つ
    '--print-to-pdf=' + pdfFile,
    pathToFileURL(htmlFile).href,
  ];
  try {
    await new Promise((resolve, reject) => {
      execFile(browser, args, { timeout: 120000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    if (!fs.existsSync(pdfFile)) throw fail('PDF の生成に失敗しました: ' + e.message);
  } finally {
    removeDir(profile); // 消しきれなくても害はない
  }
  if (!fs.existsSync(pdfFile)) throw fail('PDF の生成に失敗しました（ブラウザがファイルを出力しませんでした）');
}

module.exports = { printToPdf, findBrowser };
