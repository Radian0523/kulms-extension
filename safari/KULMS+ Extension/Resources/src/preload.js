// === 読み込み中のちらつき防止 ===
// document_start で実行。拡張機能による書き換えが終わるまでページを隠し、
// 書き換え前の UI が一瞬見えてからカクッと切り替わるのを防ぐ。
// 各スクリプトは __kulmsHold() で保留を登録し、返された関数で解除する。
// すべて解除されたら表示する (保険として一定時間で必ず表示)。

(function () {
  "use strict";

  if (window.location.pathname.indexOf("/portal") !== 0) return;

  var root = document.documentElement;
  var MAX_HIDE_MS = 800;
  var pending = 0;
  var revealed = false;

  root.classList.add("kulms-preload");

  // 科目名の整理が有効なら、整理前の名前 ([2026前期…]) が見えないよう
  // course-name.js が確認するまで科目リンクを隠す (前回読み込み時の設定を使う)
  if (window === window.top) {
    var flags = null;
    try { flags = JSON.parse(localStorage.getItem("kulms-preload-flags")); } catch (e) { /* 無視 */ }
    if (flags && flags.courseNameCleanup) {
      root.classList.add("kulms-hide-raw-course-names");
      // course-name.js が動かなかった場合の保険
      setTimeout(function () {
        root.classList.remove("kulms-hide-raw-course-names");
      }, 3000);
    }
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    // 書き換え結果がレイアウトに反映されてから表示する
    requestAnimationFrame(function () {
      root.classList.remove("kulms-preload");
    });
  }

  window.__kulmsHold = function () {
    if (revealed) return function () {};
    pending++;
    var released = false;
    return function () {
      if (released) return;
      released = true;
      pending--;
      if (pending === 0) reveal();
    };
  };

  setTimeout(reveal, MAX_HIDE_MS);
})();
