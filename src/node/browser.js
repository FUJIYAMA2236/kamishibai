/*
 * browser.js — PC に入っている Chrome / Edge / Chromium を探して使う。
 *
 *   findBrowser()      実行ファイルのパス（見つからなければ null）。CLI での PDF 出力に使う
 *   openDefault(url)   OS の既定のブラウザで開く
 *   reveal(file)       エクスプローラー / Finder でファイルの場所を開く
 *
 * 使うブラウザは環境変数 KAMISHIBAI_BROWSER で明示できる。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean);
    const apps = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    return apps.flatMap((app) => roots.map((r) => path.join(r, app)));
  }
  if (process.platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser'].flatMap((app) => [
      `/Applications/${app}.app/Contents/MacOS/${app}`,
      path.join(os.homedir(), `Applications/${app}.app/Contents/MacOS/${app}`),
    ]);
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
  const found = [];
  for (const name of names) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p) found.push(p);
    } catch (e) { /* 見つからない */ }
  }
  return found;
}

function findBrowser() {
  const explicit = process.env.KAMISHIBAI_BROWSER;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  return candidates().find((p) => fs.existsSync(p)) || null;
}

function run(cmd, args) {
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch (e) { /* 開けなくても致命的ではない */ }
}

function openDefault(url) {
  if (process.platform === 'win32') run('cmd', ['/c', 'start', '', url]);
  else run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

/** ファイルの場所をファイルマネージャーで開く（Windows / macOS ではそのファイルを選択した状態で） */
function reveal(file) {
  if (process.platform === 'win32') run('explorer.exe', ['/select,', file]);
  else if (process.platform === 'darwin') run('open', ['-R', file]);
  else run('xdg-open', [path.dirname(file)]);
}

module.exports = { findBrowser, openDefault, reveal };
