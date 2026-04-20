// === サイドバーリサイズ ===

(function () {
  "use strict";

  if (window !== window.top) return;

  window.__kulmsSettingsReady.then(function (s) {
    if (s.sidebarResize === false) return;

    var STORAGE_KEY = "kulms-sidebar-width";
    var RESET_KEY = "kulms-sidebar-v3";
    var MIN_WIDTH = 120;
    var MAX_WIDTH = 500;

    // 壊れた保存値をリセット
    if (!localStorage.getItem(RESET_KEY)) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(RESET_KEY, "1");
    }

    var sidebar = document.querySelector("#portal-nav-sidebar");
    if (!sidebar) return;

    var gridParent = sidebar.closest(".portal-container") || sidebar.parentElement;
    if (!gridParent) return;
    var parentDisplay = getComputedStyle(gridParent).display;
    if (parentDisplay !== "grid" && parentDisplay !== "inline-grid") return;

    var baseCols = getComputedStyle(gridParent).gridTemplateColumns;

    var styleEl = document.createElement("style");
    styleEl.id = "kulms-sidebar-resize";
    document.head.appendChild(styleEl);

    function applySidebarWidth(w) {
      var parts = baseCols.split(/\s+/);
      var newCols = w + "px 1fr";
      if (parts.length > 2) {
        newCols += " " + parts.slice(2).join(" ");
      }
      styleEl.textContent =
        ".portal-container { grid-template-columns: " + newCols + " !important; }\n" +
        "#portal-nav-sidebar { width: 100% !important; max-width: none !important; position: relative !important; }\n" +
        "#portal-nav-sidebar .site-link-block { width: auto !important; flex: 1 !important; min-width: 0 !important; }\n" +
        "#portal-nav-sidebar .sidebar-site-title { width: auto !important; }\n";
    }

    var handle = document.createElement("div");
    handle.className = "kulms-sidebar-handle";
    sidebar.appendChild(handle);

    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      var w = parseInt(saved, 10);
      if (w >= MIN_WIDTH && w <= MAX_WIDTH) applySidebarWidth(w);
    }

    var dragging = false;

    handle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      dragging = true;
      document.body.classList.add("kulms-sidebar-resizing");
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var rect = sidebar.getBoundingClientRect();
      var newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX - rect.left));
      applySidebarWidth(newWidth);
    });

    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("kulms-sidebar-resizing");
      var cols = getComputedStyle(gridParent).gridTemplateColumns;
      var firstCol = parseInt(cols.split(/\s+/)[0], 10);
      if (firstCol >= MIN_WIDTH && firstCol <= MAX_WIDTH) {
        localStorage.setItem(STORAGE_KEY, firstCol);
      }
    });
  });
})();
