/*
 * fsutil.js — ファイル削除の安全版。
 *
 * 【重要】fs.rmSync / fs.rm は使わないこと。
 * Node.js 24（Windows）では、日本語などを含むパスに fs.rmSync を使うと、例外ではなく
 * プロセスごと異常終了する（終了コード 0xC0000409）不具合を確認した。デッキ名やユーザー名に
 * 日本語が入るのはよくあることなので、昔からある unlinkSync / rmdirSync だけで消す。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** ファイルを消す（無ければ何もしない） */
function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/** フォルダを中身ごと消す（無ければ何もしない）。消せないものがあっても例外にしない */
function removeDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory() && !entry.isSymbolicLink()) removeDir(p);
      else fs.unlinkSync(p);
    } catch (e) { /* 使用中などで消せなければ残す */ }
  }
  try { fs.rmdirSync(dir); } catch (e) { /* 同上 */ }
}

module.exports = { removeFile, removeDir };
