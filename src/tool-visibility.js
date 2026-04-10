// === サイドバー: ツール表示管理 ===

(function () {
  "use strict";

  if (window !== window.top) return;

  var STORAGE_KEY = "kulms-tool-config";
  var DEFAULT_VISIBLE = ["概要", "授業資料（リソース）", "課題"];

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function saveConfig(config) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function getSiteId(courseLi) {
    return (courseLi.id || "").replace(/^site-list-(?:pinned-)?item-/, "");
  }

  function getToolName(navItem) {
    var span = navItem.querySelector("span");
    return span ? span.textContent.trim() : "";
  }

  function isToolVisible(siteId, toolName) {
    var config = getConfig();
    if (config[siteId] && config[siteId].hasOwnProperty(toolName)) {
      return config[siteId][toolName];
    }
    return DEFAULT_VISIBLE.indexOf(toolName) !== -1;
  }

  function setToolVisibility(siteId, toolName, visible) {
    var config = getConfig();
    if (!config[siteId]) config[siteId] = {};
    var isDefault = (DEFAULT_VISIBLE.indexOf(toolName) !== -1) === visible;
    if (isDefault) {
      delete config[siteId][toolName];
      if (Object.keys(config[siteId]).length === 0) delete config[siteId];
    } else {
      config[siteId][toolName] = visible;
    }
    saveConfig(config);
  }

  function reprocessCourse(courseLi) {
    var toolList = courseLi.querySelector(".site-page-list");
    if (!toolList) return;
    // クリーンアップ
    toolList.querySelectorAll(".kulms-other-toggle").forEach(function (el) { el.remove(); });
    toolList.querySelectorAll(".kulms-tool-toggle").forEach(function (el) { el.remove(); });
    Array.from(toolList.querySelectorAll(":scope > .nav-item")).forEach(function (li) {
      li.style.display = "";
      li.classList.remove("kulms-hidden-tool");
    });
    processCourse(courseLi);
  }

  function processCourse(courseLi) {
    var siteId = getSiteId(courseLi);
    if (!siteId) return;

    var toolList = courseLi.querySelector(".site-page-list");
    if (!toolList) return;

    // 処理済みチェック
    if (toolList.querySelector(".kulms-other-toggle")) return;

    var allTools = Array.from(toolList.querySelectorAll(":scope > .nav-item"));
    if (allTools.length === 0) return;

    var visible = [];
    var hidden = [];

    allTools.forEach(function (tool) {
      var name = getToolName(tool);
      if (!name) { visible.push(tool); return; }

      if (isToolVisible(siteId, name)) {
        visible.push(tool);
      } else {
        hidden.push(tool);
      }

      // 切り替えボタンを追加
      if (tool.querySelector(".kulms-tool-toggle")) return;
      var btn = document.createElement("button");
      btn.className = "kulms-tool-toggle";
      btn.type = "button";
      var vis = isToolVisible(siteId, name);
      btn.textContent = vis ? "−" : "+";
      btn.title = vis ? t("toolMoveToOther") : t("toolMoveToMain");
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        setToolVisibility(siteId, name, !isToolVisible(siteId, name));
        reprocessCourse(courseLi);
      });
      var linkEl = tool.querySelector("a");
      if (linkEl) linkEl.appendChild(btn);
    });

    // DOM並び替え: 表示ツール → その他 → 非表示ツール
    visible.forEach(function (li) { toolList.appendChild(li); });

    if (hidden.length > 0) {
      var toggleLi = document.createElement("li");
      toggleLi.className = "kulms-other-toggle nav-item";
      var toggleA = document.createElement("a");
      toggleA.className = "btn kulms-other-btn";
      toggleA.innerHTML = '<div class="d-flex align-items-center">' +
        '<span class="kulms-other-label">' + t("toolOtherCollapsed") + '</span></div>';
      toggleLi.appendChild(toggleA);
      toolList.appendChild(toggleLi);

      hidden.forEach(function (li) {
        li.classList.add("kulms-hidden-tool");
        toolList.appendChild(li);
      });

      toggleLi.addEventListener("click", function (e) {
        e.preventDefault();
        var label = toggleLi.querySelector(".kulms-other-label");
        var isOpen = label.textContent === t("toolOtherExpanded");
        label.textContent = isOpen ? t("toolOtherCollapsed") : t("toolOtherExpanded");
        hidden.forEach(function (li) {
          li.classList.toggle("kulms-hidden-tool", isOpen);
        });
      });
    }
  }

  function processAll() {
    document.querySelectorAll(".site-list-item").forEach(processCourse);
  }

  var processing = false;
  var processTimer = null;

  function scheduleProcess() {
    if (processing || processTimer) return;
    processTimer = setTimeout(function () {
      processTimer = null;
      processing = true;
      processAll();
      processing = false;
    }, 200);
  }

  window.__kulmsSettingsReady.then(function (s) {
    if (s.toolVisibility === false) return;
    processAll();

    new MutationObserver(function () {
      if (processing) return;
      scheduleProcess();
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
