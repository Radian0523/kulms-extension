// KULMS Content Script
// このファイルがLMSページ上で実行されます

console.log("[KULMS Extension] loaded on:", window.location.href);

// === 設定読み込み ===

window.__kulmsSettingsReady = new Promise(function (resolve) {
  var DEFAULTS = {
    textbooks: true, tabColoring: true,
    treeView: false, courseNameCleanup: false, pinSort: false,
    courseRowClick: false, toolVisibility: false, sidebarResize: false,
    notificationBadge: false, sidebarStyle: false, memos: false,
    panelPush: false, previewMode: false,
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
  chrome.storage.local.get("kulms-settings", function (result) {
    var saved = result["kulms-settings"] || {};
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
  if (!lang || lang === "auto") {
    __kulmsOverrideMessages = null;
    return Promise.resolve();
  }
  var url = chrome.runtime.getURL("_locales/" + lang + "/messages.json");
  return fetch(url).then(function (res) { return res.json(); })
    .then(function (data) { __kulmsOverrideMessages = data; })
    .catch(function (e) { console.warn("[KULMS] loadOverrideMessages failed:", e); __kulmsOverrideMessages = null; });
}
