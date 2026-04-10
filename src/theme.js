// === テーマ切り替え機能 ===

(function () {
  "use strict";

  const THEMES = [
    { id: "default", labelKey: "themeDefault", color: "#ffffff" },
    { id: "dark", labelKey: "themeDark", color: "#1a1a2e" },
    { id: "sepia", labelKey: "themeSepia", color: "#f4ecd8" },
    { id: "blue", labelKey: "themeBlue", color: "#e8eef7" },
  ];

  const STORAGE_KEY = "kulms-theme";

  // テーマを適用
  function applyTheme(themeId) {
    if (themeId === "default") {
      document.body.removeAttribute("data-kulms-theme");
    } else {
      document.body.setAttribute("data-kulms-theme", themeId);
    }
    updateActiveState(themeId);
  }

  // 保存されたテーマを読み込んで適用
  function loadSavedTheme() {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const saved = result[STORAGE_KEY] || "default";
      applyTheme(saved);
    });
  }

  // テーマを保存
  function saveTheme(themeId) {
    chrome.storage.local.set({ [STORAGE_KEY]: themeId });
  }

  function getCurrentTheme() {
    return document.body.getAttribute("data-kulms-theme") || "default";
  }

  // 他のIIFEから使えるAPI
  window.__kulmsThemeAPI = {
    themes: THEMES,
    apply: applyTheme,
    save: saveTheme,
    getCurrent: getCurrentTheme,
  };

  // 初期化: テーマだけ適用（UIは課題パネル内に統合）
  function init() {
    if (window !== window.top) return;
    loadSavedTheme();
  }

  window.__kulmsSettingsReady.then(function () {
    init();
  });
})();
