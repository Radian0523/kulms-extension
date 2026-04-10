// === 授業資料ツリービュー ===

(function () {
  "use strict";

  var table = document.querySelector("table.resourcesList");
  if (!table) return;

  function initTreeView() {
    console.log("[KULMS Extension] Resources page: applying tree view");

  // --- 深さ判定 (padding-left em値から) ---
  function getDepth(td) {
    var pl = parseFloat(td.style.paddingLeft);
    if (isNaN(pl) || pl <= 0.5) return 0;
    return Math.max(0, Math.round((pl - 0.5) / 1.5));
  }

  // --- フォルダ判定 ---
  function isFolder(tr, td) {
    if (td.querySelector('a[onclick*="doExpand_collection"], a[onclick*="doCollapse_collection"]')) return true;
    if (td.querySelector(".fa-folder, .fa-folder-open")) return true;
    if (td.querySelector('img[src*="folder"]')) return true;
    return false;
  }

  // --- 深さごとの実際のpadding値を収集 (px) ---
  var paddingByDepth = new Map();
  table.querySelectorAll("tbody tr").forEach(function (tr) {
    var td = tr.querySelector("td.title");
    if (!td) return;
    var depth = getDepth(td);
    if (!paddingByDepth.has(depth)) {
      paddingByDepth.set(depth, parseFloat(window.getComputedStyle(td).paddingLeft) || 0);
    }
  });

  // --- 行を処理 ---
  function processRow(tr) {
    if (tr.dataset.kulmsProcessed) return;
    tr.dataset.kulmsProcessed = "1";

    var td = tr.querySelector("td.title");
    if (!td) return;

    var depth = getDepth(td);
    var folder = isFolder(tr, td);

    tr.dataset.kulmsDepth = String(depth);
  }

  // --- フォルダ操作の共通処理 ---
  var isBusy = false;

  function refreshTreeView() {
    table.querySelectorAll("tbody tr").forEach(function (tr) {
      var td = tr.querySelector("td.title");
      if (!td) return;
      var depth = getDepth(td);
      if (!paddingByDepth.has(depth)) {
        paddingByDepth.set(
          depth,
          parseFloat(window.getComputedStyle(td).paddingLeft) || 0
        );
      }
    });
    table.querySelectorAll("tbody tr").forEach(processRow);
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
  // キャプチャフェーズで捕まえ、インラインonclickの実行(=form.submit)を阻止
  table.addEventListener(
    "click",
    function (e) {
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

  // --- 適用 ---
  table.classList.add("kulms-tree-view");
  table.querySelectorAll("tbody tr").forEach(processRow);

  // --- 初回自動展開 ---
  expandAllFolders();

  } // end initTreeView

  window.__kulmsSettingsReady.then(function (s) {
    if (s.treeView === false) return;
    initTreeView();
  });
})();
