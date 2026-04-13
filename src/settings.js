// KULMS Content Script
// このファイルがLMSページ上で実行されます

console.log("[KULMS Extension] loaded on:", window.location.href);

// === 設定読み込み ===

window.__kulmsDefaults = {
  textbooks: true, tabColoring: true, tabColorStyle: "bold",
  folderExpand: false, autoExpandAll: false, hideResourceColumns: false, courseNameCleanup: false, pinSort: false,
  courseRowClick: false, toolVisibility: false, sidebarResize: false,
  notificationBadge: false, sidebarStyle: false, memos: true,
  panelPush: false, previewMode: false, autoComplete: true, currentPeriodHighlight: false,
  topFavbar: false,
  topFavbarSize: "medium",
  fetchInterval: 120,
  dangerHours: 24,
  warningDays: 5,
  successDays: 14,
  colorDanger: "#e85555",
  colorWarning: "#d7aa57",
  colorSuccess: "#62b665",
  colorOther: "#777777",
  language: "auto"
};

window.__kulmsSettingsReady = new Promise(function (resolve) {
  var DEFAULTS = window.__kulmsDefaults;
  chrome.storage.local.get("kulms-settings", function (result) {
    var saved = result["kulms-settings"] || {};
    // treeView → folderExpand + autoExpandAll 移行
    if ("treeView" in saved && !("folderExpand" in saved)) {
      saved.folderExpand = saved.treeView;
      saved.autoExpandAll = saved.treeView;
      delete saved.treeView;
      chrome.storage.local.set({ "kulms-settings": saved });
    }
    window.__kulmsSettings = Object.assign({}, DEFAULTS, saved);
    loadOverrideMessages(window.__kulmsSettings.language).then(function () {
      resolve(window.__kulmsSettings);
    });
  });
});

// === i18n ヘルパー ===
var __kulmsOverrideMessages = null;

function t(key, substitutions) {
  // 言語上書きが有効な場合、ローカル辞書から取得
  if (__kulmsOverrideMessages && __kulmsOverrideMessages[key]) {
    var entry = __kulmsOverrideMessages[key];
    var msg = entry.message;
    if (substitutions && entry.placeholders) {
      var subs = Array.isArray(substitutions) ? substitutions : [substitutions];
      Object.keys(entry.placeholders).forEach(function (name) {
        var idx = parseInt(entry.placeholders[name].content.replace(/\$/g, "")) - 1;
        if (idx >= 0 && idx < subs.length) {
          msg = msg.replace(new RegExp("\\$" + name.toUpperCase() + "\\$", "g"), subs[idx]);
        }
      });
    }
    return msg;
  }
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function loadOverrideMessages(lang) {
  // Safari's chrome.i18n.getMessage has placeholder substitution bugs,
  // so always load messages.json and use manual substitution in t().
  var resolvedLang = lang;
  if (!resolvedLang || resolvedLang === "auto") {
    var uiLang = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || navigator.language || "en";
    resolvedLang = uiLang.toLowerCase().indexOf("ja") === 0 ? "ja" : "en";
  }
  var url = chrome.runtime.getURL("_locales/" + resolvedLang + "/messages.json");
  return fetch(url).then(function (res) { return res.json(); })
    .then(function (data) { __kulmsOverrideMessages = data; })
    .catch(function (e) { console.warn("[KULMS] loadOverrideMessages failed:", e); __kulmsOverrideMessages = null; });
}
