// === 全科目課題一覧機能 ===

(function () {
  "use strict";

  const CACHE_KEY = "kulms-assignments";
  const CONCURRENT_LIMIT = 4;
  const BASE_URL = window.location.origin;
  const CHECKED_KEY = "kulms-checked-assignments";
  const MEMO_KEY = "kulms-memos";
  const PREV_ASSIGNMENTS_KEY = "kulms-prev-assignment-ids";
  const DISMISSED_KEY = "kulms-dismissed-assignments";

  // --- State ---
  var textbooksEnabled = true;
  let checkedState = {};
  var sectionCollapsedState = {};
  var settingsCollapsedState = {};
  let dismissedState = {};
  let memos = [];
  let lastAssignments = [];

  // --- Sakai Direct API ヘルパー ---

  async function sakaiGet(path) {
    const res = await fetch(BASE_URL + path, { credentials: "include" });
    if (!res.ok) {
      throw new Error(`API ${path} returned ${res.status}`);
    }
    return res.json();
  }

  // --- コース（サイト）一覧取得 ---

  // Tier 1: 現ページDOMからサイトリンク抽出
  function extractCoursesFromDOM() {
    const courses = [];
    document.querySelectorAll('a[href*="/portal/site/"]').forEach((a) => {
      const match = a.href.match(/\/portal\/site\/([^\/?#]+)/);
      if (!match || match[1].startsWith("~")) return;
      // ツール/ページリンクを除外（科目名ではなくツール名が入るため）
      var rest = a.href.substring(a.href.indexOf(match[1]) + match[1].length);
      if (/^\/(tool|page|tool-reset|page-reset)/.test(rest)) return;
      courses.push({
        id: match[1],
        name: a.textContent.trim(),
        url: a.href,
      });
    });
    return deduplicateCourses(courses);
  }

  // Tier 2: Sakai Direct API
  async function fetchCoursesFromAPI() {
    const data = await sakaiGet("/direct/site.json?_limit=200");
    const sites = data.site_collection || [];
    return sites
      .filter((s) => s.type === "course" || s.type === "project")
      .map((s) => ({
        id: s.id,
        name: s.title,
        url: BASE_URL + "/portal/site/" + s.id,
      }));
  }

  // Tier 3: ポータルページHTMLフェッチ
  async function fetchCoursesFromPortal() {
    const res = await fetch(BASE_URL + "/portal", { credentials: "include" });
    if (!res.ok) throw new Error("Portal fetch failed: " + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const courses = [];
    doc.querySelectorAll('a[href*="/portal/site/"]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const match = href.match(/\/portal\/site\/([^\/?#]+)/);
      if (!match || match[1].startsWith("~")) return;
      var rest = href.substring(href.indexOf(match[1]) + match[1].length);
      if (/^\/(tool|page|tool-reset|page-reset)/.test(rest)) return;
      const fullUrl = href.startsWith("http") ? href : BASE_URL + href;
      courses.push({
        id: match[1],
        name: a.textContent.trim(),
        url: fullUrl,
      });
    });
    return deduplicateCourses(courses);
  }

  function deduplicateCourses(courses) {
    const seen = new Set();
    return courses.filter((c) => {
      if (!c.name || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }

  async function getCourses() {
    // Tier 1: DOM
    let courses = extractCoursesFromDOM();
    if (courses.length > 0) {
      console.log("[KULMS] courses from DOM:", courses.length);
      return courses;
    }

    // Tier 2: Sakai Direct API
    try {
      courses = await fetchCoursesFromAPI();
      if (courses.length > 0) {
        console.log("[KULMS] courses from API:", courses.length);
        return courses;
      }
    } catch (e) {
      console.warn("[KULMS] Sakai API failed:", e.message);
    }

    // Tier 3: ポータルHTML
    try {
      courses = await fetchCoursesFromPortal();
      if (courses.length > 0) {
        console.log("[KULMS] courses from portal HTML:", courses.length);
        return courses;
      }
    } catch (e) {
      console.warn("[KULMS] Portal fetch failed:", e.message);
    }

    throw new Error(t("noCourses"));
  }

  // --- 日付・緊急度 (CPandA準拠) ---

  function getUrgencyClass(deadline) {
    if (!deadline) return "urgency-other";
    var s = window.__kulmsSettings || {};
    var diff = deadline - Date.now();
    if (diff < 0) return "urgency-overdue";
    if (diff < (s.dangerHours || 24) * 3600000) return "urgency-danger";
    if (diff < (s.warningDays || 5) * 86400000) return "urgency-warning";
    if (diff < (s.successDays || 14) * 86400000) return "urgency-success";
    return "urgency-other";
  }

  function formatDeadline(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatRemaining(deadline) {
    if (!deadline) return "";
    var diff = deadline - Date.now();
    if (diff < 0) return t("expired");
    var days = Math.floor(diff / (24 * 60 * 60 * 1000));
    var hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    var mins = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
    if (days > 0) return t("remainDaysHoursMins", [String(days), String(hours), String(mins)]);
    if (hours > 0) return t("remainHoursMins", [String(hours), String(mins)]);
    return t("remainMins", [String(mins)]);
  }

  // --- 課題データ取得 (Sakai Direct API) ---

  function extractTimestamp(val) {
    if (!val) return null;
    if (typeof val === "number") return val;
    if (typeof val === "object") {
      if (val.epochSecond) return val.epochSecond * 1000;
      if (val.time) return val.time;
    }
    if (typeof val === "string") {
      const n = Number(val);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  // 各コースの「課題」ツールURLを取得
  // 1. サイドバーDOMから抽出（展開中の科目のみ）
  // 2. Sakai APIから取得（DOM未展開の科目をカバー）
  function buildAssignmentToolMapFromDOM() {
    var map = {};
    document.querySelectorAll(".nav-item a").forEach(function (a) {
      if (!a.textContent.trim().match(/^課題/)) return;
      var match = a.href.match(/\/portal\/site\/([^\/?#]+)\/tool\//);
      if (match) map[match[1]] = a.href;
    });
    return map;
  }

  async function fetchAssignmentToolUrl(siteId) {
    try {
      var data = await sakaiGet("/direct/site/" + siteId + "/pages.json");
      var pages = Array.isArray(data) ? data : [];
      for (var i = 0; i < pages.length; i++) {
        var tools = pages[i].tools || [];
        for (var j = 0; j < tools.length; j++) {
          if (tools[j].toolId === "sakai.assignment.grades") {
            return BASE_URL + "/portal/site/" + siteId + "/tool/" + tools[j].id;
          }
        }
      }
    } catch (e) {
      // API失敗時はnull
    }
    return null;
  }

  async function fetchAssignmentsForCourse(course, toolMap) {
    try {
      const data = await sakaiGet(
        "/direct/assignment/site/" + course.id + ".json"
      );
      const list = data.assignment_collection || [];

      // コースの課題ツールURL（ポータル内遷移）
      var courseAssignUrl = toolMap[course.id];
      if (!courseAssignUrl) {
        courseAssignUrl = await fetchAssignmentToolUrl(course.id)
          || BASE_URL + "/portal/site/" + course.id;
      }

      // 個別APIで正確な提出状態を取得（一覧APIは提出状態が不正確）
      var itemResults = await Promise.allSettled(
        list.map(function (a) {
          return sakaiGet("/direct/assignment/item/" + (a.entityId || a.id) + ".json");
        })
      );

      return list.map(function (a, idx) {
        const deadline =
          extractTimestamp(a.dueTime) ||
          extractTimestamp(a.dueDate) ||
          extractTimestamp(a.closeTime);

        // 個別APIのレスポンスから正確な提出状態を取得
        var itemData = itemResults[idx].status === "fulfilled" ? itemResults[idx].value : null;
        var sub = itemData && itemData.submissions && itemData.submissions[0];
        // フォールバック: 個別APIが失敗した場合は一覧APIのデータを使用
        if (!sub) sub = a.submissions && a.submissions[0];

        let status = "";
        let grade = "";
        if (sub) {
          if (sub.graded) {
            status = "評定済";
            grade = sub.grade || "";
          } else if (sub.userSubmission && !sub.draft) {
            status = "提出済";
          } else if (sub.status && sub.status !== "未開始") {
            status = sub.status;
          }
        }

        return {
          courseName: course.name,
          courseId: course.id,
          name: a.title || "",
          url: courseAssignUrl,
          deadline: deadline,
          closeTime: extractTimestamp(a.closeTime) || deadline,
          deadlineText: deadline ? formatDeadline(deadline) : "",
          status: status,
          grade: grade || a.gradeDisplay || a.grade || "",
          entityId: a.entityId || a.id || "",
          type: "assignment",
          allowResubmission: !!(a.allowResubmission || (itemData && itemData.allowResubmission)),
        };
      });
    } catch (e) {
      console.warn(
        "[KULMS] assignment fetch failed for",
        course.name,
        e.message
      );
      return [];
    }
  }

  // クイズ/テストツールURLを取得
  function buildQuizToolMapFromDOM() {
    var map = {};
    document.querySelectorAll(".nav-item a").forEach(function (a) {
      if (!a.textContent.trim().match(/^(テスト|小テスト|Tests & Quizzes)/)) return;
      var match = a.href.match(/\/portal\/site\/([^\/?#]+)\/tool\//);
      if (match) map[match[1]] = a.href;
    });
    return map;
  }

  async function fetchQuizzesForCourse(course, toolMap) {
    try {
      var data = await sakaiGet("/direct/sam_pub/context/" + course.id + ".json");
      var list = data.sam_pub_collection || [];
      var quizUrl = toolMap[course.id] || BASE_URL + "/portal/site/" + course.id;
      return list.map(function (q) {
        var deadline = extractTimestamp(q.dueDate);
        var closeTime = extractTimestamp(q.retractDate) || deadline;
        return {
          courseName: course.name,
          courseId: course.id,
          name: q.title || "",
          url: quizUrl,
          deadline: deadline,
          closeTime: closeTime,
          deadlineText: deadline ? formatDeadline(deadline) : "",
          status: q.submitted ? "提出済" : "",
          grade: "",
          entityId: q.publishedAssessmentId ? String(q.publishedAssessmentId) : "",
          type: "quiz",
        };
      });
    } catch (e) {
      return [];
    }
  }

  async function fetchAllAssignments(onProgress) {
    const courses = await getCourses();
    if (courses.length === 0) {
      throw new Error(t("noCourses"));
    }

    // サイドバーから課題/クイズツールURLを取得（この時点では描画済み）
    var toolMap = buildAssignmentToolMapFromDOM();
    var quizToolMap = buildQuizToolMapFromDOM();

    const allAssignments = [];
    let completed = 0;

    for (let i = 0; i < courses.length; i += CONCURRENT_LIMIT) {
      const batch = courses.slice(i, i + CONCURRENT_LIMIT);
      const results = await Promise.allSettled(
        batch.flatMap(function (c) {
          return [
            fetchAssignmentsForCourse(c, toolMap),
            fetchQuizzesForCourse(c, quizToolMap)
          ];
        })
      );
      results.forEach((r) => {
        if (r.status === "fulfilled") {
          allAssignments.push(...r.value);
        }
      });
      completed += batch.length;
      if (onProgress) {
        onProgress(completed, courses.length);
      }
    }

    return allAssignments;
  }

  // --- 提出状態の判定 ---

  function isSubmitted(status) {
    const s = status.toLowerCase();
    return (
      s.includes("提出済") ||
      s.includes("submitted") ||
      s.includes("評定済") ||
      s.includes("graded")
    );
  }

  function isGraded(status) {
    const s = status.toLowerCase();
    return s.includes("評定済") || s.includes("graded");
  }

  function getStatusBadgeClass(status) {
    if (isGraded(status)) return "graded";
    if (isSubmitted(status)) return "submitted";
    return "not-submitted";
  }

  function getStatusLabel(status) {
    if (!status) return t("statusNotSubmitted");
    if (isGraded(status)) return t("statusGraded");
    if (isSubmitted(status)) return t("statusSubmitted");
    return status;
  }

  // --- キャッシュ ---

  function getFetchIntervalMs() {
    var s = window.__kulmsSettings || {};
    var sec = typeof s.fetchInterval === "number" ? s.fetchInterval : 120;
    return sec * 1000;
  }

  async function loadCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(CACHE_KEY, (result) => {
        const cached = result[CACHE_KEY];
        if (
          cached &&
          cached.timestamp &&
          Date.now() - cached.timestamp < getFetchIntervalMs()
        ) {
          resolve(cached);
        } else {
          resolve(null);
        }
      });
    });
  }

  function saveCache(assignments) {
    chrome.storage.local.set({
      [CACHE_KEY]: { timestamp: Date.now(), assignments: assignments },
    });
  }

  // --- 完了チェック状態 ---

  async function loadCheckedState() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(CHECKED_KEY, function (result) {
        checkedState = result[CHECKED_KEY] || {};
        resolve();
      });
    });
  }

  function saveCheckedState() {
    chrome.storage.local.set({ [CHECKED_KEY]: checkedState });
  }

  function getCheckedKey(assignment) {
    if (assignment.entityId) return assignment.entityId;
    return assignment.courseId + ":" + assignment.name;
  }

  function isAssignmentChecked(assignment) {
    var key = getCheckedKey(assignment);
    var val = checkedState[key];
    if (val && val !== "active") return true;
    // Fallback: check legacy key (courseId:name) if entityId is primary key
    if (assignment.entityId) {
      var legacyKey = assignment.courseId + ":" + assignment.name;
      var legacyVal = checkedState[legacyKey];
      if (legacyVal && legacyVal !== "active") return true;
    }
    return false;
  }

  function isExplicitlyActive(assignment) {
    var key = getCheckedKey(assignment);
    return checkedState[key] === "active";
  }

  function migrateCheckedKeys(assignments) {
    var changed = false;
    assignments.forEach(function (a) {
      if (!a.entityId) return;
      var legacyKey = a.courseId + ":" + a.name;
      if (checkedState[legacyKey] && !checkedState[a.entityId]) {
        checkedState[a.entityId] = checkedState[legacyKey];
        delete checkedState[legacyKey];
        changed = true;
      }
    });
    if (changed) saveCheckedState();
  }

  function toggleChecked(assignment) {
    var key = getCheckedKey(assignment);
    // Also clean up legacy key if migrating
    if (assignment.entityId) {
      var legacyKey = assignment.courseId + ":" + assignment.name;
      if (checkedState[legacyKey]) {
        delete checkedState[legacyKey];
      }
    }

    if (isSubmitted(assignment.status) && assignment.allowResubmission) {
      // 再提出可能 + 提出済み: "active" をトグル
      if (checkedState[key] === "active") {
        delete checkedState[key]; // → 完了済みに戻る
      } else {
        checkedState[key] = "active"; // → アクティブに戻す
      }
    } else {
      // 既存動作
      if (checkedState[key]) {
        delete checkedState[key];
      } else {
        checkedState[key] = Date.now();
      }
    }
    saveCheckedState();
  }

  // --- 削除済み（dismiss）状態 ---
  var DISMISS_EXPIRY_DAYS = 30;

  async function loadDismissedState() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(DISMISSED_KEY, function (result) {
        dismissedState = result[DISMISSED_KEY] || {};
        purgeExpiredDismissed();
        resolve();
      });
    });
  }

  function saveDismissedState() {
    chrome.storage.local.set({ [DISMISSED_KEY]: dismissedState });
  }

  function purgeExpiredDismissed() {
    var now = Date.now();
    var expiry = DISMISS_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    var changed = false;
    Object.keys(dismissedState).forEach(function (key) {
      var entry = dismissedState[key];
      var ts = typeof entry === "number" ? entry : (entry && entry.dismissedAt) || 0;
      if (now - ts > expiry) {
        // メモも完全削除
        if (entry && entry.type === "memo" && entry._memoId) {
          memos = memos.filter(function (m) {
            return normalizeMemo(m).id !== entry._memoId;
          });
        }
        delete dismissedState[key];
        changed = true;
      }
    });
    if (changed) {
      saveDismissedState();
      saveMemos();
    }
  }

  function isAssignmentDismissed(assignment) {
    var key = getCheckedKey(assignment);
    return !!dismissedState[key];
  }

  function dismissAssignment(assignment) {
    var key = getCheckedKey(assignment);
    dismissedState[key] = {
      dismissedAt: Date.now(),
      name: assignment.name || "",
      courseName: assignment.courseName || "",
      courseId: assignment.courseId || "",
      deadline: assignment.deadline || null,
      url: assignment.url || "",
      type: assignment.type || "assignment",
      entityId: assignment.entityId || "",
      _memoId: assignment._memoId || null
    };
    saveDismissedState();
  }

  function restoreAssignment(key) {
    delete dismissedState[key];
    saveDismissedState();
  }

  // --- メモ ---

  async function loadMemos() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(MEMO_KEY, function (result) {
        memos = result[MEMO_KEY] || [];
        resolve();
      });
    });
  }

  function saveMemos() {
    chrome.storage.local.set({ [MEMO_KEY]: memos });
  }

  // --- UI ---

  let panelEl = null;
  let contentEl = null;
  let cacheInfoEl = null;

  function createFloatingButton() {
    var btn = document.createElement("button");
    btn.id = "kulms-assign-toggle";
    btn.title = "KULMS Extension";
    btn.addEventListener("click", togglePanel);
    btn.className = "kulms-hamburger-btn";
    btn.textContent = "\u2630"; // ☰

    var indicators = document.getElementById("sakai-system-indicators");
    if (indicators) {
      indicators.appendChild(btn);
    }
  }

  function createPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "kulms-assign-panel";

    // ヘッダー (ロゴ + ×ボタン)
    var header = document.createElement("div");
    header.className = "kulms-assign-header";

    var logo = document.createElement("span");
    logo.className = "kulms-assign-logo";
    logo.textContent = t("panelTitle");

    var headerRight = document.createElement("div");
    headerRight.className = "kulms-assign-header-right";

    var refreshBtn = document.createElement("button");
    refreshBtn.className = "kulms-assign-header-btn";
    refreshBtn.textContent = "\uD83D\uDD04"; // 🔄
    refreshBtn.title = t("refresh");
    refreshBtn.addEventListener("click", function () {
      if (currentView === "assignments") loadAssignments(true);
      else if (currentView === "textbooks" && window.__kulmsTextbookAPI) {
        window.__kulmsTextbookAPI.loadInto(contentEl, true);
      }
    });

    var closeBtn = document.createElement("button");
    closeBtn.className = "kulms-assign-close";
    closeBtn.textContent = "\u00D7"; // ×
    closeBtn.title = t("close");
    closeBtn.addEventListener("click", closePanel);

    headerRight.appendChild(refreshBtn);
    headerRight.appendChild(closeBtn);
    header.appendChild(logo);
    header.appendChild(headerRight);

    // タブバー (課題 / 教科書 / 設定)
    var tabBar = document.createElement("div");
    tabBar.className = "kulms-panel-tab-bar";

    var tabs = [];

    var tabAssign = document.createElement("label");
    tabAssign.className = "kulms-panel-tab";
    var radioAssign = document.createElement("input");
    radioAssign.type = "radio";
    radioAssign.name = "kulms-tab";
    radioAssign.value = "assignments";
    radioAssign.checked = true;
    tabAssign.appendChild(radioAssign);
    tabAssign.appendChild(document.createTextNode(t("tabAssignments")));
    tabs.push(tabAssign);

    var tabTextbook = document.createElement("label");
    tabTextbook.className = "kulms-panel-tab";
    var radioTextbook = document.createElement("input");
    radioTextbook.type = "radio";
    radioTextbook.name = "kulms-tab";
    radioTextbook.value = "textbooks";
    tabTextbook.appendChild(radioTextbook);
    tabTextbook.appendChild(document.createTextNode(t("tabTextbooks")));
    tabs.push(tabTextbook);

    var tabSettings = document.createElement("label");
    tabSettings.className = "kulms-panel-tab";
    var radioSettings = document.createElement("input");
    radioSettings.type = "radio";
    radioSettings.name = "kulms-tab";
    radioSettings.value = "settings";
    tabSettings.appendChild(radioSettings);
    tabSettings.appendChild(document.createTextNode(t("tabSettings")));
    tabs.push(tabSettings);

    function setActiveTab(activeTab) {
      tabs.forEach(function (t) { t.classList.remove("active"); });
      activeTab.classList.add("active");
    }

    tabBar.appendChild(tabAssign);
    if (textbooksEnabled) {
      tabBar.appendChild(tabTextbook);
    }
    tabBar.appendChild(tabSettings);

    tabAssign.classList.add("active");

    tabAssign.addEventListener("click", function () {
      setActiveTab(tabAssign);
      showAssignmentsView();
    });
    tabTextbook.addEventListener("click", function () {
      setActiveTab(tabTextbook);
      showTextbooksView();
    });
    tabSettings.addEventListener("click", function () {
      setActiveTab(tabSettings);
      showSettingsView();
    });

    // キャッシュ情報
    cacheInfoEl = document.createElement("div");
    cacheInfoEl.className = "kulms-assign-cache-info";
    cacheInfoEl.textContent = "";

    // コンテンツ
    contentEl = document.createElement("div");
    contentEl.className = "kulms-assign-content";

    panelEl.appendChild(header);
    panelEl.appendChild(tabBar);
    panelEl.appendChild(cacheInfoEl);
    panelEl.appendChild(contentEl);
    document.body.appendChild(panelEl);
  }

  function togglePanel() {
    if (!panelEl) return;
    var isOpen = panelEl.classList.contains("open");
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function isPushMode() {
    var s = window.__kulmsSettings || {};
    return s.panelPush === true;
  }

  function openPanel() {
    if (!panelEl) return;
    panelEl.classList.add("open");

    if (isPushMode()) {
      document.body.style.marginRight = "300px";
    } else {
      // オーバーレイモード: クリック外閉じ用
      var cover = document.getElementById("kulms-cover");
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "kulms-cover";
        cover.addEventListener("click", closePanel);
        document.body.appendChild(cover);
      }
      cover.classList.add("visible");
    }

    sessionStorage.setItem("kulms-panel-open", "1");
    if (currentView === "assignments") {
      loadAssignments(false);
    } else if (currentView === "textbooks" && window.__kulmsTextbookAPI) {
      window.__kulmsTextbookAPI.loadInto(contentEl, false);
    }
  }

  function closePanel() {
    if (!panelEl) return;
    panelEl.classList.remove("open");
    document.body.style.marginRight = "";
    var cover = document.getElementById("kulms-cover");
    if (cover) cover.classList.remove("visible");
    sessionStorage.removeItem("kulms-panel-open");
  }

  function updateCacheInfo(timestamp) {
    if (!cacheInfoEl || !timestamp || currentView !== "assignments") {
      if (cacheInfoEl) cacheInfoEl.textContent = "";
      return;
    }
    const ago = Math.floor((Date.now() - timestamp) / 60000);
    cacheInfoEl.textContent =
      ago < 1 ? t("lastUpdatedNow") : t("lastUpdatedMins", [String(ago)]);
  }

  function showLoading(progress, total) {
    if (!contentEl || currentView !== "assignments") return;
    const text =
      progress != null && total != null
        ? t("loadingAssignments", [String(progress), String(total)])
        : t("loadingCourses");
    contentEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "kulms-assign-loading";
    loading.innerHTML = `<div class="kulms-assign-spinner"></div><div class="kulms-assign-loading-text">${text}</div>`;
    contentEl.appendChild(loading);
  }

  function showError(msg) {
    if (!contentEl || currentView !== "assignments") return;
    contentEl.innerHTML = "";
    const errorDiv = document.createElement("div");
    errorDiv.className = "kulms-assign-error";

    const msgEl = document.createElement("div");
    msgEl.className = "kulms-assign-error-msg";
    msgEl.textContent = msg;

    const retryBtn = document.createElement("button");
    retryBtn.className = "kulms-assign-retry-btn";
    retryBtn.textContent = t("retry");
    retryBtn.addEventListener("click", () => loadAssignments(true));

    errorDiv.appendChild(msgEl);
    errorDiv.appendChild(retryBtn);
    contentEl.appendChild(errorDiv);
  }

  function renderAssignments(assignments) {
    if (!contentEl || currentView !== "assignments") return;
    contentEl.innerHTML = "";
    lastAssignments = assignments;
    migrateCheckedKeys(assignments);

    if (assignments.length === 0 && (!memos || memos.length === 0)) {
      var empty = document.createElement("div");
      empty.className = "kulms-assign-empty";
      empty.textContent = t("noAssignments");
      contentEl.appendChild(empty);
      appendMemoButton();
      return;
    }

    var now = Date.now();
    var autoCompleteEnabled = (window.__kulmsSettings || {}).autoComplete !== false;

    // 非表示（dismiss）された課題を除外
    var notDismissed = assignments.filter(function (a) {
      return !isAssignmentDismissed(a);
    });

    // 期限切れ + 完了済みの課題を除外（再提出アクティブは除外しない）
    var visible = notDismissed.filter(function (a) {
      if (isExplicitlyActive(a)) return true;
      var isCompleted = isAssignmentChecked(a) || (autoCompleteEnabled && isSubmitted(a.status));
      var isClosed = a.closeTime && a.closeTime < now;
      return !(isCompleted && isClosed);
    });

    // 振り分け: completed (checked or submitted) / active
    var completed = [];
    var active = [];

    visible.forEach(function (a) {
      if (isExplicitlyActive(a)) {
        active.push(a);
      } else if (isAssignmentChecked(a) || (autoCompleteEnabled && isSubmitted(a.status))) {
        completed.push(a);
      } else {
        active.push(a);
      }
    });

    // active を期限順ソート
    active.sort(function (a, b) {
      if (a.deadline && b.deadline) return a.deadline - b.deadline;
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    });

    // 緊急度別グループ
    var overdue = active.filter(function (a) {
      return getUrgencyClass(a.deadline) === "urgency-overdue";
    });
    var danger = active.filter(function (a) {
      return getUrgencyClass(a.deadline) === "urgency-danger";
    });
    var warning = active.filter(function (a) {
      return getUrgencyClass(a.deadline) === "urgency-warning";
    });
    var success = active.filter(function (a) {
      return getUrgencyClass(a.deadline) === "urgency-success";
    });
    var other = active.filter(function (a) {
      return getUrgencyClass(a.deadline) === "urgency-other";
    });

    var s = window.__kulmsSettings || {};
    var dangerLabel = t("sectionDanger", [String(s.dangerHours || 24)]);
    var warningLabel = t("sectionWarning", [String(s.warningDays || 5)]);
    var successLabel = t("sectionSuccess", [String(s.successDays || 14)]);

    // Integrate deadline memos into urgency groups
    if (window.__kulmsSettings && window.__kulmsSettings.memos !== false) {
      memos.forEach(function (m) {
        var memo = normalizeMemo(m);
        if (!memo.deadline) return;
        var memoItem = {
          courseName: memo.courseName || "",
          courseId: memo.courseId || "",
          name: memo.text,
          url: "",
          deadline: memo.deadline,
          closeTime: memo.deadline,
          deadlineText: formatDeadline(memo.deadline),
          status: "",
          grade: "",
          entityId: "memo-" + memo.id,
          type: "memo",
          _memoId: memo.id,
        };
        // Dismissed memos are hidden
        if (isAssignmentDismissed(memoItem)) return;
        // Checked memos go to completed section
        if (isAssignmentChecked(memoItem)) {
          completed.push(memoItem);
          return;
        }
        var u = getUrgencyClass(memo.deadline);
        if (u === "urgency-overdue") overdue.push(memoItem);
        else if (u === "urgency-danger") danger.push(memoItem);
        else if (u === "urgency-warning") warning.push(memoItem);
        else if (u === "urgency-success") success.push(memoItem);
        else other.push(memoItem);
      });
      // Re-sort after adding memo items
      [overdue, danger, warning, success, other].forEach(function (arr) {
        arr.sort(function (a, b) {
          if (a.deadline && b.deadline) return a.deadline - b.deadline;
          if (a.deadline) return -1;
          if (b.deadline) return 1;
          return 0;
        });
      });
    }

    if (overdue.length > 0) {
      contentEl.appendChild(createSection(t("sectionOverdue"), overdue, "overdue", false));
    }
    if (danger.length > 0) {
      contentEl.appendChild(createSection(dangerLabel, danger, "danger", false));
    }
    if (warning.length > 0) {
      contentEl.appendChild(createSection(warningLabel, warning, "warning", false));
    }
    if (success.length > 0) {
      contentEl.appendChild(createSection(successLabel, success, "success", false));
    }
    if (other.length > 0) {
      contentEl.appendChild(createSection(t("sectionOther"), other, "other", false));
    }
    if (completed.length > 0) {
      completed.sort(function (a, b) {
        if (a.deadline && b.deadline) return b.deadline - a.deadline;
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });
      contentEl.appendChild(createSection(t("sectionCompleted"), completed, "checked", true));
    }

    // 削除済みセクション
    renderDeletedSection();

    // Plain memos (no deadline)
    renderMemos();
    // メモ追加ボタン
    appendMemoButton();
  }

  function renderDeletedSection() {
    var keys = Object.keys(dismissedState);
    if (keys.length === 0) return;

    var items = [];
    keys.forEach(function (key) {
      var entry = dismissedState[key];
      if (!entry || typeof entry !== "object") return;
      items.push({ key: key, data: entry });
    });
    if (items.length === 0) return;

    // 削除日時の新しい順
    items.sort(function (a, b) {
      return (b.data.dismissedAt || 0) - (a.data.dismissedAt || 0);
    });

    var deletedCollapsed = "deleted" in sectionCollapsedState
      ? sectionCollapsedState["deleted"]
      : true;

    var section = document.createElement("div");
    section.className = "kulms-assign-section";

    var header = document.createElement("div");
    header.className = "kulms-assign-section-header kulms-section-deleted";

    var toggle = document.createElement("span");
    toggle.className = "kulms-assign-section-toggle" + (deletedCollapsed ? " collapsed" : "");
    toggle.textContent = "\u25BC";

    var titleSpan = document.createElement("span");
    titleSpan.textContent = t("sectionDeleted");

    var count = document.createElement("span");
    count.className = "kulms-assign-section-count";
    count.textContent = "(" + items.length + ")";

    header.appendChild(toggle);
    header.appendChild(titleSpan);
    header.appendChild(count);

    var itemsContainer = document.createElement("div");
    itemsContainer.className = "kulms-assign-section-items" + (deletedCollapsed ? " collapsed" : "");

    // 自動削除の注意書き
    var notice = document.createElement("div");
    notice.className = "kulms-deleted-notice";
    notice.textContent = t("autoDeleteNotice");
    itemsContainer.appendChild(notice);

    items.forEach(function (item) {
      itemsContainer.appendChild(createDeletedCard(item.key, item.data));
    });

    header.addEventListener("click", function () {
      toggle.classList.toggle("collapsed");
      itemsContainer.classList.toggle("collapsed");
      sectionCollapsedState["deleted"] = toggle.classList.contains("collapsed");
    });

    section.appendChild(header);
    section.appendChild(itemsContainer);
    contentEl.appendChild(section);
  }

  function createDeletedCard(key, data) {
    var card = document.createElement("div");
    card.className = "kulms-assign-card kulms-deleted-card";

    var body = document.createElement("div");
    body.className = "kulms-assign-card-body";

    // コース名
    if (data.courseName) {
      var pill = document.createElement("span");
      pill.className = "kulms-course-pill kulms-pill-deleted";
      pill.textContent = data.courseName;
      body.appendChild(pill);
    }

    // タイプバッジ
    if (data.type === "quiz") {
      var qBadge = document.createElement("span");
      qBadge.className = "kulms-assign-badge kulms-badge-quiz";
      qBadge.textContent = t("badgeQuiz");
      body.appendChild(qBadge);
    } else if (data.type === "memo") {
      var mBadge = document.createElement("span");
      mBadge.className = "kulms-badge-memo";
      mBadge.textContent = t("memoLabel");
      body.appendChild(mBadge);
    }

    // 名前
    var nameDiv = document.createElement("div");
    nameDiv.className = "kulms-assign-card-name";
    nameDiv.textContent = data.name || key;
    body.appendChild(nameDiv);

    // 削除日時
    var meta = document.createElement("div");
    meta.className = "kulms-assign-card-meta";
    var daysAgo = Math.floor((Date.now() - (data.dismissedAt || 0)) / 86400000);
    var deletedLabel = daysAgo < 1 ? t("deletedToday") : t("deletedDaysAgo", [String(daysAgo)]);
    var deletedSpan = document.createElement("span");
    deletedSpan.textContent = deletedLabel;
    meta.appendChild(deletedSpan);
    body.appendChild(meta);

    // 元に戻すボタン
    var restoreBtn = document.createElement("button");
    restoreBtn.className = "kulms-deleted-restore";
    restoreBtn.textContent = t("restoreItem");
    restoreBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      restoreAssignment(key);
      renderAssignments(lastAssignments);
    });

    card.appendChild(body);
    card.appendChild(restoreBtn);
    return card;
  }

  function createSection(label, items, type, defaultCollapsed) {
    // 保存済みの開閉状態があればそちらを優先
    var collapsed = type in sectionCollapsedState
      ? sectionCollapsedState[type]
      : defaultCollapsed;

    var section = document.createElement("div");
    section.className = "kulms-assign-section";

    var header = document.createElement("div");
    header.className = "kulms-assign-section-header kulms-section-" + type;

    var toggle = document.createElement("span");
    toggle.className =
      "kulms-assign-section-toggle" + (collapsed ? " collapsed" : "");
    toggle.textContent = "\u25BC";

    var titleSpan = document.createElement("span");
    titleSpan.textContent = label;

    var count = document.createElement("span");
    count.className = "kulms-assign-section-count";
    count.textContent = "(" + items.length + ")";

    header.appendChild(toggle);
    header.appendChild(titleSpan);
    header.appendChild(count);

    var itemsContainer = document.createElement("div");
    itemsContainer.className =
      "kulms-assign-section-items" + (collapsed ? " collapsed" : "");

    items.forEach(function (a) {
      itemsContainer.appendChild(createCard(a));
    });

    header.addEventListener("click", function () {
      toggle.classList.toggle("collapsed");
      itemsContainer.classList.toggle("collapsed");
      sectionCollapsedState[type] = toggle.classList.contains("collapsed");
    });

    section.appendChild(header);
    section.appendChild(itemsContainer);
    return section;
  }

  function createCard(assignment) {
    var urgency = getUrgencyClass(assignment.deadline);
    var checked = isAssignmentChecked(assignment);
    var submitted = isSubmitted(assignment.status);
    var isResubmitActive = isExplicitlyActive(assignment);
    var isCompleted = !isResubmitActive && (checked || submitted);

    var card = document.createElement("div");
    card.className = "kulms-assign-card " + urgency;
    if (isCompleted) card.classList.add("kulms-checked");

    // チェックボックス
    var checkbox = document.createElement("div");
    checkbox.className = "kulms-checkbox" + (isCompleted ? " checked" : "");
    if (submitted && !assignment.allowResubmission && !checked) {
      // 再提出不可の提出済み → クリック無効
      checkbox.style.pointerEvents = "none";
      checkbox.style.opacity = "0.5";
    } else {
      checkbox.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleChecked(assignment);
        renderAssignments(lastAssignments);
      });
    }

    // カード本体
    var body = document.createElement("div");
    body.className = "kulms-assign-card-body";

    // コース名ピルバッジ
    var pill = document.createElement("span");
    pill.className = "kulms-course-pill " + urgency;
    pill.textContent = assignment.courseName;

    // 課題タイトル
    var nameDiv = document.createElement("div");
    nameDiv.className = "kulms-assign-card-name";
    if (assignment.url) {
      var a = document.createElement("a");
      a.href = assignment.url;
      a.textContent = assignment.name;
      nameDiv.appendChild(a);
    } else {
      nameDiv.textContent = assignment.name;
    }

    // メタ情報
    var meta = document.createElement("div");
    meta.className = "kulms-assign-card-meta";

    var deadlineSpan = document.createElement("span");
    deadlineSpan.textContent = formatDeadline(assignment.deadline);
    meta.appendChild(deadlineSpan);

    // 残り時間
    var remaining = formatRemaining(assignment.deadline);
    if (remaining) {
      var remainEl = document.createElement("span");
      remainEl.className = "kulms-time-remain";
      if (remaining === t("expired")) remainEl.classList.add("overdue");
      remainEl.textContent = remaining;
      meta.appendChild(remainEl);
    }

    var badgeRow = document.createElement("div");
    badgeRow.className = "kulms-badge-row";
    badgeRow.appendChild(pill);
    if (assignment.type === "quiz") {
      var typeBadge = document.createElement("span");
      typeBadge.className = "kulms-assign-badge kulms-badge-quiz";
      typeBadge.textContent = t("badgeQuiz");
      badgeRow.appendChild(typeBadge);
    } else if (assignment.type === "memo") {
      var memoBadge = document.createElement("span");
      memoBadge.className = "kulms-badge-memo";
      memoBadge.textContent = t("memoLabel");
      badgeRow.appendChild(memoBadge);
    }
    if (isResubmitActive) {
      var rBadge = document.createElement("span");
      rBadge.className = "kulms-badge-resubmit";
      rBadge.textContent = t("badgeResubmit");
      badgeRow.appendChild(rBadge);
    }
    body.appendChild(badgeRow);
    body.appendChild(nameDiv);
    body.appendChild(meta);

    // 削除ボタン（確認付き）
    var delBtn = document.createElement("button");
    delBtn.className = "kulms-card-delete";
    delBtn.textContent = "\u00D7";
    delBtn.title = assignment.type === "memo" ? t("memoDelete") : t("dismissAssignment");
    var confirmPending = false;
    delBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!confirmPending) {
        confirmPending = true;
        delBtn.textContent = t("deleteConfirm");
        delBtn.classList.add("kulms-card-delete-confirm");
        // 3秒後に自動リセット
        setTimeout(function () {
          if (confirmPending) {
            confirmPending = false;
            delBtn.textContent = "\u00D7";
            delBtn.classList.remove("kulms-card-delete-confirm");
          }
        }, 3000);
      } else {
        dismissAssignment(assignment);
        renderAssignments(lastAssignments);
      }
    });

    card.appendChild(checkbox);
    card.appendChild(body);
    card.appendChild(delBtn);
    return card;
  }

  // --- メモ UI ---

  // Normalize memo object (backward compat: string-only memos → { text: str })
  function normalizeMemo(memo) {
    if (typeof memo === "string") return { id: Date.now(), text: memo, created: Date.now() };
    return memo;
  }

  function renderMemos() {
    if (window.__kulmsSettings && window.__kulmsSettings.memos === false) return;
    if (!memos || memos.length === 0) return;

    // Separate memos with deadlines (rendered in urgency sections) from plain memos
    var plainMemos = [];
    memos.forEach(function (m) {
      var memo = normalizeMemo(m);
      if (memo.deadline) return;
      // Check if dismissed
      if (dismissedState["memo-" + memo.id]) return;
      plainMemos.push(memo);
    });

    if (plainMemos.length === 0) return;

    var section = document.createElement("div");
    section.className = "kulms-assign-section";

    var header = document.createElement("div");
    header.className = "kulms-assign-section-header kulms-section-memo";

    var memoCollapsed = "memo" in sectionCollapsedState
      ? sectionCollapsedState["memo"]
      : false;

    var toggle = document.createElement("span");
    toggle.className = "kulms-assign-section-toggle" + (memoCollapsed ? " collapsed" : "");
    toggle.textContent = "\u25BC";

    var titleSpan = document.createElement("span");
    titleSpan.textContent = t("sectionMemo");

    var count = document.createElement("span");
    count.className = "kulms-assign-section-count";
    count.textContent = "(" + plainMemos.length + ")";

    header.appendChild(toggle);
    header.appendChild(titleSpan);
    header.appendChild(count);

    var itemsContainer = document.createElement("div");
    itemsContainer.className = "kulms-assign-section-items" + (memoCollapsed ? " collapsed" : "");

    plainMemos.forEach(function (memo) {
      itemsContainer.appendChild(createMemoCard(memo));
    });

    header.addEventListener("click", function () {
      toggle.classList.toggle("collapsed");
      itemsContainer.classList.toggle("collapsed");
      sectionCollapsedState["memo"] = toggle.classList.contains("collapsed");
    });

    section.appendChild(header);
    section.appendChild(itemsContainer);
    contentEl.appendChild(section);
  }

  function createMemoCard(memo) {
    var card = document.createElement("div");
    card.className = "kulms-assign-card kulms-memo-card";

    // Course pill if set
    if (memo.courseId && memo.courseName) {
      var pill = document.createElement("span");
      pill.className = "kulms-course-pill";
      pill.style.background = "#26a69a";
      pill.textContent = memo.courseName;
      card.appendChild(pill);
    }

    var badge = document.createElement("span");
    badge.className = "kulms-badge-memo";
    badge.textContent = t("memoLabel");
    card.appendChild(badge);

    var text = document.createElement("div");
    text.className = "kulms-memo-text";
    text.textContent = memo.text;
    card.appendChild(text);

    // Deadline info if set
    if (memo.deadline) {
      var meta = document.createElement("div");
      meta.className = "kulms-assign-card-meta";
      var deadlineSpan = document.createElement("span");
      deadlineSpan.textContent = formatDeadline(memo.deadline);
      meta.appendChild(deadlineSpan);
      var remaining = formatRemaining(memo.deadline);
      if (remaining) {
        var remainEl = document.createElement("span");
        remainEl.className = "kulms-time-remain";
        if (remaining === t("expired")) remainEl.classList.add("overdue");
        remainEl.textContent = remaining;
        meta.appendChild(remainEl);
      }
      card.appendChild(meta);
    }

    var delBtn = document.createElement("button");
    delBtn.className = "kulms-memo-delete";
    delBtn.textContent = "\u00D7";
    delBtn.title = t("memoDelete");
    var confirmPending = false;
    delBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!confirmPending) {
        confirmPending = true;
        delBtn.textContent = t("deleteConfirm");
        delBtn.classList.add("kulms-card-delete-confirm");
        setTimeout(function () {
          if (confirmPending) {
            confirmPending = false;
            delBtn.textContent = "\u00D7";
            delBtn.classList.remove("kulms-card-delete-confirm");
          }
        }, 3000);
      } else {
        var memoAsItem = {
          name: memo.text,
          courseName: memo.courseName || "",
          courseId: memo.courseId || "",
          deadline: memo.deadline || null,
          url: "",
          entityId: "memo-" + memo.id,
          type: "memo",
          _memoId: memo.id
        };
        dismissAssignment(memoAsItem);
        renderAssignments(lastAssignments);
      }
    });
    card.appendChild(delBtn);

    return card;
  }

  function appendMemoButton() {
    if (window.__kulmsSettings && window.__kulmsSettings.memos === false) return;
    var wrapper = document.createElement("div");
    wrapper.className = "kulms-memo-area";

    // メモ入力フォーム (初期非表示)
    var form = document.createElement("div");
    form.className = "kulms-memo-form";
    form.style.display = "none";

    var textarea = document.createElement("textarea");
    textarea.className = "kulms-memo-input";
    textarea.placeholder = t("memoPlaceholder");
    textarea.rows = 3;

    // コース選択ドロップダウン
    var courseSelect = document.createElement("select");
    courseSelect.className = "kulms-memo-input";
    courseSelect.style.cssText = "margin-top:6px !important;padding:4px 8px !important";
    var defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = t("memoCourseSelect");
    courseSelect.appendChild(defaultOpt);
    // Populate from lastAssignments' unique courses
    var seenCourses = {};
    lastAssignments.forEach(function (a) {
      if (!a.courseId || seenCourses[a.courseId]) return;
      seenCourses[a.courseId] = true;
      var opt = document.createElement("option");
      opt.value = a.courseId;
      opt.textContent = a.courseName;
      opt.dataset.courseName = a.courseName;
      courseSelect.appendChild(opt);
    });

    // 締切日時入力
    var deadlineInput = document.createElement("input");
    deadlineInput.type = "datetime-local";
    deadlineInput.className = "kulms-memo-input";
    deadlineInput.style.cssText = "margin-top:6px !important;padding:4px 8px !important";
    deadlineInput.placeholder = "締切日時（任意）";

    var actions = document.createElement("div");
    actions.className = "kulms-memo-form-actions";

    var saveBtn = document.createElement("button");
    saveBtn.className = "kulms-memo-save";
    saveBtn.textContent = t("memoSave");
    saveBtn.addEventListener("click", function () {
      var text = textarea.value.trim();
      if (!text) return;
      var memo = { id: Date.now(), text: text, created: Date.now() };
      if (courseSelect.value) {
        memo.courseId = courseSelect.value;
        var selectedOpt = courseSelect.options[courseSelect.selectedIndex];
        memo.courseName = selectedOpt.dataset.courseName || selectedOpt.textContent;
      }
      if (deadlineInput.value) {
        memo.deadline = new Date(deadlineInput.value).getTime();
      }
      memos.push(memo);
      saveMemos();
      renderAssignments(lastAssignments);
    });

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "kulms-memo-cancel";
    cancelBtn.textContent = t("memoCancel");
    cancelBtn.addEventListener("click", function () {
      form.style.display = "none";
      addBtn.style.display = "";
      textarea.value = "";
      courseSelect.value = "";
      deadlineInput.value = "";
    });

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(textarea);
    form.appendChild(courseSelect);
    form.appendChild(deadlineInput);
    form.appendChild(actions);

    // ＋ボタン
    var addBtn = document.createElement("button");
    addBtn.className = "kulms-memo-btn";
    addBtn.textContent = "\uFF0B"; // ＋
    addBtn.title = t("memoAdd");
    addBtn.addEventListener("click", function () {
      addBtn.style.display = "none";
      form.style.display = "block";
      textarea.focus();
    });

    wrapper.appendChild(form);
    wrapper.appendChild(addBtn);
    contentEl.appendChild(wrapper);
  }

  // --- 設定ビュー ---

  var FEATURE_GROUPS = [
    { sectionKey: "sectionPanel", features: [
      { key: "textbooks", labelKey: "featTextbooks", descKey: "featTextbooksDesc" },
      { key: "memos", labelKey: "featMemos", descKey: "featMemosDesc" },
      { key: "panelPush", labelKey: "featPanelPush", descKey: "featPanelPushDesc" },
    ]},
    { sectionKey: "sectionSidebar", features: [
      { key: "tabColoring", labelKey: "featTabColoring", descKey: "featTabColoringDesc" },
      { key: "notificationBadge", labelKey: "featNotificationBadge", descKey: "featNotificationBadgeDesc" },
      { key: "courseNameCleanup", labelKey: "featCourseNameCleanup", descKey: "featCourseNameCleanupDesc" },
      { key: "pinSort", labelKey: "featPinSort", descKey: "featPinSortDesc" },
      { key: "courseRowClick", labelKey: "featCourseRowClick", descKey: "featCourseRowClickDesc" },
      { key: "toolVisibility", labelKey: "featToolVisibility", descKey: "featToolVisibilityDesc" },
      { key: "sidebarResize", labelKey: "featSidebarResize", descKey: "featSidebarResizeDesc" },
      { key: "sidebarStyle", labelKey: "featSidebarStyle", descKey: "featSidebarStyleDesc" },
    ]},
    { sectionKey: "sectionCoursePage", features: [
      { key: "folderExpand", labelKey: "featFolderExpand", descKey: "featFolderExpandDesc" },
      { key: "autoExpandAll", labelKey: "featAutoExpandAll", descKey: "featAutoExpandAllDesc" },
      { key: "hideResourceColumns", labelKey: "featHideResourceColumns", descKey: "featHideResourceColumnsDesc" },
    ]},
  ];

  // Flat list for bulk operations
  var ALL_FEATURES = FEATURE_GROUPS.reduce(function (acc, g) {
    return acc.concat(g.features);
  }, []);

  var currentView = "assignments";

  function showSettingsView() {
    if (currentView === "settings") return;
    currentView = "settings";
    if (window.__kulmsTextbookAPI && window.__kulmsTextbookAPI.detach) {
      window.__kulmsTextbookAPI.detach();
    }

    if (cacheInfoEl) cacheInfoEl.style.display = "none";

    contentEl.innerHTML = "";
    var settingsView = document.createElement("div");
    settingsView.className = "kulms-settings-view";
    var currentSettings = window.__kulmsSettings || {};
    var toggleInputs = [];
    var otherInputs = [];

    // --- ヘルパー ---
    var currentCardBody = null;

    function createSettingsSection(headerText, sectionId) {
      var card = document.createElement("div");
      card.className = "kulms-settings-card";
      var h = document.createElement("div");
      h.className = "kulms-settings-section-header";
      var chevron = document.createElement("span");
      chevron.className = "kulms-settings-chevron";
      chevron.textContent = "\u25BC";
      var titleSpan = document.createElement("span");
      titleSpan.textContent = headerText;
      h.appendChild(chevron);
      h.appendChild(titleSpan);
      card.appendChild(h);
      var body = document.createElement("div");
      body.className = "kulms-settings-card-body";
      card.appendChild(body);
      var isCollapsed = settingsCollapsedState[sectionId] === true;
      if (isCollapsed) {
        chevron.classList.add("collapsed");
        body.classList.add("collapsed");
      }
      h.addEventListener("click", function () {
        chevron.classList.toggle("collapsed");
        body.classList.toggle("collapsed");
        settingsCollapsedState[sectionId] = chevron.classList.contains("collapsed");
      });
      settingsView.appendChild(card);
      currentCardBody = body;
    }

    function attachInfoToggle(labelLine, labelArea, descText) {
      if (!descText) return;
      var infoIcon = document.createElement("span");
      infoIcon.className = "kulms-settings-info-icon";
      infoIcon.textContent = "\u24D8";
      var desc = document.createElement("div");
      desc.className = "kulms-settings-desc";
      desc.textContent = descText;
      infoIcon.addEventListener("click", function () { desc.classList.toggle("open"); });
      labelLine.appendChild(infoIcon);
      labelArea.appendChild(desc);
    }

    function addFeatureToggle(feat) {
      var row = document.createElement("div");
      row.className = "kulms-settings-row";
      var labelArea = document.createElement("div");
      labelArea.className = "kulms-settings-row-text";
      var labelEl = document.createElement("div");
      labelEl.className = "kulms-settings-row-label";
      labelEl.textContent = t(feat.labelKey);
      var labelLine = document.createElement("div");
      labelLine.className = "kulms-settings-label-line";
      labelLine.appendChild(labelEl);
      labelArea.appendChild(labelLine);
      attachInfoToggle(labelLine, labelArea, t(feat.descKey));
      var toggle = document.createElement("label");
      toggle.className = "kulms-toggle";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = currentSettings[feat.key] !== false;
      var slider = document.createElement("span");
      slider.className = "kulms-toggle-slider";
      toggle.appendChild(input);
      toggle.appendChild(slider);
      input.addEventListener("change", function () {
        currentSettings[feat.key] = input.checked;
        chrome.storage.local.set({ "kulms-settings": currentSettings });
      });
      row.appendChild(labelArea);
      row.appendChild(toggle);
      currentCardBody.appendChild(row);
      toggleInputs.push({ key: feat.key, input: input });
    }

    function createNumberRow(labelText, descText, settingKey, defaultVal, min, max) {
      var row = document.createElement("div");
      row.className = "kulms-settings-row";
      var labelArea = document.createElement("div");
      labelArea.className = "kulms-settings-row-text";
      var label = document.createElement("div");
      label.className = "kulms-settings-row-label";
      label.textContent = labelText;
      var labelLine = document.createElement("div");
      labelLine.className = "kulms-settings-label-line";
      labelLine.appendChild(label);
      labelArea.appendChild(labelLine);
      attachInfoToggle(labelLine, labelArea, descText);
      var input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.value = currentSettings[settingKey] || defaultVal;
      input.className = "kulms-settings-number";
      input.addEventListener("change", function () {
        var val = parseInt(input.value, 10);
        if (isNaN(val) || val < min) val = min;
        if (val > max) val = max;
        input.value = val;
        currentSettings[settingKey] = val;
        chrome.storage.local.set({ "kulms-settings": currentSettings });
      });
      row.appendChild(labelArea);
      row.appendChild(input);
      currentCardBody.appendChild(row);
      otherInputs.push({ key: settingKey, input: input, type: "number", defaultVal: defaultVal });
    }

    function createSelectRow(labelText, descText, settingKey, defaultVal, options) {
      var row = document.createElement("div");
      row.className = "kulms-settings-row";
      var labelArea = document.createElement("div");
      labelArea.className = "kulms-settings-row-text";
      var label = document.createElement("div");
      label.className = "kulms-settings-row-label";
      label.textContent = labelText;
      var labelLine = document.createElement("div");
      labelLine.className = "kulms-settings-label-line";
      labelLine.appendChild(label);
      labelArea.appendChild(labelLine);
      attachInfoToggle(labelLine, labelArea, descText);
      var select = document.createElement("select");
      select.className = "kulms-settings-number";
      select.style.cssText = "width:auto !important;padding:4px 6px !important";
      options.forEach(function (opt) {
        var option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === (currentSettings[settingKey] || defaultVal)) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener("change", function () {
        currentSettings[settingKey] = select.value;
        chrome.storage.local.set({ "kulms-settings": currentSettings });
      });
      row.appendChild(labelArea);
      row.appendChild(select);
      currentCardBody.appendChild(row);
      otherInputs.push({ key: settingKey, input: select, type: "select", defaultVal: defaultVal });
    }

    function createColorRow(labelText, settingKey, defaultColor) {
      var row = document.createElement("div");
      row.className = "kulms-settings-row";
      var labelArea = document.createElement("div");
      labelArea.className = "kulms-settings-row-text";
      var label = document.createElement("div");
      label.className = "kulms-settings-row-label";
      label.textContent = labelText;
      labelArea.appendChild(label);
      var input = document.createElement("input");
      input.type = "color";
      input.value = currentSettings[settingKey] || defaultColor;
      input.style.cssText = "width:36px;height:28px;border:1px solid #ccc;border-radius:4px;padding:1px;cursor:pointer;flex-shrink:0";
      input.addEventListener("input", function () {
        currentSettings[settingKey] = input.value;
        chrome.storage.local.set({ "kulms-settings": currentSettings });
        injectUrgencyColors(currentSettings);
      });
      row.appendChild(labelArea);
      row.appendChild(input);
      currentCardBody.appendChild(row);
      otherInputs.push({ key: settingKey, input: input, type: "color", defaultVal: defaultColor });
    }

    // ========================================
    // 1. 外観 (Appearance): Language
    // ========================================
    createSettingsSection(t("sectionAppearance"), "sectionAppearance");

    // 言語
    var langRow = document.createElement("div");
    langRow.className = "kulms-settings-row";
    var langLabelArea = document.createElement("div");
    langLabelArea.className = "kulms-settings-row-text";
    var langLabel = document.createElement("div");
    langLabel.className = "kulms-settings-row-label";
    langLabel.textContent = t("settingsLanguage");
    var langDesc = document.createElement("div");
    langDesc.className = "kulms-settings-row-desc";
    langDesc.textContent = t("settingsLanguageDesc");
    langLabelArea.appendChild(langLabel);
    langLabelArea.appendChild(langDesc);
    var langSelect = document.createElement("select");
    langSelect.className = "kulms-settings-number";
    langSelect.style.cssText = "width:auto !important;padding:4px 6px !important";
    [
      { value: "auto", label: t("langAuto") },
      { value: "ja", label: "日本語" },
      { value: "en", label: "English" },
    ].forEach(function (opt) {
      var option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === (currentSettings.language || "auto")) option.selected = true;
      langSelect.appendChild(option);
    });
    langSelect.addEventListener("change", function () {
      currentSettings.language = langSelect.value;
      chrome.storage.local.set({ "kulms-settings": currentSettings });
    });
    langRow.appendChild(langLabelArea);
    langRow.appendChild(langSelect);
    currentCardBody.appendChild(langRow);
    otherInputs.push({ key: "language", input: langSelect, type: "select", defaultVal: "auto" });

    // ========================================
    // 2. パネル (Panel): textbooks, memos, panelPush
    // ========================================
    // 3. サイドバー (Sidebar)
    // 4. コースページ (Course Page)
    // ========================================
    FEATURE_GROUPS.forEach(function (group) {
      createSettingsSection(t(group.sectionKey), group.sectionKey);
      group.features.forEach(addFeatureToggle);
      if (group.sectionKey === "sectionSidebar") {
        createSelectRow(t("settingsTabColorStyle"), t("settingsTabColorStyleDesc"),
          "tabColorStyle", "border", [
            { value: "border", label: t("tabColorStyleBorder") },
            { value: "background", label: t("tabColorStyleBackground") },
            { value: "bold", label: t("tabColorStyleBold") },
          ]);
      }
    });

    // ========================================
    // 5. 課題更新 (Assignment Updates)
    // ========================================
    createSettingsSection(t("sectionAssignmentUpdates"), "sectionAssignmentUpdates");
    addFeatureToggle({ key: "autoComplete", labelKey: "featAutoComplete", descKey: "featAutoCompleteDesc" });
    createNumberRow(
      t("settingsAutoRefresh"), t("settingsAutoRefreshDesc"),
      "fetchInterval", 120, 10, 3600
    );

    // ========================================
    // 6. 緊急度カスタマイズ (Urgency)
    // ========================================
    createSettingsSection(t("sectionUrgency"), "sectionUrgency");
    createNumberRow(
      t("settingsDangerHours"), t("settingsDangerHoursDesc"),
      "dangerHours", 24, 1, 168
    );
    createNumberRow(
      t("settingsWarningDays"), t("settingsWarningDaysDesc"),
      "warningDays", 5, 1, 60
    );
    createNumberRow(
      t("settingsSuccessDays"), t("settingsSuccessDaysDesc"),
      "successDays", 14, 1, 120
    );
    createColorRow(t("settingsColorDanger"), "colorDanger", "#e85555");
    createColorRow(t("settingsColorWarning"), "colorWarning", "#d7aa57");
    createColorRow(t("settingsColorSuccess"), "colorSuccess", "#62b665");
    createColorRow(t("settingsColorOther"), "colorOther", "#777777");

    // ========================================
    // 7. 一括操作ボタン
    // ========================================
    var DEFAULTS_COPY = window.__kulmsDefaults;

    function applyAll(valueFn) {
      toggleInputs.forEach(function (item) {
        var val = valueFn(item.key);
        item.input.checked = val;
        currentSettings[item.key] = val;
      });
      chrome.storage.local.set({ "kulms-settings": currentSettings });
    }

    var btnRow = document.createElement("div");
    btnRow.className = "kulms-settings-btn-row";

    var btnDefault = document.createElement("button");
    btnDefault.className = "kulms-settings-btn";
    btnDefault.textContent = t("btnDefaults");
    btnDefault.addEventListener("click", function () {
      applyAll(function (key) { return DEFAULTS_COPY[key] !== false; });
      otherInputs.forEach(function (item) {
        var def = DEFAULTS_COPY[item.key] !== undefined ? DEFAULTS_COPY[item.key] : item.defaultVal;
        if (item.type === "color") {
          item.input.value = def;
          currentSettings[item.key] = def;
          injectUrgencyColors(currentSettings);
        } else if (item.type === "number") {
          item.input.value = def;
          currentSettings[item.key] = def;
        } else if (item.type === "select") {
          item.input.value = def;
          currentSettings[item.key] = def;
        }
      });
      chrome.storage.local.set({ "kulms-settings": currentSettings });
    });

    var btnAllOn = document.createElement("button");
    btnAllOn.className = "kulms-settings-btn";
    btnAllOn.textContent = t("btnAllOn");
    btnAllOn.addEventListener("click", function () {
      applyAll(function () { return true; });
    });

    var btnAllOff = document.createElement("button");
    btnAllOff.className = "kulms-settings-btn";
    btnAllOff.textContent = t("btnAllOff");
    btnAllOff.addEventListener("click", function () {
      applyAll(function () { return false; });
    });

    btnRow.appendChild(btnDefault);
    btnRow.appendChild(btnAllOn);
    btnRow.appendChild(btnAllOff);
    settingsView.appendChild(btnRow);

    var footer = document.createElement("div");
    footer.className = "kulms-settings-footer";
    footer.textContent = t("settingsFooter");
    settingsView.appendChild(footer);

    // ========================================
    // 8. フィードバック
    // ========================================
    var feedbackMsg = document.createElement("div");
    feedbackMsg.className = "kulms-settings-footer";
    feedbackMsg.style.cssText = "padding:12px 16px 4px !important;color:#777 !important;line-height:1.5 !important";
    feedbackMsg.textContent = t("feedbackMessage");
    settingsView.appendChild(feedbackMsg);

    var feedbackRow = document.createElement("div");
    feedbackRow.className = "kulms-settings-row kulms-settings-feedback";
    var feedbackLink = document.createElement("a");
    feedbackLink.href = "https://docs.google.com/forms/d/e/1FAIpQLSeiGVguFncfiViN7CicvmHwMrHXm7bFlTYwWYR1_P-0gP_mqw/viewform";
    feedbackLink.target = "_blank";
    feedbackLink.rel = "noopener";
    feedbackLink.className = "kulms-feedback-link";
    feedbackLink.textContent = t("feedbackLink");
    feedbackRow.appendChild(feedbackLink);
    settingsView.appendChild(feedbackRow);

    var supportRow = document.createElement("div");
    supportRow.className = "kulms-settings-row kulms-settings-feedback";
    supportRow.style.cssText = "flex-direction:column !important;align-items:center !important;gap:4px !important";
    var supportLink = document.createElement("a");
    supportLink.href = "https://ko-fi.com/radian0523";
    supportLink.target = "_blank";
    supportLink.rel = "noopener";
    supportLink.className = "kulms-feedback-link";
    supportLink.style.cssText = "width:100% !important";
    supportLink.textContent = t("supportLink");
    var supportDescEl = document.createElement("div");
    supportDescEl.style.cssText = "font-size:11px;color:#aaa";
    supportDescEl.textContent = t("supportDesc");
    supportRow.appendChild(supportDescEl);
    supportRow.appendChild(supportLink);
    settingsView.appendChild(supportRow);

    contentEl.appendChild(settingsView);
  }

  function showTextbooksView() {
    if (currentView === "textbooks") return;
    currentView = "textbooks";

    if (cacheInfoEl) cacheInfoEl.style.display = "none";

    contentEl.innerHTML = "";
    if (window.__kulmsTextbookAPI) {
      window.__kulmsTextbookAPI.loadInto(contentEl, false);
    } else {
      var msg = document.createElement("div");
      msg.className = "kulms-assign-empty";
      msg.textContent = t("textbooksDisabled");
      contentEl.appendChild(msg);
    }
  }

  function showAssignmentsView() {
    if (currentView === "assignments") return;
    currentView = "assignments";
    if (window.__kulmsTextbookAPI && window.__kulmsTextbookAPI.detach) {
      window.__kulmsTextbookAPI.detach();
    }

    if (cacheInfoEl) cacheInfoEl.style.display = "";
    loadAssignments(false);
  }

  // --- 緊急度カラー注入 ---

  function injectUrgencyColors(s) {
    var id = "kulms-urgency-colors";
    var existing = document.getElementById(id);
    if (existing) existing.remove();
    var style = document.createElement("style");
    style.id = id;
    style.textContent = ":root{" +
      "--kulms-color-danger:" + (s.colorDanger || "#e85555") + ";" +
      "--kulms-color-warning:" + (s.colorWarning || "#d7aa57") + ";" +
      "--kulms-color-success:" + (s.colorSuccess || "#62b665") + ";" +
      "--kulms-color-other:" + (s.colorOther || "#777777") + "}";
    document.head.appendChild(style);
  }

  // --- サイドバー機能 ---

  // サイドバースタイル上書き（<style>タグをDOMに直接注入）
  function injectSidebarOverride() {
    if (window.__kulmsSettings && window.__kulmsSettings.sidebarStyle === false) return;
    var colorStyle = (window.__kulmsSettings || {}).tabColorStyle || "border";
    var style = document.createElement("style");
    style.id = "kulms-sidebar-override";
    // 共通: 選択中の青背景を消す + 文字正規化
    var common =
      "#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head { background-color: transparent !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head a { color: rgb(15, 75, 112) !important; font-weight: 400 !important; font-size: 14px !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head button { color: var(--sakai-text-color-1, #333) !important; }";

    var modeCSS = "";
    if (colorStyle === "background") {
      modeCSS =
        "#portal-nav-sidebar li.site-list-item.is-current-site { border-left: 3px solid #888 !important; background: rgba(0,0,0,0.04) !important; }" +
        "#portal-nav-sidebar.kulms-color-background li.site-list-item.is-current-site.cs-tab-danger { border-left: 3px solid var(--kulms-color-danger) !important; background: color-mix(in srgb, var(--kulms-color-danger) 26%, transparent) !important; }" +
        "#portal-nav-sidebar.kulms-color-background li.site-list-item.is-current-site.cs-tab-warning { border-left: 3px solid var(--kulms-color-warning) !important; background: color-mix(in srgb, var(--kulms-color-warning) 26%, transparent) !important; }" +
        "#portal-nav-sidebar.kulms-color-background li.site-list-item.is-current-site.cs-tab-success { border-left: 3px solid var(--kulms-color-success) !important; background: color-mix(in srgb, var(--kulms-color-success) 26%, transparent) !important; }" +
        "#portal-nav-sidebar.kulms-color-background li.site-list-item.is-current-site.cs-tab-other { border-left: 3px solid var(--kulms-color-other) !important; background: color-mix(in srgb, var(--kulms-color-other) 26%, transparent) !important; }";
    } else if (colorStyle === "bold") {
      modeCSS =
        "#portal-nav-sidebar li.site-list-item.is-current-site { border-left: 4px solid #888 !important; background: rgba(0,0,0,0.03) !important; }" +
        "#portal-nav-sidebar.kulms-color-bold li.site-list-item.is-current-site.cs-tab-danger { border-left: 6px solid var(--kulms-color-danger) !important; background: color-mix(in srgb, var(--kulms-color-danger) 14%, transparent) !important; }" +
        "#portal-nav-sidebar.kulms-color-bold li.site-list-item.is-current-site.cs-tab-warning { border-left: 6px solid var(--kulms-color-warning) !important; background: color-mix(in srgb, var(--kulms-color-warning) 14%, transparent) !important; }" +
        "#portal-nav-sidebar.kulms-color-bold li.site-list-item.is-current-site.cs-tab-success { border-left: 6px solid var(--kulms-color-success) !important; background: color-mix(in srgb, var(--kulms-color-success) 14%, transparent) !important; }" +
        "#portal-nav-sidebar.kulms-color-bold li.site-list-item.is-current-site.cs-tab-other { border-left: 6px solid var(--kulms-color-other) !important; background: color-mix(in srgb, var(--kulms-color-other) 14%, transparent) !important; }";
    } else {
      modeCSS =
        "#portal-nav-sidebar li.site-list-item.is-current-site { border-left: 3px solid #888 !important; }" +
        "#portal-nav-sidebar.kulms-color-border li.site-list-item.is-current-site.cs-tab-danger { border-left: 4px solid var(--kulms-color-danger) !important; }" +
        "#portal-nav-sidebar.kulms-color-border li.site-list-item.is-current-site.cs-tab-warning { border-left: 4px solid var(--kulms-color-warning) !important; }" +
        "#portal-nav-sidebar.kulms-color-border li.site-list-item.is-current-site.cs-tab-success { border-left: 4px solid var(--kulms-color-success) !important; }" +
        "#portal-nav-sidebar.kulms-color-border li.site-list-item.is-current-site.cs-tab-other { border-left: 4px solid var(--kulms-color-other) !important; }";
    }

    style.textContent = "@media (min-width: 771px) {" + common + modeCSS + "}";
    document.head.appendChild(style);
  }

  function colorSidebarTabs(assignments) {
    if (window.__kulmsSettings && window.__kulmsSettings.tabColoring === false) return;

    var sidebar = document.querySelector("#portal-nav-sidebar");
    if (sidebar) {
      var colorStyle = (window.__kulmsSettings || {}).tabColorStyle || "border";
      sidebar.classList.remove("kulms-color-border", "kulms-color-background", "kulms-color-bold");
      sidebar.classList.add("kulms-color-" + colorStyle);
    }

    var courseUrgency = {};
    var priority = {
      "urgency-overdue": 0, "urgency-danger": 1,
      "urgency-warning": 2, "urgency-success": 3, "urgency-other": 4
    };

    assignments.forEach(function (a) {
      if (isExplicitlyActive(a)) { /* 再提出可能: 色付け対象 */ }
      else if (isSubmitted(a.status) || isAssignmentChecked(a)) return;
      var u = getUrgencyClass(a.deadline);
      var existing = courseUrgency[a.courseId];
      if (!existing || (priority[u] || 99) < (priority[existing] || 99)) {
        courseUrgency[a.courseId] = u;
      }
    });

    var urgencyToTab = {
      "urgency-overdue": "cs-tab-danger",
      "urgency-danger": "cs-tab-danger",
      "urgency-warning": "cs-tab-warning",
      "urgency-success": "cs-tab-success",
      "urgency-other": "cs-tab-other"
    };

    document.querySelectorAll(".site-list-item, .fav-sites-entry").forEach(function (li) {
      li.classList.remove("cs-tab-danger", "cs-tab-warning", "cs-tab-success", "cs-tab-other");
      var link = li.querySelector('a[href*="/portal/site"]');
      if (!link) return;
      var match = link.href.match(/\/portal\/site(?:-reset)?\/([^\/?#]+)/);
      if (!match) return;
      var siteId = match[1];
      var u = courseUrgency[siteId];
      if (u && urgencyToTab[u]) {
        li.classList.add(urgencyToTab[u]);
      }
    });
  }

  function checkNotificationBadges(assignments) {
    if (window.__kulmsSettings && window.__kulmsSettings.notificationBadge === false) return;

    chrome.storage.local.get(PREV_ASSIGNMENTS_KEY, function (result) {
      var prevIds = result[PREV_ASSIGNMENTS_KEY] || {};
      var currentIds = {};
      var newByCourse = {};

      assignments.forEach(function (a) {
        var key = a.courseId + ":" + a.name;
        currentIds[key] = true;
        if (!prevIds[key]) {
          if (!newByCourse[a.courseId]) newByCourse[a.courseId] = 0;
          newByCourse[a.courseId]++;
        }
      });

      chrome.storage.local.set({ [PREV_ASSIGNMENTS_KEY]: currentIds });

      // 初回実行時はバッジ表示しない
      if (Object.keys(prevIds).length === 0) return;

      document.querySelectorAll(".kulms-notification-badge").forEach(function (el) {
        el.remove();
      });

      document.querySelectorAll(".site-list-item, .fav-sites-entry").forEach(function (li) {
        var link = li.querySelector('a[href*="/portal/site"]');
        if (!link) return;
        var match = link.href.match(/\/portal\/site(?:-reset)?\/([^\/?#]+)/);
        if (!match) return;
        var siteId = match[1];
        if (newByCourse[siteId]) {
          var head = li.querySelector(".site-list-item-head") || li;
          if (window.innerWidth > 770) head.style.position = "relative";
          var badge = document.createElement("span");
          badge.className = "kulms-notification-badge";
          head.appendChild(badge);
        }
      });
    });
  }

  // --- プレビューモード（ダミーデータ） ---

  function generateMockAssignments() {
    var now = Date.now();
    var h = 60 * 60 * 1000;
    var d = 24 * h;
    return [
      { courseName: "線形代数学A", courseId: "mock-1", name: "第3回レポート課題", url: "", deadline: now + 6 * h, deadlineText: formatDeadline(now + 6 * h), status: "", grade: "" },
      { courseName: "プログラミング演習", courseId: "mock-2", name: "演習課題5: ソートアルゴリズム", url: "", deadline: now + 18 * h, deadlineText: formatDeadline(now + 18 * h), status: "", grade: "" },
      { courseName: "電磁気学", courseId: "mock-3", name: "中間レポート", url: "", deadline: now + 3 * d, deadlineText: formatDeadline(now + 3 * d), status: "", grade: "" },
      { courseName: "英語リーディング", courseId: "mock-4", name: "Reading Response #4", url: "", deadline: now + 4 * d, deadlineText: formatDeadline(now + 4 * d), status: "", grade: "" },
      { courseName: "線形代数学A", courseId: "mock-1", name: "演習問題 第4章", url: "", deadline: now + 8 * d, deadlineText: formatDeadline(now + 8 * d), status: "", grade: "" },
      { courseName: "プログラミング演習", courseId: "mock-2", name: "演習課題4: 再帰", url: "", deadline: now + 10 * d, deadlineText: formatDeadline(now + 10 * d), status: "", grade: "" },
      { courseName: "電磁気学", courseId: "mock-3", name: "小テスト予習問題", url: "", deadline: now + 20 * d, deadlineText: formatDeadline(now + 20 * d), status: "", grade: "" },
      { courseName: "情報理論", courseId: "mock-5", name: "期限なし参考課題", url: "", deadline: null, deadlineText: "", status: "", grade: "" },
      { courseName: "英語リーディング", courseId: "mock-4", name: "Reading Response #3", url: "", deadline: now - 2 * d, deadlineText: formatDeadline(now - 2 * d), status: "提出済", grade: "" },
      { courseName: "プログラミング演習", courseId: "mock-2", name: "演習課題3: 配列操作", url: "", deadline: now - 5 * d, deadlineText: formatDeadline(now - 5 * d), status: "評定済", grade: "A" },
      { courseName: "線形代数学A", courseId: "mock-1", name: "第1回レポート課題", url: "", deadline: now - 10 * d, deadlineText: formatDeadline(now - 10 * d), status: "提出済", grade: "" },
    ];
  }

  // --- メインロジック ---

  let isLoading = false;

  async function loadAssignments(forceRefresh) {
    if (isLoading) return;
    isLoading = true;

    try {
      // プレビューモード
      var settings = window.__kulmsSettings || {};
      if (settings.previewMode) {
        var mockData = generateMockAssignments();
        updateCacheInfo(Date.now());
        renderAssignments(mockData);
        isLoading = false;
        return;
      }

      if (!forceRefresh) {
        const cached = await loadCache();
        if (cached) {
          // キャッシュのURLをポータル内URLに修正
          var toolMap = buildAssignmentToolMapFromDOM();
          for (var ci = 0; ci < cached.assignments.length; ci++) {
            var ca = cached.assignments[ci];
            if (toolMap[ca.courseId]) {
              ca.url = toolMap[ca.courseId];
            } else if (!ca.url || ca.url.indexOf("/tool/") === -1) {
              var apiUrl = await fetchAssignmentToolUrl(ca.courseId);
              if (apiUrl) ca.url = apiUrl;
            }
          }
          updateCacheInfo(cached.timestamp);
          renderAssignments(cached.assignments);
          colorSidebarTabs(cached.assignments);
          checkNotificationBadges(cached.assignments);
          isLoading = false;
          return;
        }
      }

      showLoading();
      updateCacheInfo(null);

      const assignments = await fetchAllAssignments((done, total) => {
        showLoading(done, total);
      });

      saveCache(assignments);
      updateCacheInfo(Date.now());
      renderAssignments(assignments);
      colorSidebarTabs(assignments);
      checkNotificationBadges(assignments);
    } catch (e) {
      console.error("[KULMS Extension] assignment fetch error:", e);
      showError(e.message || t("fetchError"));
    } finally {
      isLoading = false;
    }
  }

  // --- 初期化 ---

  async function init() {
    if (window !== window.top) return;
    await window.__kulmsSettingsReady;
    textbooksEnabled = (window.__kulmsSettings || {}).textbooks !== false;
    await loadCheckedState();
    await loadMemos();
    await loadDismissedState();
    createFloatingButton();
    createPanel();
    injectSidebarOverride();
    injectUrgencyColors(window.__kulmsSettings || {});

    // ページ読み込み時にキャッシュからサイドバー色分け・バッジを適用
    try {
      var cached = await loadCache();
      if (cached && cached.assignments) {
        colorSidebarTabs(cached.assignments);
        checkNotificationBadges(cached.assignments);
      }
    } catch (e) {
      // キャッシュ読み込み失敗時は無視
    }

    if (sessionStorage.getItem("kulms-panel-open") === "1") {
      openPanel();
    }

    // タブがアクティブに戻った時 or 提出後に課題を自動更新
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;

      // 提出フラグがある場合はキャッシュ無効化してリフレッシュ
      var submittedAt = sessionStorage.getItem("kulms-submitted");
      if (submittedAt) {
        sessionStorage.removeItem("kulms-submitted");
        loadCheckedState().then(function () {
          loadAssignments(true);
        });
        return;
      }

      if (panelEl && panelEl.classList.contains("open") && currentView === "assignments") {
        loadAssignments(true);
      }
    });

    // 自動フェッチ
    var intervalMs = getFetchIntervalMs();
    if (intervalMs > 0) {
      setInterval(function () {
        // バックグラウンドでfetchしてキャッシュ・サイドバーを更新
        if (document.visibilityState !== "visible") return;
        loadAssignments(true);
      }, intervalMs);
    }
  }

  // --- ポップアップからの更新リクエスト (top frame のみ) ---
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === "kulms-refresh-assignments") {
      if (window !== window.top) return false;
      loadAssignments(true).then(function () {
        sendResponse({ ok: true });
      }).catch(function () {
        sendResponse({ ok: false });
      });
      return true; // async sendResponse
    }
  });

  init();
})();
