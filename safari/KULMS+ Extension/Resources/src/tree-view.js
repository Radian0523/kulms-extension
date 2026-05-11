// === 授業資料フォルダ展開 ===

(function () {
  "use strict";

  var table = document.querySelector("table.resourcesList");
  if (!table) return;

  function initFolderFeatures(settings) {
    console.log("[KULMS Extension] Resources page: applying folder features");

    var enhanced = settings.treeViewEnhanced;

  // --- フォルダ判定 ---
  function isFolder(tr, td) {
    if (td.querySelector('a[onclick*="doExpand_collection"], a[onclick*="doCollapse_collection"]')) return true;
    if (td.querySelector(".fa-folder, .fa-folder-open")) return true;
    if (td.querySelector('img[src*="folder"]')) return true;
    return false;
  }

  // --- 深さ判定 (collectionId パスベース) ---
  function getFolderDepth(td) {
    var el = td.querySelector('a[onclick*="collectionId"]');
    if (!el) return 0;
    var m = (el.getAttribute("onclick") || "").match(/collectionId.*?=\s*'([^']*)'/);
    if (!m) return 0;
    var afterSite = m[1].replace(/\/group\/[^/]+\//, "");
    var segs = afterSite.split("/").filter(function (s) { return s; });
    return segs.length;
  }

  // --- 全行一括処理 (順序保証) ---
  function processRows() {
    var rows = table.querySelectorAll("tbody tr");
    var currentFolderDepth = 0;

    rows.forEach(function (tr) {
      var td = tr.querySelector("td.title");
      if (!td) return;

      var folder = isFolder(tr, td);
      var depth;
      if (folder) {
        depth = getFolderDepth(td);
        currentFolderDepth = depth;
      } else {
        depth = currentFolderDepth + 1;
      }

      tr.dataset.kulmsDepth = String(depth);
      tr.dataset.kulmsType = folder ? "folder" : "file";

      if (enhanced) {
        // インデント適用 (!important で Sakai の CSS を上書き)
        td.style.setProperty("padding-left", (16 + depth * 20) + "px", "important");

        // 展開/折りたたみ矢印
        if (folder) injectArrow(tr, td);
      }
    });
  }

  // --- 展開/折りたたみ矢印 ---
  function injectArrow(tr, td) {
    // 既存矢印を削除して再挿入（展開/折りたたみ状態が変わるため）
    var existing = td.querySelector(".kulms-tree-arrow");
    if (existing) existing.remove();

    var flex = td.querySelector(".d-flex");
    if (!flex) return;

    var isExpanded = !!td.querySelector('a[onclick*="doCollapse_collection"]');
    var isCollapsed = !!td.querySelector('a[onclick*="doExpand_collection"]');
    if (!isExpanded && !isCollapsed) return;

    var arrow = document.createElement("span");
    arrow.className = "kulms-tree-arrow";
    arrow.textContent = isExpanded ? "\u25BE" : "\u25B8"; // ▾ or ▸

    // 展開/折りたたみの情報を data 属性に保存
    var onclickEl = td.querySelector('a[onclick*="collectionId"]');
    if (onclickEl) {
      var parsed = parseOnclick(onclickEl.getAttribute("onclick") || "");
      if (parsed) {
        arrow.dataset.kulmsAction = parsed.action;
        arrow.dataset.kulmsCollectionId = parsed.collectionId;
      }
    }

    flex.insertBefore(arrow, flex.firstChild);
  }

  // --- キーボードナビゲーション ---
  function initKeyboardNav() {
    var activeIndex = -1;

    function getVisibleRows() {
      return Array.from(table.querySelectorAll("tbody tr")).filter(function (tr) {
        return tr.offsetParent !== null; // visible
      });
    }

    function setActive(rows, idx) {
      if (activeIndex >= 0 && rows[activeIndex]) {
        rows[activeIndex].classList.remove("kulms-tree-active");
      }
      activeIndex = idx;
      if (rows[idx]) {
        rows[idx].classList.add("kulms-tree-active");
        rows[idx].scrollIntoView({ block: "nearest" });
      }
    }

    table.setAttribute("tabindex", "0");

    table.addEventListener("keydown", function (e) {
      var rows = getVisibleRows();
      if (rows.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActive(rows, Math.min(activeIndex + 1, rows.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActive(rows, Math.max(activeIndex - 1, 0));
          break;
        case "ArrowRight":
          e.preventDefault();
          // 折りたたまれたフォルダなら展開
          if (activeIndex >= 0 && rows[activeIndex].dataset.kulmsType === "folder") {
            var expandEl = rows[activeIndex].querySelector('.kulms-tree-arrow');
            if (expandEl && expandEl.textContent === "\u25B8") {
              expandEl.click();
            }
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          // 展開されたフォルダなら折りたたむ
          if (activeIndex >= 0 && rows[activeIndex].dataset.kulmsType === "folder") {
            var collapseEl = rows[activeIndex].querySelector('.kulms-tree-arrow');
            if (collapseEl && collapseEl.textContent === "\u25BE") {
              collapseEl.click();
            }
          } else if (activeIndex >= 0) {
            // ファイルなら親フォルダに移動
            var myDepth = parseInt(rows[activeIndex].dataset.kulmsDepth) || 0;
            for (var i = activeIndex - 1; i >= 0; i--) {
              if (rows[i].dataset.kulmsType === "folder" &&
                  parseInt(rows[i].dataset.kulmsDepth) < myDepth) {
                setActive(rows, i);
                break;
              }
            }
          }
          break;
        case "Enter":
          e.preventDefault();
          if (activeIndex >= 0) {
            var link = rows[activeIndex].querySelector("td.title a[href]");
            if (link) link.click();
          }
          break;
      }
    });

    // クリックでもアクティブ行を設定
    table.addEventListener("click", function (e) {
      var tr = e.target.closest("tbody tr");
      if (!tr) return;
      var rows = getVisibleRows();
      var idx = rows.indexOf(tr);
      if (idx >= 0) setActive(rows, idx);
    });
  }

  // --- フォルダ操作の共通処理 ---
  var isBusy = false;

  function refreshTreeView() {
    processRows();
    // innerHTML置換で失われた Bootstrap Popover を再初期化
    if (typeof bootstrap !== "undefined" && bootstrap.Popover) {
      table.querySelectorAll('[data-bs-toggle="popover"]').forEach(function (el) {
        if (!bootstrap.Popover.getInstance(el)) {
          new bootstrap.Popover(el);
        }
      });
    }
  }

  // onclick属性からsakai_actionとcollectionIdを抽出
  function parseOnclick(onclick) {
    var actionMatch = onclick.match(
      /getElementById\s*\(\s*['"]sakai_action['"]\s*\)\.value\s*=\s*'([^']*)'/
    );
    var idMatch = onclick.match(
      /getElementById\s*\(\s*['"]collectionId['"]\s*\)\.value\s*=\s*'([^']*)'/
    );
    if (!actionMatch || !idMatch) return null;
    return { action: actionMatch[1], collectionId: idMatch[1] };
  }

  // fetchでフォルダ操作を実行 (ページ遷移なし)
  async function submitFolderAction(action, collectionId) {
    var form =
      document.getElementById("showForm") ||
      table.closest("form") ||
      document.querySelector("form");
    if (!form) return false;

    var params = new URLSearchParams();
    form.querySelectorAll("input").forEach(function (inp) {
      if (inp.name) params.append(inp.name, inp.value);
    });
    params.set("sakai_action", action);
    params.set("collectionId", collectionId);

    try {
      var res = await fetch(form.action || window.location.href, {
        method: "POST",
        body: params,
        credentials: "include",
      });
      if (!res.ok) return false;

      var html = await res.text();
      var doc = new DOMParser().parseFromString(html, "text/html");
      var newTable = doc.querySelector("table.resourcesList");
      if (!newTable) return false;

      var newTbody = newTable.querySelector("tbody");
      var oldTbody = table.querySelector("tbody");
      if (!newTbody || !oldTbody) return false;
      oldTbody.innerHTML = newTbody.innerHTML;
      return true;
    } catch (e) {
      console.warn("[KULMS] folder action failed:", e);
      return false;
    }
  }

  // --- 全フォルダ自動展開 ---
  async function expandAllFolders() {
    isBusy = true;
    for (var i = 0; i < 30; i++) {
      var collapsed = table.querySelectorAll(
        'td.title a[onclick*="doExpand_collection"]'
      );
      if (collapsed.length === 0) break;

      var parsed = parseOnclick(collapsed[0].getAttribute("onclick") || "");
      if (!parsed) break;

      var ok = await submitFolderAction(parsed.action, parsed.collectionId);
      if (!ok) break;
    }
    isBusy = false;
    refreshTreeView();
  }

  // --- 手動の展開/折りたたみクリックをインターセプト ---
  if (settings.folderExpand || enhanced) {
    // キャプチャフェーズで捕まえ、インラインonclickの実行(=form.submit)を阻止
    table.addEventListener(
      "click",
      function (e) {
        // 矢印クリック対応
        var arrowEl = e.target.closest(".kulms-tree-arrow");
        if (arrowEl && !isBusy) {
          e.preventDefault();
          e.stopPropagation();
          var action = arrowEl.dataset.kulmsAction;
          var collectionId = arrowEl.dataset.kulmsCollectionId;
          if (action && collectionId) {
            isBusy = true;
            submitFolderAction(action, collectionId).then(function () {
              isBusy = false;
              refreshTreeView();
            });
          }
          return;
        }

        var link = e.target.closest(
          'a[onclick*="doExpand_collection"], a[onclick*="doCollapse_collection"]'
        );
        if (!link || isBusy) return;

        e.preventDefault();
        e.stopPropagation();

        var parsed = parseOnclick(link.getAttribute("onclick") || "");
        if (!parsed) return;

        isBusy = true;
        submitFolderAction(parsed.action, parsed.collectionId).then(function () {
          isBusy = false;
          refreshTreeView();
        });
      },
      true
    );
  }

  // --- 適用 ---
  table.classList.add("kulms-tree-view");
  processRows();

  // --- キーボードナビゲーション初期化 ---
  if (enhanced) {
    initKeyboardNav();
  }

  // --- 初回自動展開 ---
  if (settings.autoExpandAll) {
    expandAllFolders();
  }

  } // end initFolderFeatures

  window.__kulmsSettingsReady.then(function (s) {
    if (s.hideResourceColumns) {
      table.classList.add("kulms-hide-columns");
    }

    var enhanced = s.treeViewEnhanced;
    if (enhanced) {
      table.classList.add("kulms-tree-enhanced");
    }

    // treeViewEnhanced が有効なら、folderExpand も暗黙的に有効化
    var needInit = s.folderExpand || s.autoExpandAll || enhanced;
    if (!needInit) return;

    initFolderFeatures(s);
  });
})();
