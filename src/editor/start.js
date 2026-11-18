/*
 * start.js — エディタの起動。index.html のインラインスクリプトをやめて、このファイルに置いた
 * （CSP で「インラインのスクリプトは動かさない」ようにしているため。原稿に仕込まれたスクリプトを動かさないための設定）。
 */
(function () {
  'use strict';
  window.KSE.start().catch(function (e) {
    console.error(e);
    window.KSE.toast('起動に失敗しました: ' + e.message, true);
  });
  // mermaid は大きいので、あとから読み込む。読み込めたら図を描き直す
  var s = document.createElement('script');
  s.src = '/vendor/mermaid.min.js';
  s.async = true;
  s.onload = function () { window.dispatchEvent(new Event('ks-mermaid-ready')); };
  document.body.appendChild(s);
})();
