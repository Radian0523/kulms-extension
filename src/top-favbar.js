// === 上部ピン留めバー ===

(function () {
  "use strict";

  if (window !== window.top) return;

  var BAR_ID = "kulms-top-favbar";
  var HAS_BAR_CLASS = "kulms-has-top-favbar";
  var syncScheduled = false;
  var observer = null;
  var resizeObserver = null;

  // ドロップダウン状態
  var dropdownEl = null;
  var currentDropdownAnchor = null;

  // ツール表示管理と共通: サイドバー既定の表示ツール
  var DROPDOWN_DEFAULT_VISIBLE = ["概要", "授業資料（リソース）", "課題"];
  var TOOL_CONFIG_KEY = "kulms-tool-config";

  function isEnabled() {
    var s = window.__kulmsSettings || {};
    return s.topFavbar === true;
  }

  function getSize() {
    var s = window.__kulmsSettings || {};
    var size = s.topFavbarSize;
    if (size !== "small" && size !== "medium" && size !== "large" && size !== "xlarge") return "medium";
    return size;
  }

  function applySize(bar) {
    if (!bar) return;
    bar.classList.remove(
      "kulms-favbar-size-small",
      "kulms-favbar-size-medium",
      "kulms-favbar-size-large",
      "kulms-favbar-size-xlarge"
    );
    bar.classList.add("kulms-favbar-size-" + getSize());
  }

  function getColorStyle() {
    var s = window.__kulmsSettings || {};
    var style = s.tabColorStyle;
    if (style !== "border" && style !== "background" && style !== "bold") return "border";
    return style;
  }

  function applyColorStyle(bar) {
    if (!bar) return;
    bar.classList.remove("kulms-color-border", "kulms-color-background", "kulms-color-bold");
    bar.classList.add("kulms-color-" + getColorStyle());
  }

  function isCourseRowClickEnabled() {
    return (window.__kulmsSettings || {}).courseRowClick === true;
  }

  function isToolVisibilityEnabled() {
    return (window.__kulmsSettings || {}).toolVisibility === true;
  }

  function applyDropdownMode(bar) {
    if (!bar) return;
    bar.classList.toggle("kulms-favbar-dropdown-mode", isCourseRowClickEnabled());
  }

  // バッジ要素を除外してテキストを取得
  function getCleanText(el) {
    var clone = el.cloneNode(true);
    var badges = clone.querySelectorAll(".kulms-now-badge, .kulms-notification-badge");
    for (var i = 0; i < badges.length; i++) badges[i].remove();
    return (clone.textContent || "").trim();
  }

  function getToolConfig() {
    try { return JSON.parse(localStorage.getItem(TOOL_CONFIG_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function isToolVisibleForSite(siteId, toolName) {
    var cfg = getToolConfig();
    if (cfg[siteId] && cfg[siteId].hasOwnProperty(toolName)) {
      return cfg[siteId][toolName];
    }
    return DROPDOWN_DEFAULT_VISIBLE.indexOf(toolName) !== -1;
  }

  function getSiteIdFromUrl(url) {
    if (!url) return null;
    var m = url.match(/\/portal\/site\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function findSourceToolList(siteId) {
    // 本体サイドバー → ピン留め の順で tool list を探す
    var main = document.getElementById("site-list-item-" + siteId);
    if (main) {
      var ul = main.querySelector(".site-page-list");
      if (ul) return ul;
    }
    var pinned = document.getElementById("site-list-pinned-item-" + siteId);
    if (pinned) {
      var ul2 = pinned.querySelector(".site-page-list");
      if (ul2) return ul2;
    }
    return null;
  }

  function buildDropdown(siteId) {
    var source = findSourceToolList(siteId);
    if (!source) return null;

    var navItems = Array.from(source.querySelectorAll(":scope > .nav-item"));
    // tool-visibility が付与した補助要素は除外
    navItems = navItems.filter(function (li) {
      return !li.classList.contains("kulms-other-toggle");
    });
    if (navItems.length === 0) return null;

    var dd = document.createElement("div");
    dd.className = "kulms-favbar-dropdown";
    dd.setAttribute("role", "menu");

    var toolVis = isToolVisibilityEnabled();
    var visibleItems = [];
    var hiddenItems = [];

    navItems.forEach(function (navItem) {
      var srcLink = navItem.querySelector("a");
      if (!srcLink || !srcLink.href) return;
      var span = navItem.querySelector("span");
      var name = span ? (span.textContent || "").trim() : "";

      var a = document.createElement("a");
      a.className = "kulms-favbar-dropdown-item";
      a.href = srcLink.href;
      a.setAttribute("role", "menuitem");

      var icon = navItem.querySelector("i");
      if (icon) {
        var iconClone = icon.cloneNode(true);
        iconClone.className = icon.className;
        a.appendChild(iconClone);
      }
      var label = document.createElement("span");
      label.className = "kulms-favbar-dropdown-label";
      label.textContent = name;
      a.appendChild(label);

      if (toolVis && !isToolVisibleForSite(siteId, name)) {
        hiddenItems.push(a);
      } else {
        visibleItems.push(a);
      }
    });

    visibleItems.forEach(function (el) { dd.appendChild(el); });

    if (toolVis && hiddenItems.length > 0) {
      var otherToggle = document.createElement("button");
      otherToggle.type = "button";
      otherToggle.className = "kulms-favbar-dropdown-other";
      var otherLabel = document.createElement("span");
      otherLabel.textContent = t("toolOtherCollapsed");
      otherToggle.appendChild(otherLabel);
      dd.appendChild(otherToggle);

      hiddenItems.forEach(function (el) {
        el.classList.add("kulms-hidden-tool");
        dd.appendChild(el);
      });

      otherToggle.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var expandedLabel = t("toolOtherExpanded");
        var collapsedLabel = t("toolOtherCollapsed");
        var isOpen = otherLabel.textContent === expandedLabel;
        otherLabel.textContent = isOpen ? collapsedLabel : expandedLabel;
        hiddenItems.forEach(function (el) {
          el.classList.toggle("kulms-hidden-tool", isOpen);
        });
      });
    }

    return dd;
  }

  function positionDropdown(dd, anchor) {
    var rect = anchor.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + "px";
    // 右端にはみ出さないよう調整
    var left = rect.left;
    var maxLeft = window.innerWidth - dd.offsetWidth - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    dd.style.left = left + "px";
  }

  function closeDropdown() {
    if (currentDropdownAnchor) currentDropdownAnchor.classList.remove("is-open");
    if (dropdownEl) dropdownEl.remove();
    dropdownEl = null;
    currentDropdownAnchor = null;
  }

  function openDropdownFor(anchor) {
    closeDropdown();
    var siteId = getSiteIdFromUrl(anchor.href);
    if (!siteId) return;
    var dd = buildDropdown(siteId);
    if (!dd) return;
    dd.style.position = "fixed";
    dd.style.visibility = "hidden";
    document.body.appendChild(dd);
    positionDropdown(dd, anchor);
    dd.style.visibility = "";
    dropdownEl = dd;
    currentDropdownAnchor = anchor;
    anchor.classList.add("is-open");
  }

  function onBarClick(e) {
    var item = e.target.closest(".kulms-top-favbar-item");
    if (!item) return;
    if (!isCourseRowClickEnabled()) return; // 通常のリンク遷移
    e.preventDefault();
    e.stopPropagation();
    if (currentDropdownAnchor === item) {
      closeDropdown();
    } else {
      openDropdownFor(item);
    }
  }

  function onDocumentClick(e) {
    if (!dropdownEl) return;
    if (dropdownEl.contains(e.target)) return;
    if (currentDropdownAnchor && currentDropdownAnchor.contains(e.target)) return;
    closeDropdown();
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && dropdownEl) closeDropdown();
  }

  function buildBar() {
    var bar = document.createElement("nav");
    bar.id = BAR_ID;
    bar.className = "kulms-top-favbar";
    bar.setAttribute("aria-label", "Pinned courses");
    applySize(bar);
    applyColorStyle(bar);
    applyDropdownMode(bar);
    bar.addEventListener("click", onBarClick);
    return bar;
  }

  function ensureBarInserted() {
    var existing = document.getElementById(BAR_ID);
    if (existing) return existing;
    if (!document.body) return null;
    var bar = buildBar();
    document.body.appendChild(bar);
    document.body.classList.add(HAS_BAR_CLASS);
    return bar;
  }

  function removeBar() {
    closeDropdown();
    var bar = document.getElementById(BAR_ID);
    if (bar) bar.remove();
    if (document.body) {
      document.body.classList.remove(HAS_BAR_CLASS);
      document.body.style.removeProperty("--kulms-favbar-height");
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  }

  function updateBarHeight() {
    var bar = document.getElementById(BAR_ID);
    if (!bar || !document.body) return;
    var h = bar.offsetHeight;
    document.body.style.setProperty("--kulms-favbar-height", h + "px");
  }

  function syncBarContent(bar) {
    var source = document.getElementById("pinned-site-list");
    if (!source) {
      bar.textContent = "";
      updateBarHeight();
      return;
    }

    var frag = document.createDocumentFragment();
    Array.from(source.children).forEach(function (li) {
      // ツールリンク (/tool/) と personal workspace (~...) は除外
      var link = li.querySelector('a[href*="/portal/site/"]');
      if (!link) return;
      if (/\/tool\//.test(link.href)) return;
      if (/\/portal\/site\/~/.test(link.href)) return;

      var item = document.createElement("a");
      item.className = "kulms-top-favbar-item";

      // 色分け継承 (cs-tab-danger / warning / success / other)
      Array.from(li.classList).forEach(function (c) {
        if (c.indexOf("cs-tab-") === 0) item.classList.add(c);
      });

      item.href = link.href;
      var cleanName = getCleanText(link);
      item.title = link.title || cleanName;

      var nameSpan = document.createElement("span");
      nameSpan.className = "kulms-top-favbar-name";
      nameSpan.textContent = cleanName;
      item.appendChild(nameSpan);

      // NOW / NEXT バッジをクローン
      var nowBadge = li.querySelector(".kulms-now-badge");
      if (nowBadge) {
        var clonedNow = nowBadge.cloneNode(true);
        item.appendChild(clonedNow);
      }

      // 新着通知バッジをクローン
      var notif = li.querySelector(".kulms-notification-badge");
      if (notif) {
        var clonedNotif = notif.cloneNode(true);
        item.appendChild(clonedNotif);
      }

      frag.appendChild(item);
    });

    bar.textContent = "";
    bar.appendChild(frag);
    updateBarHeight();
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(function () {
      syncScheduled = false;
      var bar = document.getElementById(BAR_ID);
      if (bar) syncBarContent(bar);
    });
  }

  function startObserver() {
    if (observer) return;
    var source = document.getElementById("pinned-site-list");
    if (!source) return;
    observer = new MutationObserver(scheduleSync);
    observer.observe(source, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function startResizeObserver(bar) {
    if (resizeObserver || typeof ResizeObserver === "undefined") return;
    resizeObserver = new ResizeObserver(function () {
      updateBarHeight();
    });
    resizeObserver.observe(bar);
  }

  function apply() {
    var shouldShow = isEnabled();
    if (shouldShow) {
      var bar = ensureBarInserted();
      if (bar) {
        syncBarContent(bar);
        startObserver();
        startResizeObserver(bar);
      }
    } else {
      stopObserver();
      removeBar();
    }
  }

  function onResize() {
    apply();
    // バー表示中ならリサイズで折り返し位置が変わるので高さを再計算
    updateBarHeight();
    // ドロップダウンが開いているなら位置を追従
    if (dropdownEl && currentDropdownAnchor) {
      positionDropdown(dropdownEl, currentDropdownAnchor);
    }
  }

  window.__kulmsSettingsReady.then(function () {
    apply();
    window.addEventListener("resize", onResize);
    document.addEventListener("click", onDocumentClick, true);
    document.addEventListener("keydown", onKeyDown);

    // 設定変更を即座に反映 (storage 変更を監視)
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local" || !changes["kulms-settings"]) return;
        var newVal = changes["kulms-settings"].newValue || {};
        if (!window.__kulmsSettings) return;
        if (window.__kulmsSettings.topFavbar !== newVal.topFavbar) {
          window.__kulmsSettings.topFavbar = newVal.topFavbar;
          apply();
        }
        if (window.__kulmsSettings.topFavbarSize !== newVal.topFavbarSize) {
          window.__kulmsSettings.topFavbarSize = newVal.topFavbarSize;
          var barSize = document.getElementById(BAR_ID);
          if (barSize) {
            applySize(barSize);
            updateBarHeight();
          }
        }
        if (window.__kulmsSettings.tabColorStyle !== newVal.tabColorStyle) {
          window.__kulmsSettings.tabColorStyle = newVal.tabColorStyle;
          var barStyle = document.getElementById(BAR_ID);
          if (barStyle) applyColorStyle(barStyle);
        }
        if (window.__kulmsSettings.courseRowClick !== newVal.courseRowClick) {
          window.__kulmsSettings.courseRowClick = newVal.courseRowClick;
          var barDd = document.getElementById(BAR_ID);
          if (barDd) applyDropdownMode(barDd);
          closeDropdown();
        }
        if (window.__kulmsSettings.toolVisibility !== newVal.toolVisibility) {
          window.__kulmsSettings.toolVisibility = newVal.toolVisibility;
          closeDropdown();
        }
      });
    } catch (e) {
      window.__kulmsShowReloadBanner();
    }

    // ヘッダー挿入タイミングに備えて、body 変化でも再試行
    new MutationObserver(function () {
      if (!isEnabled()) return;
      if (!document.getElementById(BAR_ID)) {
        apply();
      }
      if (!observer && document.getElementById("pinned-site-list")) {
        startObserver();
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
