/*
 * pathx.js — ファイルパスの小道具（Node の path の代わり）。Windows（C:\…・\\server\…）と macOS / Linux（/…）の両方を扱う。
 * バックエンド（backend.js）が、Node でも Tauri（WebView の中）でも同じように動くように使う。
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.KS = root.KS || {}).pathx = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const isWin = (p) => /^[a-zA-Z]:([\\/]|$)/.test(p) || /^\\\\/.test(p);
  const sepOf = (p) => (isWin(p) || (p.indexOf('\\') >= 0 && p.indexOf('/') < 0) ? '\\' : '/');

  /** 先頭の「C:\」「\\server\share\」「/」と、残りの部分に分ける */
  function splitRoot(p) {
    let m = /^([a-zA-Z]:)[\\/]?/.exec(p);
    if (m) return { root: m[1] + '\\', rest: p.slice(m[0].length) };
    m = /^(\\\\[^\\/]+[\\/][^\\/]+)[\\/]?/.exec(p);
    if (m) return { root: m[1].replace(/\//g, '\\') + '\\', rest: p.slice(m[0].length) };
    if (p[0] === '/' || p[0] === '\\') return { root: p[0] === '/' ? '/' : '\\', rest: p.slice(1) };
    return { root: '', rest: p };
  }

  /** 「.」「..」・重複した区切りを整理する */
  function normalize(p) {
    p = String(p || '');
    const sep = sepOf(p);
    const { root, rest } = splitRoot(p);
    const out = [];
    for (const part of rest.split(/[\\/]+/)) {
      if (!part || part === '.') continue;
      if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!root) out.push('..'); continue; }
      out.push(part);
    }
    return (root || '') + out.join(sep) || (root ? root : '.');
  }

  const isAbsolute = (p) => !!splitRoot(String(p || '')).root;

  function join() {
    const parts = Array.from(arguments).filter((s) => s != null && s !== '');
    if (!parts.length) return '.';
    const sep = sepOf(parts[0]);
    return normalize(parts.join(sep));
  }

  /** 後ろの絶対パスが勝つ（path.resolve と同じ。基準が無ければ base を使う） */
  function resolve(base) {
    let p = '';
    for (let i = arguments.length - 1; i >= 0; i--) {
      const s = String(arguments[i] == null ? '' : arguments[i]);
      if (!s) continue;
      p = p ? s + sepOf(s) + p : s;
      if (isAbsolute(s)) break;
    }
    return normalize(p);
  }

  function dirname(p) {
    p = normalize(p);
    const { root, rest } = splitRoot(p);
    const i = Math.max(rest.lastIndexOf('/'), rest.lastIndexOf('\\'));
    if (i < 0) return root || '.';
    return root + rest.slice(0, i);
  }
  function basename(p, ext) {
    const s = String(p || '').replace(/[\\/]+$/, '');
    let b = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
    if (ext && b.toLowerCase().endsWith(ext.toLowerCase()) && b !== ext) b = b.slice(0, -ext.length);
    return b;
  }
  function extname(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i) : '';
  }

  const key = (p, win) => (win ? normalize(p).toLowerCase().replace(/\//g, '\\') : normalize(p));
  /** from から to への相対パス（区切りは「/」） */
  function relative(from, to) {
    const win = isWin(from) || isWin(to);
    const a = key(from, win).split(/[\\/]+/).filter(Boolean);
    const b = key(to, win).split(/[\\/]+/).filter(Boolean);
    const orig = normalize(to).split(/[\\/]+/).filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i === 0 && (a.length || b.length) && (a[0] !== b[0])) {
      if (isAbsolute(from) && isAbsolute(to)) return null; // 別のドライブ
    }
    return Array(a.length - i).fill('..').concat(orig.slice(i)).join('/');
  }

  /** base の中にある path なら絶対パス、外に出るなら null */
  function inside(base, rel) {
    const full = resolve(base, rel);
    const r = relative(base, full);
    if (r == null || r === '..' || r.startsWith('../') || isAbsolute(r)) return null;
    return full;
  }

  const same = (a, b) => key(a, isWin(a) || isWin(b)) === key(b, isWin(a) || isWin(b));

  return { normalize, isAbsolute, join, resolve, dirname, basename, extname, relative, inside, same, sepOf };
});
