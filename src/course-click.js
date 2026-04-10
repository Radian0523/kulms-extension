// === サイドバー: コース行クリックで展開/折りたたみ ===

(function () {
  "use strict";

  if (window !== window.top) return;

  window.__kulmsSettingsReady.then(function (s) {
    if (s.courseRowClick === false) return;

    var sidebar = document.querySelector("#portal-nav-sidebar");
    if (!sidebar) return;

    sidebar.addEventListener("click", function (e) {
      var head = e.target.closest(".site-list-item-head");
      if (!head) return;

      // ボタン（chevron・ピン留め）はそのまま通す
      if (e.target.closest("button")) return;

      e.preventDefault();
      e.stopPropagation();

      // chevron ボタンをクリック
      var chevron = head.querySelector(".site-link-block > button");
      if (chevron) chevron.click();
    });
  });
})();
