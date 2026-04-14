// KULMS Content Script
// このファイルがLMSページ上で実行されます

console.log("[KULMS Extension] loaded on:", window.location.href);

// === コンテキスト無効化対策 ===

window.__kulmsAlive = function () {
  try { return !!chrome.runtime.id; } catch (e) { return false; }
};

window.__kulmsShowReloadBanner = function () {
  if (window.__kulmsReloadBannerShown) return;
  if (window.__kulmsAlive()) return;
  window.__kulmsReloadBannerShown = true;
  var banner = document.createElement("div");
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a73e8;color:#fff;font-size:14px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  var msg = document.createElement("span");
  msg.textContent = "KULMS+ \u304C\u66F4\u65B0\u3055\u308C\u307E\u3057\u305F\u3002\u30DA\u30FC\u30B8\u3092\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
  var btns = document.createElement("span");
  btns.style.cssText = "display:flex;gap:8px;align-items:center;flex-shrink:0";
  var reloadBtn = document.createElement("button");
  reloadBtn.textContent = "\u518D\u8AAD\u307F\u8FBC\u307F";
  reloadBtn.style.cssText = "background:#fff;color:#1a73e8;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold";
  reloadBtn.addEventListener("click", function () { location.reload(); });
  var closeBtn = document.createElement("button");
  closeBtn.textContent = "\u00D7";
  closeBtn.style.cssText = "background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 4px;line-height:1";
  closeBtn.addEventListener("click", function () { banner.remove(); });
  btns.appendChild(reloadBtn);
  btns.appendChild(closeBtn);
  banner.appendChild(msg);
  banner.appendChild(btns);
  document.body.appendChild(banner);
};

window.__kulmsSafeStorage = {
  get: function (keys, callback) {
    if (!window.__kulmsAlive()) {
      window.__kulmsShowReloadBanner();
      if (callback) callback({});
      return;
    }
    chrome.storage.local.get(keys, callback);
  },
  set: function (items) {
    if (!window.__kulmsAlive()) {
      window.__kulmsShowReloadBanner();
      return;
    }
    chrome.storage.local.set(items);
  }
};

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
  window.__kulmsSafeStorage.get("kulms-settings", function (result) {
    var saved = result["kulms-settings"] || {};
    // treeView → folderExpand + autoExpandAll 移行
    if ("treeView" in saved && !("folderExpand" in saved)) {
      saved.folderExpand = saved.treeView;
      saved.autoExpandAll = saved.treeView;
      delete saved.treeView;
      window.__kulmsSafeStorage.set({ "kulms-settings": saved });
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
