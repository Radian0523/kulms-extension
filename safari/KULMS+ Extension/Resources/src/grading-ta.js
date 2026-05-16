// === TA 採点支援 ===
//
// Sakai の採点画面（個別生徒の Grader UI）に以下を追加する:
//   F1  「次/前の提出済み × 未採点へ」ジャンプボタン
//   F2  受講者選択ドロップダウン option に提出/採点状態アイコン
//   F4  成績提出 Offcanvas を開いたまま背景の PDF 等を操作可能化
//   F5  ヘッダーに「未採点提出 N 件」を追加表示
//   F6  採点一覧画面の状態列に提出/採点状態アイコン
//
// 起動条件: ページに `#grader-submitter-select` または採点用 `#submissionList` が存在する場合のみ。
// 学生ロールでは Sakai サーバ側で剥奪されるため絶対に出現しない（実機検証済）。

(function () {
  "use strict";

  if (window !== window.top) return;

  var SUBMITTED_PREFIX = "未採点 - 提出済み";
  var IN_PROGRESS_PREFIX = "未採点 - 取組中";
  var NOT_SUBMITTED_PREFIX = "未提出";
  var GRADED_LABEL = "採点済み";
  var RETURNED_LABEL = "返却済み";
  var PROGRESS_RE = /(?:採点済み|Graded)\s*\d+\s*\/\s*\d+/i;
  var STATUS_ICON_PREFIX_RE = /^(?:(?:\uD83D[\uDFE0-\uDFE2\uDFE8]|⚪|✅)\s*)+/;

  var ICONS = {
    pendingGrade: "🟡",   // 🟡
    inProgress: "🟠",     // 🟠
    notSubmitted: "⚪",         // ⚪
    graded: "🟨",         // 🟨
    returned: "✅",             // ✅
    unknown: ""
  };

  var STATUS_LEGEND = [
    { kind: "pendingGrade", labelKey: "gradingLegendPending" },
    { kind: "inProgress", labelKey: "gradingLegendInProgress" },
    { kind: "notSubmitted", labelKey: "gradingLegendNotSubmitted" },
    { kind: "graded", labelKey: "gradingLegendGraded" },
    { kind: "returned", labelKey: "gradingLegendReturned" }
  ];

  var ACTION_LEGEND = [
    { marker: "Prev", labelKey: "gradingLegendPrev" },
    { marker: "Next", labelKey: "gradingLegendNext" }
  ];

  var pageBridgePromise = null;

  function findGraderElement() {
    return document.querySelector('sakai-grader[id^="sakai-grader-"]') ||
      document.querySelector("sakai-grader");
  }

  function findAssignmentId(grader) {
    if (grader && grader.id) {
      var idMatch = grader.id.match(/^sakai-grader-(.+)$/);
      if (idMatch) return idMatch[1];
    }

    var searchMatch = location.search.match(/assignmentId=\/assignment\/a\/[^/]+\/([^&]+)/);
    if (searchMatch) return decodeURIComponent(searchMatch[1]);

    var assignmentLink = document.querySelector('a[href*="assignmentId=/assignment/a/"]');
    if (assignmentLink) {
      var hrefMatch = assignmentLink.href.match(/assignmentId=\/assignment\/a\/[^/]+\/([^&]+)/);
      if (hrefMatch) return decodeURIComponent(hrefMatch[1]);
    }

    return "";
  }

  function classifyStatus(s) {
    if (!s) return "unknown";
    var text = stripStatusIcon(s);
    var resubmitted = /再提出済み|Re-?submitted/i.test(text);
    if (resubmitted && (text.indexOf(GRADED_LABEL) >= 0 || /Graded/i.test(text))) return "graded";
    if (resubmitted) return "pendingGrade";
    if (text.indexOf(SUBMITTED_PREFIX) === 0 || /^Ungraded\s*[-–]\s*Submitted/i.test(text) || /^(Submitted,\s*)?Awaiting Grade/i.test(text)) return "pendingGrade";
    if (text.indexOf(IN_PROGRESS_PREFIX) === 0 || /^Ungraded\s*[-–]\s*In Progress/i.test(text)) return "inProgress";
    if (text.indexOf(NOT_SUBMITTED_PREFIX) === 0 || /^(No Submission|Not Submitted)(?:\s*[-–].*)?$/i.test(text) || /^Honor Pledge Accepted$/i.test(text)) return "notSubmitted";
    if (text.indexOf(RETURNED_LABEL) >= 0 || /Returned/i.test(text)) return "returned";
    if (text === GRADED_LABEL || /^Graded(?:\s*[-–].*)?$/i.test(text)) return "graded";
    return "unknown";
  }

  function stripStatusIcon(text) {
    return String(text || "").trim().replace(STATUS_ICON_PREFIX_RE, "").trim();
  }

  function getLegendLabelKey(kind) {
    for (var i = 0; i < STATUS_LEGEND.length; i++) {
      if (STATUS_LEGEND[i].kind === kind) return STATUS_LEGEND[i].labelKey;
    }
    return "";
  }

  function parseContext() {
    var select = document.getElementById("grader-submitter-select");
    if (!select) return null;
    var grader = findGraderElement();
    if (!grader) return null;
    var assignmentId = findAssignmentId(grader);
    if (!assignmentId) return null;
    var m = location.pathname.match(/\/portal\/site\/([^/]+)\/tool\/([^/]+)/);
    if (!m) return null;
    return {
      siteId: m[1],
      toolId: m[2],
      assignmentId: assignmentId,
      select: select,
      grader: grader
    };
  }

  function buildGradeUrl(ctx, submissionId) {
    return location.origin + "/portal/site/" + ctx.siteId + "/tool/" + ctx.toolId +
      "?assignmentId=/assignment/a/" + ctx.siteId + "/" + ctx.assignmentId +
      "&submissionId=/assignment/s/" + ctx.siteId + "/" + ctx.assignmentId + "/" + submissionId +
      "&panel=Main&sakai_action=doGrade_submission";
  }

  function buildListUrlCandidates(ctx) {
    var base = location.origin + "/portal/site/" + ctx.siteId + "/tool/" + ctx.toolId;
    return [
      base + "?assignmentId=/assignment/a/" + ctx.siteId + "/" + ctx.assignmentId + "&panel=Main",
      base + "?panel=Main"
    ];
  }

  // === 状態マップ取得層 ===

  function parseGradeLinkIds(href) {
    var assignmentMatch = String(href || "").match(/assignmentId=\/assignment\/a\/([^/]+)\/([^/&]+)/);
    var submissionMatch = String(href || "").match(/submissionId=\/assignment\/s\/([^/]+)\/([^/]+)\/([0-9a-f-]+)/);
    return {
      siteId: decodeURIComponent((submissionMatch && submissionMatch[1]) || (assignmentMatch && assignmentMatch[1]) || ""),
      assignmentId: decodeURIComponent((submissionMatch && submissionMatch[2]) || (assignmentMatch && assignmentMatch[2]) || ""),
      submissionId: (submissionMatch && submissionMatch[3]) || ""
    };
  }

  function findSubmissionListSubmitColumn(table) {
    var headerCells = getSubmissionListHeaderCells(table);
    for (var i = 0; i < headerCells.length; i++) {
      var text = (headerCells[i].textContent || "").trim();
      if (/提出日時|Submitted/.test(text)) return i;
    }
    return -1;
  }

  function parseSubmissionListGroups(table, statusColIdx, submitColIdx) {
    var groups = {};
    var rows = table.querySelectorAll("tbody tr");
    if (!rows.length) rows = table.querySelectorAll("tr");

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (row.parentElement && row.parentElement.tagName === "THEAD") continue;
      var cells = row.children;
      if (cells.length <= statusColIdx) continue;

      var nameLink = row.querySelector('a[href*="doGrade_submission"]');
      if (!nameLink) continue;
      var ids = parseGradeLinkIds(nameLink.getAttribute("href") || "");
      if (!ids.siteId || !ids.assignmentId || !ids.submissionId) continue;

      var groupKey = ids.siteId + ":" + ids.assignmentId;
      if (!groups[groupKey]) {
        groups[groupKey] = {
          siteId: ids.siteId,
          assignmentId: ids.assignmentId,
          map: {}
        };
      }

      var status = stripStatusIcon(cells[statusColIdx].textContent || "");
      var name = (nameLink.textContent || "").trim();
      var submitTime = submitColIdx >= 0 ? (cells[submitColIdx].textContent || "").trim().replace(/\s+/g, " ") : "";
      groups[groupKey].map[ids.submissionId] = {
        name: name,
        status: status,
        kind: classifyStatus(status),
        submitTime: submitTime,
        source: "submissionList",
        cachedAt: Date.now()
      };
    }

    return groups;
  }

  function parseSubmissionList(doc) {
    var table = doc.getElementById("submissionList");
    if (!table) return null;

    var statusColIdx = findSubmissionListStatusColumn(table);
    if (statusColIdx < 0) return null;
    var groups = parseSubmissionListGroups(table, statusColIdx, findSubmissionListSubmitColumn(table));
    var keys = Object.keys(groups);
    return keys.length > 0 ? groups[keys[0]].map : null;
  }

  function classifySubmission(submission) {
    var statusKind = classifyStatus(submission.status);
    if (statusKind !== "unknown") return statusKind;
    if (submission.draft) return "inProgress";
    if (submission.hasHistory && submission.submitted && !submission.draft && submission.returned) return "pendingGrade";
    if (submission.returned) return "returned";
    if (submission.graded || submission.grade) return "graded";
    if (submission.submittedTime || submission.submitted) return "pendingGrade";
    return "notSubmitted";
  }

  function buildStatusLabel(kind, submission) {
    if (kind === "returned") return RETURNED_LABEL;
    if (kind === "graded") return GRADED_LABEL;
    if (kind === "pendingGrade") return SUBMITTED_PREFIX + (submission.submittedTime ? " " + submission.submittedTime : "");
    if (kind === "inProgress") return IN_PROGRESS_PREFIX;
    if (kind === "notSubmitted") return NOT_SUBMITTED_PREFIX;
    return "";
  }

  function installPageBridge() {
    if (pageBridgePromise) return pageBridgePromise;
    pageBridgePromise = new Promise(function (resolve) {
      var script = null;
      try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) {
          resolve();
          return;
        }
        script = document.createElement("script");
        script.src = chrome.runtime.getURL("src/grading-ta-page.js");
        script.onload = function () {
          script.remove();
          resolve();
        };
        script.onerror = function () {
          console.warn("[KULMS+ TA] failed to inject page bridge");
          script.remove();
          resolve();
        };
        (document.head || document.documentElement).appendChild(script);
      } catch (e) {
        console.warn("[KULMS+ TA] failed to prepare page bridge:", e);
        if (script) script.remove();
        resolve();
      }
    });
    return pageBridgePromise;
  }

  function requestPageSubmissions() {
    return installPageBridge().then(function () {
      return new Promise(function (resolve) {
        var requestId = "kulms-ta-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        var timer = window.setTimeout(function () {
          window.removeEventListener("kulms-ta-submissions", onSubmissions);
          resolve([]);
        }, 300);

        function onSubmissions(event) {
          var detail = parseBridgeDetail(event.detail);
          if (!detail || detail.requestId !== requestId) return;
          window.clearTimeout(timer);
          window.removeEventListener("kulms-ta-submissions", onSubmissions);
          resolve(Array.isArray(detail.submissions) ? detail.submissions : []);
        }

        window.addEventListener("kulms-ta-submissions", onSubmissions);
        window.dispatchEvent(new window.CustomEvent("kulms-ta-get-submissions", {
          detail: JSON.stringify({ requestId: requestId })
        }));
      });
    }).catch(function () {
      return [];
    });
  }

  function parseBridgeDetail(detail) {
    if (typeof detail === "string") {
      try {
        return JSON.parse(detail);
      } catch {
        return null;
      }
    }
    return detail && typeof detail === "object" ? detail : null;
  }

  function parseGraderSubmissions(submissions) {
    if (!Array.isArray(submissions) || submissions.length === 0) return null;

    var map = {};
    submissions.forEach(function (submission) {
      if (!submission || !submission.id) return;
      var kind = classifySubmission(submission);
      var hasExplicitStatus = !!submission.status;
      map[submission.id] = {
        name: submission.firstSubmitterName || "",
        status: submission.status || buildStatusLabel(kind, submission),
        kind: kind,
        submitTime: submission.submittedTime || "",
        source: "originalSubmissions",
        statusSource: hasExplicitStatus ? "explicit" : "derived"
      };
    });
    return Object.keys(map).length > 0 ? map : null;
  }

  function getStatusCacheKey(ctx) {
    return "kulms-ta-status-map:" + ctx.siteId + ":" + ctx.assignmentId;
  }

  function loadStatusCache(ctx) {
    try {
      var raw = sessionStorage.getItem(getStatusCacheKey(ctx));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.version === 1 && parsed.map ? parsed.map : null;
    } catch {
      return null;
    }
  }

  function saveStatusCache(ctx, map) {
    try {
      sessionStorage.setItem(getStatusCacheKey(ctx), JSON.stringify({
        version: 1,
        map: map
      }));
    } catch {
      // sessionStorage may be unavailable in hardened browser settings.
    }
  }

  function clearStatusCache(ctx) {
    try {
      sessionStorage.removeItem(getStatusCacheKey(ctx));
    } catch {
      // sessionStorage may be unavailable in hardened browser settings.
    }
  }

  function mergeStatusCache(ctx, map) {
    var cached = loadStatusCache(ctx);
    if (!cached) {
      saveStatusCache(ctx, map);
      return map;
    }

    var merged = {};
    Object.keys(map).forEach(function (sid) {
      merged[sid] = map[sid];
    });

    Object.keys(cached).forEach(function (sid) {
      var cachedEntry = cached[sid];
      var currentEntry = merged[sid];
      if (!cachedEntry || !currentEntry) return;

      if (
        cachedEntry.source === "submissionList" &&
        cachedEntry.kind === "returned" &&
        currentEntry.kind === "graded"
      ) {
        merged[sid] = cachedEntry;
        return;
      }

      if (
        cachedEntry.source === "submissionList" &&
        cachedEntry.kind === "inProgress" &&
        currentEntry.kind === "pendingGrade" &&
        currentEntry.statusSource === "derived"
      ) {
        merged[sid] = cachedEntry;
        return;
      }

      if (cachedEntry.kind !== "pendingGrade") return;
      if (currentEntry.kind === "graded" || currentEntry.kind === "returned") return;
      if (currentEntry.kind !== "pendingGrade") merged[sid] = cachedEntry;
    });

    saveStatusCache(ctx, merged);
    return merged;
  }

  function fetchStatusMap(ctx) {
    return requestPageSubmissions().then(function (submissions) {
      var liveMap = parseGraderSubmissions(submissions);
      if (liveMap) return liveMap;

      var urls = buildListUrlCandidates(ctx);
      var attempt = function (idx) {
        if (idx >= urls.length) return Promise.resolve(null);
        return fetch(urls[idx], { credentials: "include" })
          .then(function (res) { return res.text(); })
          .then(function (html) {
            var doc = new DOMParser().parseFromString(html, "text/html");
            var map = parseSubmissionList(doc);
            if (map) {
              return map;
            }
            return attempt(idx + 1);
          })
          .catch(function () { return attempt(idx + 1); });
      };
      return attempt(0);
    });
  }

  // === F4: Offcanvas backdrop 解除 ===

  function setupGraderUnblock() {
    var LAYOUT_CLASS = "kulms-grader-unblocked";
    var BACKDROP_CLASS = "kulms-grader-backdropless";
    var lastLayoutOpen = null;
    var lastBackdropless = null;

    function syncGraderWidth(grader) {
      if (!grader) return;
      var width = Math.ceil(grader.getBoundingClientRect().width || grader.offsetWidth || 420);
      document.documentElement.style.setProperty("--kulms-ta-grader-width", width + "px");
    }

    function check() {
      var grader = document.getElementById("grader");
      var layoutOpen = grader && (
        grader.classList.contains("show") ||
        grader.classList.contains("showing")
      );
      var backdropless = layoutOpen || (grader && grader.classList.contains("hiding"));
      var layoutChanged = layoutOpen !== lastLayoutOpen;
      var backdropChanged = backdropless !== lastBackdropless;
      if (!layoutChanged && !backdropChanged) return;

      if (backdropless) {
        syncGraderWidth(grader);
        document.body.classList.add(BACKDROP_CLASS);
      }

      if (layoutOpen) {
        document.body.classList.add(LAYOUT_CLASS);
      } else {
        document.body.classList.remove(LAYOUT_CLASS);
      }

      if (!backdropless) {
        document.body.classList.remove(BACKDROP_CLASS);
        document.documentElement.style.removeProperty("--kulms-ta-grader-width");
      }

      lastLayoutOpen = layoutOpen;
      lastBackdropless = backdropless;
    }

    var observedGrader = null;
    var graderObserver = new MutationObserver(check);

    function observeGrader() {
      var grader = document.getElementById("grader");
      if (grader === observedGrader) return;
      graderObserver.disconnect();
      observedGrader = grader;
      if (grader) {
        graderObserver.observe(grader, {
          attributes: true,
          attributeFilter: ["class"]
        });
      }
      check();
    }

    var observer = new MutationObserver(observeGrader);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    observeGrader();
    window.addEventListener("resize", check);
  }

  // === F2: option アイコン付与 ===

  function applyOptionIcons(ctx, statusMap) {
    var options = ctx.select.options;
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      var entry = statusMap[opt.value];
      var icon = entry ? ICONS[entry.kind] : "";
      if (!icon) continue;
      var prefix = icon + " ";
      if (opt.dataset.kulmsIcon === icon && opt.text.indexOf(prefix) === 0) continue;
      // 既存の絵文字 prefix を除去してから付ける
      var clean = stripStatusIcon(opt.text);
      opt.text = prefix + clean;
      opt.dataset.kulmsIcon = icon;
    }
  }

  // === F6: 採点一覧の状態アイコン ===

  function getSubmissionListHeaderCells(table) {
    var headerCells = table.querySelectorAll("thead th, thead td");
    if (headerCells.length) return headerCells;
    var firstRow = table.querySelector("tr");
    return firstRow ? firstRow.querySelectorAll("th, td") : [];
  }

  function getSubmissionListHeaderText(table) {
    var headerCells = getSubmissionListHeaderCells(table);
    var parts = [];
    for (var i = 0; i < headerCells.length; i++) {
      parts.push((headerCells[i].textContent || "").trim());
    }
    return parts.join(" ");
  }

  function findSubmissionListStatusColumn(table) {
    var headerCells = getSubmissionListHeaderCells(table);
    for (var i = 0; i < headerCells.length; i++) {
      var text = (headerCells[i].textContent || "").trim();
      if (/状態|Status/.test(text)) return i;
    }
    return -1;
  }

  function isGradingSubmissionListTable(table, statusColIdx) {
    if (statusColIdx < 0) return false;
    if (table.id === "submissionList") return true;
    var headerText = getSubmissionListHeaderText(table);
    var hasSubmitterHeader = /受講者|学生番号|学生|氏名|名前|Student|Learner|Name|User ID/i.test(headerText);
    var hasSubmissionHeader = /提出日時|Submitted|再提出|Resubmission/i.test(headerText);
    var hasGradeHeader = /成績|Grade|点数|Score|開示|Release/i.test(headerText);
    var hasSubmissionLink = !!table.querySelector('a[href*="doGrade_submission"], a[href*="submissionId=/assignment/s/"]');
    return hasSubmissionLink || (hasSubmitterHeader && hasSubmissionHeader && hasGradeHeader);
  }

  function findSubmissionListTables() {
    var tables = [];
    var seen = [];

    function addTable(table) {
      if (!table || table.tagName !== "TABLE" || seen.indexOf(table) >= 0) return;
      seen.push(table);
      tables.push(table);
    }

    addTable(document.getElementById("submissionList"));
    var candidates = document.querySelectorAll("table");
    for (var i = 0; i < candidates.length; i++) addTable(candidates[i]);
    return tables;
  }

  function decorateSubmissionListStatusCell(cell, kind) {
    var iconText = ICONS[kind];
    if (!iconText) return false;

    var clean = stripStatusIcon(cell.textContent || "");
    var existing = cell.querySelector(".kulms-ta-list-status-icon");
    if (
      existing &&
      existing.textContent === iconText &&
      cell.dataset.kulmsStatusKind === kind &&
      cell.dataset.kulmsStatusText === clean
    ) {
      return false;
    }

    cell.textContent = "";
    var icon = document.createElement("span");
    icon.className = "kulms-ta-list-status-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = iconText;
    cell.appendChild(icon);
    cell.appendChild(document.createTextNode(clean));
    cell.classList.add("kulms-ta-list-status-cell");
    cell.dataset.kulmsStatusKind = kind;
    cell.dataset.kulmsStatusText = clean;

    var labelKey = getLegendLabelKey(kind);
    if (labelKey) cell.title = t(labelKey);
    return true;
  }

  function saveSubmissionListStatusCache(table, statusColIdx) {
    var groups = parseSubmissionListGroups(table, statusColIdx, findSubmissionListSubmitColumn(table));
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      saveStatusCache({
        siteId: group.siteId,
        assignmentId: group.assignmentId
      }, group.map);
    });
  }

  function applySubmissionListIcons() {
    var tables = findSubmissionListTables();
    if (!tables.length) return false;

    var foundGradingRows = false;
    for (var tIdx = 0; tIdx < tables.length; tIdx++) {
      var table = tables[tIdx];
      var statusColIdx = findSubmissionListStatusColumn(table);
      if (!isGradingSubmissionListTable(table, statusColIdx)) continue;
      saveSubmissionListStatusCache(table, statusColIdx);

      var rows = table.querySelectorAll("tbody tr");
      if (!rows.length) rows = table.querySelectorAll("tr");
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (row.parentElement && row.parentElement.tagName === "THEAD") continue;
        var cells = row.children;
        if (cells.length <= statusColIdx) continue;

        var status = stripStatusIcon(cells[statusColIdx].textContent || "");
        var kind = classifyStatus(status);
        if (kind === "unknown") continue;

        foundGradingRows = true;
        decorateSubmissionListStatusCell(cells[statusColIdx], kind);
      }
    }
    return foundGradingRows;
  }

  function queueSubmissionListIconReapply() {
    if (listReapplyQueued) return;
    listReapplyQueued = true;
    window.requestAnimationFrame(function () {
      listReapplyQueued = false;
      applySubmissionListIcons();
    });
  }

  function installSubmissionListObserver() {
    if (listObserver) return;
    listObserver = new MutationObserver(function () {
      queueSubmissionListIconReapply();
    });
    listObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // === F5: 残数表示 ===

  function findProgressContainer(root) {
    var total = root.querySelector && root.querySelector("#grader-total");
    if (total && PROGRESS_RE.test(total.innerText || total.textContent || "")) return total;

    // "採点済み 41 / 54" を含むテキストノードを探す
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return PROGRESS_RE.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var node = walker.nextNode();
    if (node && node.parentElement) return node.parentElement;

    var candidates = root.querySelectorAll ? root.querySelectorAll("div, span, p") : [];
    for (var i = 0; i < candidates.length; i++) {
      var text = candidates[i].innerText || candidates[i].textContent || "";
      if (PROGRESS_RE.test(text)) return candidates[i];
    }
    return null;
  }

  function applyPendingCount(ctx, statusMap) {
    var pending = 0;
    Object.keys(statusMap).forEach(function (sid) {
      if (statusMap[sid].kind === "pendingGrade") pending++;
    });

    var parent = findProgressContainer(ctx.grader);
    if (!parent) return;

    var badge = parent.querySelector(".kulms-ta-pending-count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "kulms-ta-pending-count";
      parent.appendChild(badge);
    }
    var text = " · " + t("gradingPendingCount", String(pending));
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.dataset.kulmsCount !== String(pending)) badge.dataset.kulmsCount = String(pending);
  }

  // === F1: ジャンプボタン ===

  function findNextPendingIndex(ctx, statusMap, dir) {
    var options = ctx.select.options;
    var current = ctx.select.selectedIndex;
    var step = dir > 0 ? 1 : -1;
    if (!options.length || current < 0) return -1;
    for (var offset = 1; offset < options.length; offset++) {
      var i = (current + step * offset + options.length) % options.length;
      var entry = statusMap[options[i].value];
      if (entry && entry.kind === "pendingGrade") return i;
    }
    return -1;
  }

  function jumpTo(ctx, statusMap, dir) {
    var idx = findNextPendingIndex(ctx, statusMap, dir);
    if (idx < 0) return false;
    if (!confirmLeaveIfDirty()) return false;
    var submissionId = ctx.select.options[idx].value;
    location.href = buildGradeUrl(ctx, submissionId);
    return true;
  }

  function jumpCurrent(dir) {
    var ctx = parseContext() || currentState.ctx;
    if (!ctx || !currentState.statusMap) return false;
    currentState.ctx = ctx;
    return jumpTo(ctx, currentState.statusMap, dir);
  }

  function injectJumpButtons(ctx) {
    var parent = ctx.select.parentElement;
    if (!parent) return;
    if (parent.querySelector(".kulms-ta-jump-next")) return;

    var nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "btn btn-transparent kulms-ta-jump kulms-ta-jump-next";
    nextBtn.setAttribute("aria-label", t("gradingJumpNextAria"));
    nextBtn.title = t("gradingJumpNext");
    nextBtn.textContent = t("gradingJumpNextShort");
    nextBtn.addEventListener("click", function () {
      jumpCurrent(1);
    });

    var prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "btn btn-transparent kulms-ta-jump kulms-ta-jump-prev";
    prevBtn.setAttribute("aria-label", t("gradingJumpPrevAria"));
    prevBtn.title = t("gradingJumpPrev");
    prevBtn.textContent = t("gradingJumpPrevShort");
    prevBtn.addEventListener("click", function () {
      jumpCurrent(-1);
    });

    // 既存の「次の提出物を表示」ボタンの直後に挿入
    var sakaiNext = parent.querySelector('button[aria-label="次の提出物を表示"]');
    if (sakaiNext && sakaiNext.nextSibling) {
      parent.insertBefore(prevBtn, sakaiNext.nextSibling);
      parent.insertBefore(nextBtn, prevBtn.nextSibling);
    } else if (sakaiNext) {
      parent.appendChild(prevBtn);
      parent.appendChild(nextBtn);
    } else {
      parent.appendChild(prevBtn);
      parent.appendChild(nextBtn);
    }
  }

  function injectStatusLegend(ctx) {
    var parent = ctx.select.parentElement;
    if (!parent || parent.querySelector(".kulms-ta-legend")) return;

    var legend = document.createElement("span");
    legend.className = "kulms-ta-legend";
    legend.tabIndex = 0;
    legend.setAttribute("role", "button");
    legend.setAttribute("aria-label", t("gradingLegendAria"));

    var trigger = document.createElement("span");
    trigger.className = "kulms-ta-legend-trigger";
    trigger.textContent = "?";
    legend.appendChild(trigger);

    var panel = document.createElement("span");
    panel.className = "kulms-ta-legend-panel";
    panel.setAttribute("role", "tooltip");
    STATUS_LEGEND.forEach(function (item) {
      var row = document.createElement("span");
      row.className = "kulms-ta-legend-row";

      var icon = document.createElement("span");
      icon.className = "kulms-ta-legend-icon";
      icon.textContent = ICONS[item.kind];

      var label = document.createElement("span");
      label.className = "kulms-ta-legend-label";
      label.textContent = t(item.labelKey);

      row.appendChild(icon);
      row.appendChild(label);
      panel.appendChild(row);
    });
    ACTION_LEGEND.forEach(function (item) {
      var row = document.createElement("span");
      row.className = "kulms-ta-legend-row";

      var marker = document.createElement("span");
      marker.className = "kulms-ta-legend-icon kulms-ta-legend-action";
      marker.textContent = item.marker;

      var label = document.createElement("span");
      label.className = "kulms-ta-legend-label";
      label.textContent = t(item.labelKey);

      row.appendChild(marker);
      row.appendChild(label);
      panel.appendChild(row);
    });
    legend.appendChild(panel);

    var nextJump = parent.querySelector(".kulms-ta-jump-next");
    if (nextJump && nextJump.nextSibling) {
      parent.insertBefore(legend, nextJump.nextSibling);
    } else if (nextJump) {
      parent.appendChild(legend);
    } else {
      parent.appendChild(legend);
    }
  }

  // === セットアップ本体 ===

  var booted = false;
  var currentState = { ctx: null, statusMap: null };
  var statusRequestSeq = 0;
  var reapplyQueued = false;
  var decorationObserver = null;
  var listIconsInstalled = false;
  var listReapplyQueued = false;
  var listObserver = null;
  var graderDirty = false;
  var allowNextUnload = false;

  function refreshStatusMap(ctx, retriesLeft) {
    var seq = ++statusRequestSeq;
    var remaining = typeof retriesLeft === "number" ? retriesLeft : 10;
    currentState.statusMap = null;
    return fetchStatusMap(ctx).then(function (map) {
      if (seq !== statusRequestSeq) return null;
      if (!map) {
        if (remaining > 0) {
          window.setTimeout(function () {
            refreshStatusMap(parseContext() || ctx, remaining - 1);
          }, 500);
          return null;
        }
        console.warn("[KULMS+ TA] failed to fetch submission status map");
        return null;
      }
      map = mergeStatusCache(ctx, map);
      currentState.ctx = parseContext() || ctx;
      currentState.statusMap = map;
      reapplyDecorations();
      return map;
    }).catch(function (e) {
      if (seq === statusRequestSeq) console.warn("[KULMS+ TA] failed to fetch submission status map:", e);
      return null;
    });
  }

  function reapplyDecorations() {
    if (!currentState.statusMap) return;
    var ctx = parseContext();
    if (!ctx) return;
    if (!currentState.ctx || currentState.ctx.select !== ctx.select) installDecorationObserver(ctx);
    currentState.ctx = ctx;
    applyOptionIcons(currentState.ctx, currentState.statusMap);
    applyPendingCount(currentState.ctx, currentState.statusMap);
    injectJumpButtons(currentState.ctx);
    injectStatusLegend(currentState.ctx);
  }

  function queueReapplyDecorations() {
    if (reapplyQueued) return;
    reapplyQueued = true;
    window.setTimeout(function () {
      reapplyQueued = false;
      reapplyDecorations();
    }, 0);
  }

  function installDecorationObserver(ctx) {
    if (decorationObserver) decorationObserver.disconnect();
    decorationObserver = new MutationObserver(queueReapplyDecorations);
    if (ctx.select) {
      decorationObserver.observe(ctx.select, { childList: true });
    }
    if (ctx.select && ctx.select.parentElement) {
      decorationObserver.observe(ctx.select.parentElement, { childList: true });
    }
  }

  function installSaveInvalidation(ctx) {
    document.addEventListener("click", function (e) {
      var button = e.target && e.target.closest ? e.target.closest("button, input[type='button'], input[type='submit']") : null;
      if (!button) return;
      if (!button.closest || !button.closest("#grader")) return;
      var text = ((button.textContent || button.value || "") + " " + (button.getAttribute("aria-label") || "")).trim();
      if (/保存|Save|返却|Return|提出|Submit/.test(text)) {
        graderDirty = false;
        allowNextUnload = true;
        window.setTimeout(function () { allowNextUnload = false; }, 3000);
        if (currentState.ctx || ctx) clearStatusCache(currentState.ctx || ctx);
        currentState.statusMap = null;
        window.setTimeout(function () {
          refreshStatusMap(parseContext() || ctx);
        }, 1200);
      }
    }, true);
  }

  function confirmLeaveIfDirty() {
    if (!graderDirty) return true;
    if (!window.confirm(t("gradingUnsavedConfirm"))) return false;
    allowNextUnload = true;
    window.setTimeout(function () { allowNextUnload = false; }, 3000);
    return true;
  }

  function isDirtyNavigationControl(control) {
    if (!control) return false;
    var tag = control.tagName;
    if (tag === "A") {
      var href = control.getAttribute("href") || "";
      return !!href && href !== "#" && href.indexOf("javascript:") !== 0;
    }
    var text = [
      control.textContent || "",
      control.value || "",
      control.getAttribute("aria-label") || "",
      control.getAttribute("title") || ""
    ].join(" ");
    return /前の提出物|次の提出物|一覧へ戻る|設定|previous submission|next submission|Back to list|Settings/i.test(text);
  }

  function installDirtyNavigationGuard(ctx) {
    var lastSubmitterValue = ctx.select && ctx.select.value;
    document.addEventListener("change", function (e) {
      var select = e.target;
      if (!select || select.id !== "grader-submitter-select") return;
      if (!graderDirty) {
        lastSubmitterValue = select.value;
        return;
      }
      if (!confirmLeaveIfDirty()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        select.value = lastSubmitterValue;
        return;
      }
      lastSubmitterValue = select.value;
    }, true);

    document.addEventListener("click", function (e) {
      if (!graderDirty) return;
      var control = e.target && e.target.closest ? e.target.closest("a, button, input[type='button'], input[type='submit']") : null;
      if (!control || control.closest("#grader") || control.closest(".kulms-ta-jump")) return;
      if (!isDirtyNavigationControl(control)) return;
      if (!confirmLeaveIfDirty()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    window.addEventListener("beforeunload", function (e) {
      if (!graderDirty || allowNextUnload) return;
      var message = t("gradingUnsavedConfirm");
      e.preventDefault();
      e.returnValue = message;
      return message;
    });
  }

  function installGraderDirtyGuard() {
    document.addEventListener("input", function (e) {
      if (e.target && e.target.closest && e.target.closest("#grader")) graderDirty = true;
    }, true);
    document.addEventListener("change", function (e) {
      if (e.target && e.target.closest && e.target.closest("#grader")) graderDirty = true;
    }, true);
  }

  function bootGrader() {
    if (booted) return;
    var ctx = parseContext();
    if (!ctx) return;
    booted = true;
    currentState.ctx = ctx;
    console.log("[KULMS+ TA] grading UI detected, fetching status map...");

    setupGraderUnblock();
    installDecorationObserver(ctx);
    installGraderDirtyGuard();
    installDirtyNavigationGuard(ctx);
    installSaveInvalidation(ctx);

    refreshStatusMap(ctx);
  }

  function bootSubmissionList() {
    if (listIconsInstalled) return;
    if (!applySubmissionListIcons()) return;
    listIconsInstalled = true;
    console.log("[KULMS+ TA] submission list detected, decorating statuses...");
    installSubmissionListObserver();
  }

  function setupAll() {
    if (!/\/portal\/site\/[^/]+\/tool\/[^/]+/.test(location.pathname)) return;

    // grader-submitter-select / submissionList の出現を待つ + lit-html 再描画への追従
    bootGrader();
    bootSubmissionList();
    var observer = new MutationObserver(function () {
      if (!booted) bootGrader();
      if (!listIconsInstalled) bootSubmissionList();
      if (booted || listIconsInstalled) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(function () {
      if (!booted && !listIconsInstalled) observer.disconnect();
    }, 30000);
  }

  // 設定ロード後に起動。設定キーは持たない（学生ロールでは Sakai 側でガードされる）
  if (window.__kulmsSettingsReady && typeof window.__kulmsSettingsReady.then === "function") {
    window.__kulmsSettingsReady.then(setupAll);
  } else {
    setupAll();
  }
})();
