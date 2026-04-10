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
    .catch(function () { __kulmsOverrideMessages = null; });
}

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
      if (match && !match[1].startsWith("~")) {
        courses.push({
          id: match[1],
          name: a.textContent.trim(),
          url: a.href,
        });
      }
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
      if (match && !match[1].startsWith("~")) {
        const fullUrl = href.startsWith("http") ? href : BASE_URL + href;
        courses.push({
          id: match[1],
          name: a.textContent.trim(),
          url: fullUrl,
        });
      }
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

      return list.map((a) => {
        const deadline =
          extractTimestamp(a.dueTime) ||
          extractTimestamp(a.dueDate) ||
          extractTimestamp(a.closeTime);

        // 提出状態は submissions[0] から取得
        var sub = a.submissions && a.submissions[0];
        let status = "";
        let grade = "";
        if (sub) {
          if (sub.graded) {
            status = "評定済";
            grade = sub.grade || "";
          } else if (sub.userSubmission || sub.dateSubmittedEpochSeconds > 0) {
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
    if (checkedState[key]) return true;
    // Fallback: check legacy key (courseId:name) if entityId is primary key
    if (assignment.entityId) {
      var legacyKey = assignment.courseId + ":" + assignment.name;
      if (checkedState[legacyKey]) return true;
    }
    return false;
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
    if (checkedState[key]) {
      delete checkedState[key];
    } else {
      checkedState[key] = Date.now();
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

    // 非表示（dismiss）された課題を除外
    var notDismissed = assignments.filter(function (a) {
      return !isAssignmentDismissed(a);
    });

    // 期限切れ + 完了済みの課題を除外
    var visible = notDismissed.filter(function (a) {
      var isCompleted = isAssignmentChecked(a) || isSubmitted(a.status);
      var isClosed = a.closeTime && a.closeTime < now;
      return !(isCompleted && isClosed);
    });

    // 振り分け: completed (checked or submitted) / active
    var completed = [];
    var active = [];

    visible.forEach(function (a) {
      if (isAssignmentChecked(a) || isSubmitted(a.status)) {
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

    var section = document.createElement("div");
    section.className = "kulms-assign-section";

    var header = document.createElement("div");
    header.className = "kulms-assign-section-header kulms-section-deleted";

    var toggle = document.createElement("span");
    toggle.className = "kulms-assign-section-toggle collapsed";
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
    itemsContainer.className = "kulms-assign-section-items collapsed";

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

  function createSection(label, items, type, collapsed) {
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
    });

    section.appendChild(header);
    section.appendChild(itemsContainer);
    return section;
  }

  function createCard(assignment) {
    var urgency = getUrgencyClass(assignment.deadline);
    var checked = isAssignmentChecked(assignment);

    var card = document.createElement("div");
    card.className = "kulms-assign-card " + urgency;
    if (checked) card.classList.add("kulms-checked");

    // チェックボックス
    var checkbox = document.createElement("div");
    checkbox.className = "kulms-checkbox" + (checked ? " checked" : "");
    checkbox.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleChecked(assignment);
      renderAssignments(lastAssignments);
    });

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

    body.appendChild(pill);
    if (assignment.type === "quiz") {
      var typeBadge = document.createElement("span");
      typeBadge.className = "kulms-assign-badge kulms-badge-quiz";
      typeBadge.textContent = t("badgeQuiz");
      body.appendChild(typeBadge);
    } else if (assignment.type === "memo") {
      var memoBadge = document.createElement("span");
      memoBadge.className = "kulms-badge-memo";
      memoBadge.textContent = t("memoLabel");
      body.appendChild(memoBadge);
    }
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

    var toggle = document.createElement("span");
    toggle.className = "kulms-assign-section-toggle";
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
    itemsContainer.className = "kulms-assign-section-items";

    plainMemos.forEach(function (memo) {
      itemsContainer.appendChild(createMemoCard(memo));
    });

    header.addEventListener("click", function () {
      toggle.classList.toggle("collapsed");
      itemsContainer.classList.toggle("collapsed");
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
      { key: "treeView", labelKey: "featTreeView", descKey: "featTreeViewDesc" },
    ]},
    { sectionKey: "sectionDeveloper", features: [
      { key: "previewMode", labelKey: "featPreviewMode", descKey: "featPreviewModeDesc" },
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

    // --- ヘルパー ---
    function addSectionHeader(text) {
      var h = document.createElement("div");
      h.className = "kulms-settings-section-header";
      h.textContent = text;
      settingsView.appendChild(h);
    }

    function addFeatureToggle(feat) {
      var row = document.createElement("div");
      row.className = "kulms-settings-row";
      var labelArea = document.createElement("div");
      labelArea.className = "kulms-settings-row-text";
      var labelEl = document.createElement("div");
      labelEl.className = "kulms-settings-row-label";
      labelEl.textContent = t(feat.labelKey);
      var descEl = document.createElement("div");
      descEl.className = "kulms-settings-row-desc";
      descEl.textContent = t(feat.descKey);
      labelArea.appendChild(labelEl);
      labelArea.appendChild(descEl);
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
      settingsView.appendChild(row);
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
      var desc = document.createElement("div");
      desc.className = "kulms-settings-row-desc";
      desc.textContent = descText;
      labelArea.appendChild(label);
      labelArea.appendChild(desc);
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
      settingsView.appendChild(row);
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
      settingsView.appendChild(row);
    }

    // ========================================
    // 1. 外観 (Appearance): Theme + Language
    // ========================================
    addSectionHeader(t("sectionAppearance"));

    var themeAPI = window.__kulmsThemeAPI;
    if (themeAPI) {
      var themeSection = document.createElement("div");
      themeSection.className = "kulms-settings-theme-section";
      var themeLabel = document.createElement("div");
      themeLabel.className = "kulms-settings-row-label";
      themeLabel.textContent = t("settingsTheme");
      themeSection.appendChild(themeLabel);
      var themeRow = document.createElement("div");
      themeRow.className = "kulms-theme-picker";
      var currentTheme = themeAPI.getCurrent();
      themeAPI.themes.forEach(function (theme) {
        var dot = document.createElement("button");
        dot.className = "kulms-theme-dot";
        if (theme.id === currentTheme) dot.classList.add("active");
        dot.style.backgroundColor = theme.color;
        dot.title = t(theme.labelKey);
        dot.addEventListener("click", function () {
          themeAPI.apply(theme.id);
          themeAPI.save(theme.id);
          themeRow.querySelectorAll(".kulms-theme-dot").forEach(function (d) {
            d.classList.remove("active");
          });
          dot.classList.add("active");
        });
        themeRow.appendChild(dot);
      });
      themeSection.appendChild(themeRow);
      settingsView.appendChild(themeSection);
    }

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
    settingsView.appendChild(langRow);

    // ========================================
    // 2. パネル (Panel): textbooks, memos, panelPush
    // ========================================
    // 3. サイドバー (Sidebar)
    // 4. コースページ (Course Page)
    // ========================================
    FEATURE_GROUPS.forEach(function (group) {
      addSectionHeader(t(group.sectionKey));
      group.features.forEach(addFeatureToggle);
    });

    // ========================================
    // 5. 課題更新 (Assignment Updates)
    // ========================================
    addSectionHeader(t("sectionAssignmentUpdates"));
    createNumberRow(
      t("settingsAutoRefresh"), t("settingsAutoRefreshDesc"),
      "fetchInterval", 120, 10, 3600
    );

    // ========================================
    // 6. 緊急度カスタマイズ (Urgency)
    // ========================================
    addSectionHeader(t("sectionUrgency"));
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
    var DEFAULTS_COPY = {
      textbooks: true, tabColoring: true,
      treeView: false, courseNameCleanup: false, pinSort: false,
      courseRowClick: false, toolVisibility: false, sidebarResize: false,
      notificationBadge: false, sidebarStyle: false, memos: false,
      panelPush: false, previewMode: false
    };

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

    // ========================================
    // 8. フィードバック + フッター
    // ========================================
    var feedbackRow = document.createElement("div");
    feedbackRow.className = "kulms-settings-row kulms-settings-feedback";
    var feedbackLink = document.createElement("a");
    feedbackLink.href = "https://docs.google.com/forms/d/e/1FAIpQLSdFa9VASkP0ea8uHK9GEPS3r3VnoOcIpKO0dsIeCACElvCH-Q/viewform";
    feedbackLink.target = "_blank";
    feedbackLink.rel = "noopener";
    feedbackLink.className = "kulms-feedback-link";
    feedbackLink.textContent = t("feedbackLink");
    feedbackRow.appendChild(feedbackLink);
    settingsView.appendChild(feedbackRow);

    var footer = document.createElement("div");
    footer.className = "kulms-settings-footer";
    footer.textContent = t("settingsFooter");

    settingsView.appendChild(footer);
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
    var style = document.createElement("style");
    style.id = "kulms-sidebar-override";
    style.textContent =
      // 選択中の青背景を消す
      "#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head { background-color: transparent !important; }" +
      // 文字色を通常と同じ青に戻す
      "#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head a { color: rgb(15, 75, 112) !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head button { color: var(--sakai-text-color-1, #333) !important; }" +
      // 選択中の科目名の太字・拡大を無効化
      "#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head a { font-weight: 400 !important; font-size: 14px !important; }" +
      // 選択中の科目を左ボーダーで表示（課題色がない場合）
      "#portal-nav-sidebar li.site-list-item.is-current-site { border-left: 3px solid #888 !important; }" +
      // 選択中 + 課題色がある場合は課題色を優先
      "#portal-nav-sidebar li.site-list-item.is-current-site.cs-tab-danger { border-left: 4px solid var(--kulms-color-danger) !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site.cs-tab-warning { border-left: 4px solid var(--kulms-color-warning) !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site.cs-tab-success { border-left: 4px solid var(--kulms-color-success) !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site.cs-tab-other { border-left: 4px solid var(--kulms-color-other) !important; }" +
      "";
    document.head.appendChild(style);
  }

  function colorSidebarTabs(assignments) {
    if (window.__kulmsSettings && window.__kulmsSettings.tabColoring === false) return;

    var courseUrgency = {};
    var priority = {
      "urgency-overdue": 0, "urgency-danger": 1,
      "urgency-warning": 2, "urgency-success": 3, "urgency-other": 4
    };

    assignments.forEach(function (a) {
      if (isSubmitted(a.status) || isAssignmentChecked(a)) return;
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
          head.style.position = "relative";
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

  init();
})();


// === 課題提出検知 ===

(function () {
  "use strict";

  var CHECKED_KEY = "kulms-checked-assignments";
  var detected = false;

  function detectSubmit() {
    if (detected) return;

    // Sakaiの課題提出フォームを探す
    var form = document.querySelector("#addSubmissionForm");
    if (!form) return;

    var assignmentIdInput = form.querySelector("[name='assignmentId']");
    // プレースホルダーの場合はまだ提出ページではない
    if (!assignmentIdInput || assignmentIdInput.value === "$assignmentReference") return;

    // 提出ボタンを探す
    var postBtn = document.querySelector("[name='post']")
      || document.querySelector("input[name='eventSubmit_doSave_submission']");
    if (!postBtn) return;

    detected = true;

    // URLからcourseIdを抽出
    var courseMatch = location.href.match(/\/portal\/site\/([^\/?#]+)/);
    if (!courseMatch) return;
    var courseId = courseMatch[1];

    postBtn.addEventListener("click", function () {
      // 提出フラグをsessionStorageに立てる（キャッシュ無効化のトリガー）
      sessionStorage.setItem("kulms-submitted", Date.now().toString());

      // 課題名を取得してチェック状態に保存
      chrome.storage.local.get(CHECKED_KEY, function (result) {
        var checked = result[CHECKED_KEY] || {};

        // entityIdを使う（assignmentIdInputの値がentityIdに相当）
        var entityId = assignmentIdInput ? assignmentIdInput.value : "";
        if (entityId && entityId !== "$assignmentReference") {
          checked[entityId] = Date.now();
          chrome.storage.local.set({ [CHECKED_KEY]: checked });
          return;
        }

        // フォールバック: ページ上の課題タイトルを取得
        var titleEl = document.querySelector(".page-header h3, h3.assignment-title");
        if (!titleEl) {
          var headings = document.querySelectorAll("h3");
          for (var i = 0; i < headings.length; i++) {
            var text = headings[i].textContent.trim();
            if (text && text !== "" && !text.match(/^\d{4}/) && text.length < 200) {
              titleEl = headings[i];
              break;
            }
          }
        }
        if (titleEl) {
          var key = courseId + ":" + titleEl.textContent.trim();
          checked[key] = Date.now();
          chrome.storage.local.set({ [CHECKED_KEY]: checked });
        }
      });
    });
  }

  detectSubmit();
  new MutationObserver(function () {
    detectSubmit();
  }).observe(document.body, { childList: true, subtree: true });
})();

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

// === サイドバー科目名の整理 + ピン留めソート ===

(function () {
  "use strict";

  // iframe内では実行しない
  if (window !== window.top) return;

  // [2026前期水２]固体電子工学 → [水２]固体電子工学
  var COURSE_RE =
    /^\s*\[\d{4}[^\]]*?([月火水木金土日]\s*[０-９0-9]+)\s*\]/;

  // ソート用
  var DAY_ORDER = { 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6, 日: 7 };
  var SORT_RE = /\[(?:\d{4}[^\]]*?)?([月火水木金土日])\s*([０-９0-9]+)\s*\]/;

  function toHalfWidth(s) {
    return parseInt(
      s.replace(/[０-９]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48);
      }),
      10
    );
  }

  function getSortKey(text) {
    var m = text.match(SORT_RE);
    if (!m) return Infinity;
    var day = DAY_ORDER[m[1]] || 99;
    var period = toHalfWidth(m[2]);
    return day * 100 + period;
  }

  function isCourseLink(a) {
    return (
      /\/portal\/site\//.test(a.href) &&
      !/\/tool\//.test(a.href) &&
      !/\/portal\/site\/~/.test(a.href)
    );
  }

  function cleanLink(a) {
    if (a.dataset.kulmsNameCleaned) return;
    var walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (COURSE_RE.test(node.textContent)) {
        node.textContent = node.textContent.replace(COURSE_RE, "[$1]");
        a.dataset.kulmsNameCleaned = "1";
      }
    }
  }

  function cleanAll() {
    document
      .querySelectorAll('a[href*="/portal/site/"]')
      .forEach(function (a) {
        if (a.dataset.kulmsNameCleaned) return;
        if (COURSE_RE.test(a.textContent)) cleanLink(a);
      });
  }

  // --- ピン留めソート ---
  var sorting = false;
  var sortTimer = null;
  var lastSortSignature = "";

  function sortPinned() {
    var list = document.querySelector("#pinned-site-list");
    if (!list) return;

    var items = Array.from(list.children);
    var entries = [];
    items.forEach(function (li) {
      var link = li.querySelector('a[href*="/portal/site/"]');
      if (!link || !isCourseLink(link)) return;
      entries.push({ el: li, key: getSortKey(link.textContent) });
    });

    if (entries.length < 2) return;

    var sig = entries.map(function (e) { return e.key; }).join(",");
    if (sig === lastSortSignature) return;

    entries.sort(function (a, b) { return a.key - b.key; });

    sorting = true;
    entries.forEach(function (e) {
      list.appendChild(e.el);
    });
    sorting = false;

    lastSortSignature = sig;
  }

  function scheduleSortPinned() {
    if (sorting || sortTimer) return;
    sortTimer = setTimeout(function () {
      sortTimer = null;
      sortPinned();
    }, 300);
  }

  window.__kulmsSettingsReady.then(function (s) {
    if (s.courseNameCleanup !== false) cleanAll();
    if (s.pinSort !== false) setTimeout(sortPinned, 600);

    new MutationObserver(function () {
      if (sorting) return;
      if (s.courseNameCleanup !== false) cleanAll();
      if (s.pinSort !== false) scheduleSortPinned();
    }).observe(document.body, { childList: true, subtree: true });
  });
})();

// === サイドバー: コース行クリックで展開/折りたたみ ===

(function () {
  "use strict";

  if (window !== window.top) return;

  window.__kulmsSettingsReady.then(function (s) {
    if (s.courseRowClick === false) return;

    var sidebar = document.querySelector("#portal-nav-sidebar");
    if (!sidebar) return;

    sidebar.addEventListener("click", function (e) {
      var head = e.target.closest(".site-list-item-head");
      if (!head) return;

      // ボタン（chevron・ピン留め）はそのまま通す
      if (e.target.closest("button")) return;

      e.preventDefault();
      e.stopPropagation();

      // chevron ボタンをクリック
      var chevron = head.querySelector(".site-link-block > button");
      if (chevron) chevron.click();
    });
  });
})();

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

// === 教科書・参考書パネル ===

(function () {
  "use strict";

  if (window !== window.top) return;
  if (window.__kulmsSettings && window.__kulmsSettings.textbooks === false) return;

  // アフィリエイトタグなし
  const TEXTBOOK_CACHE_KEY = "kulms-textbooks";
  // キャッシュは無期限 (更新ボタンで手動リフレッシュ)
  const BASE_URL = window.location.origin;

  // --- コース一覧取得 ---
  // Sakai APIを優先（正確なコース名・タイプを返す）

  async function fetchCoursesFromAPI() {
    const res = await fetch(BASE_URL + "/direct/site.json?_limit=200", {
      credentials: "include",
    });
    if (!res.ok) throw new Error("API failed");
    const data = await res.json();
    return (data.site_collection || [])
      .filter((s) => s.type === "course" || s.type === "project")
      .map((s) => ({ id: s.id, name: s.title }));
  }

  function extractCoursesFromDOM() {
    // サイドバーの科目リンクのみ（ツールリンクを除外）
    const courses = [];
    document
      .querySelectorAll(
        '#portal-nav-sidebar a[href*="/portal/site/"],' +
        '.fav-sites-entry a[href*="/portal/site/"],' +
        '#siteLinkList a[href*="/portal/site/"]'
      )
      .forEach(function (a) {
        var href = a.getAttribute("href") || "";
        // /tool/ を含むリンクはスキップ（ツール内リンク）
        if (/\/tool\//.test(href)) return;
        var match = href.match(/\/portal\/site\/([^\/?#]+)/);
        if (match && !match[1].startsWith("~")) {
          courses.push({ id: match[1], name: a.textContent.trim() });
        }
      });
    var seen = new Set();
    return courses.filter(function (c) {
      if (!c.name || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }

  async function getCourses() {
    // APIを優先
    try {
      var courses = await fetchCoursesFromAPI();
      if (courses.length > 0) return courses;
    } catch (e) {
      // fallthrough to DOM
    }
    return extractCoursesFromDOM();
  }

  // --- キャッシュ ---

  async function loadCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(TEXTBOOK_CACHE_KEY, (result) => {
        const cached = result[TEXTBOOK_CACHE_KEY];
        if (cached && cached.data) {
          resolve(cached.data);
        } else {
          resolve(null);
        }
      });
    });
  }

  function saveCache(data) {
    chrome.storage.local.set({
      [TEXTBOOK_CACHE_KEY]: { timestamp: Date.now(), data: data },
    });
  }

  // --- background へリクエスト ---

  function fetchTextbooksForCourse(courseName) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "fetchTextbooks", courseName: courseName },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(response && response.books ? response.books : []);
        }
      );
    });
  }

  function buildAmazonUrl(book) {
    // ISBNがある場合もない場合も検索URLを使用（最も確実）
    var query = book.isbn || book.title;
    if (!book.isbn && book.author) {
      query += " " + book.author;
    }
    return "https://www.amazon.co.jp/s?k=" + encodeURIComponent(query) + "&i=stripbooks";
  }

  // --- UI (課題パネル内に統合) ---

  var contentEl = null;
  var isLoading = false;

  function showLoading(text) {
    if (!contentEl) return;
    contentEl.innerHTML = "";
    var loading = document.createElement("div");
    loading.className = "kulms-textbook-loading";
    loading.innerHTML =
      '<div class="kulms-assign-spinner"></div>' +
      '<div class="kulms-textbook-loading-text">' +
      (text || "\u30B7\u30E9\u30D0\u30B9\u3092\u53D6\u5F97\u4E2D...") + // シラバスを取得中...
      "</div>";
    contentEl.appendChild(loading);
  }

  function showError(msg) {
    if (!contentEl) return;
    contentEl.innerHTML = "";
    var el = document.createElement("div");
    el.className = "kulms-textbook-empty";
    el.textContent = msg;
    contentEl.appendChild(el);
  }

  // allTextbooks: { courseName: { books: [...], status: "found"|"not_found"|"no_textbook" } }
  function renderCourses(allTextbooks) {
    if (!contentEl) return;
    contentEl.innerHTML = "";

    var courseNames = Object.keys(allTextbooks);
    if (courseNames.length === 0) {
      showError("\u767B\u9332\u30B3\u30FC\u30B9\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093"); // 登録コースが見つかりません
      return;
    }

    // 注記
    var note = document.createElement("div");
    note.className = "kulms-textbook-note";
    note.textContent =
      "\u203B KULASIS\u516C\u958B\u30B7\u30E9\u30D0\u30B9\u306B\u767B\u9332\u3055\u308C\u3066\u3044\u308B\u79D1\u76EE\u306E\u307F\u5BFE\u5FDC\u3002"; // ※ KULASIS公開シラバスに登録されている科目のみ対応。
    contentEl.appendChild(note);

    courseNames.forEach(function (courseName) {
      var entry = allTextbooks[courseName];
      var books = entry.books || [];
      var status = entry.status || "not_found";

      var section = document.createElement("div");
      section.className = "kulms-textbook-course";

      // 科目名ヘッダー
      var header = document.createElement("div");
      header.className = "kulms-textbook-course-header";

      var toggle = document.createElement("span");
      toggle.className = "kulms-textbook-course-toggle";
      toggle.textContent = "\u25BC"; // ▼

      var nameSpan = document.createElement("span");
      nameSpan.className = "kulms-textbook-course-name";
      nameSpan.textContent = courseName;

      header.appendChild(toggle);
      header.appendChild(nameSpan);

      if (books.length > 0) {
        var countSpan = document.createElement("span");
        countSpan.className = "kulms-textbook-course-count";
        countSpan.textContent = "(" + books.length + ")";
        header.appendChild(countSpan);
      } else {
        var badge = document.createElement("span");
        badge.className = "kulms-textbook-course-badge";
        badge.textContent =
          status === "no_textbook"
            ? "\u6559\u79D1\u66F8\u306A\u3057" // 教科書なし
            : "\u30B7\u30E9\u30D0\u30B9\u672A\u767B\u9332"; // シラバス未登録
        header.appendChild(badge);
      }

      var itemsEl = document.createElement("div");
      itemsEl.className = "kulms-textbook-course-items";

      if (books.length > 0) {
        var textbooks = books.filter(function (b) { return b.type === "textbook"; });
        var references = books.filter(function (b) { return b.type === "reference"; });

        function renderBookGroup(label, list, container) {
          if (list.length === 0) return;
          var groupLabel = document.createElement("div");
          groupLabel.className = "kulms-textbook-group-label";
          groupLabel.textContent = label;
          container.appendChild(groupLabel);

          list.forEach(function (book) {
            var item = document.createElement("div");
            item.className = "kulms-textbook-item";

            var bookInfo = document.createElement("div");
            bookInfo.className = "kulms-textbook-info";

            var bookTitle = document.createElement("div");
            bookTitle.className = "kulms-textbook-title";
            bookTitle.textContent = book.title;
            bookInfo.appendChild(bookTitle);

            var metaLine = [];
            if (book.author) metaLine.push(book.author);
            if (book.publisher) metaLine.push(book.publisher);
            if (metaLine.length > 0) {
              var meta = document.createElement("div");
              meta.className = "kulms-textbook-meta";
              meta.textContent = metaLine.join(" / ");
              bookInfo.appendChild(meta);
            }

            var amazonLink = document.createElement("a");
            amazonLink.href = buildAmazonUrl(book);
            amazonLink.target = "_blank";
            amazonLink.rel = "noopener";
            amazonLink.className = "kulms-textbook-amazon";
            amazonLink.textContent = "Amazon";
            amazonLink.title = book.isbn
              ? "ISBN: " + book.isbn
              : "Amazon\u3067\u691C\u7D22";

            item.appendChild(bookInfo);
            item.appendChild(amazonLink);
            container.appendChild(item);
          });
        }

        renderBookGroup("\u6559\u79D1\u66F8", textbooks, itemsEl); // 教科書
        renderBookGroup("\u53C2\u8003\u66F8", references, itemsEl); // 参考書
      }

      header.addEventListener("click", function () {
        if (books.length === 0) return;
        toggle.classList.toggle("collapsed");
        itemsEl.classList.toggle("collapsed");
      });

      section.appendChild(header);
      if (books.length > 0) {
        section.appendChild(itemsEl);
      }
      contentEl.appendChild(section);
    });
  }

  // --- メインロジック ---

  async function loadTextbooks(forceRefresh) {
    if (isLoading) return;
    isLoading = true;

    try {
      // キャッシュ確認
      if (!forceRefresh) {
        var cached = await loadCache();
        if (cached) {
          renderCourses(cached);
          isLoading = false;
          return;
        }
      }

      showLoading("\u30B3\u30FC\u30B9\u60C5\u5831\u3092\u53D6\u5F97\u4E2D..."); // コース情報を取得中...
      var courses = await getCourses();
      if (courses.length === 0) {
        showError("\u767B\u9332\u30B3\u30FC\u30B9\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093"); // 登録コースが見つかりません
        isLoading = false;
        return;
      }

      showLoading(
        "\u30B7\u30E9\u30D0\u30B9\u3092\u53D6\u5F97\u4E2D... (0/" + courses.length + ")"
      ); // シラバスを取得中...

      var allTextbooks = {};
      for (var i = 0; i < courses.length; i++) {
        var name = courses[i].name;
        showLoading(
          "\u30B7\u30E9\u30D0\u30B9\u3092\u53D6\u5F97\u4E2D... (" +
            (i + 1) +
            "/" +
            courses.length +
            ")"
        );
        try {
          var result = await fetchTextbooksForCourse(name);
          if (result.length > 0) {
            allTextbooks[name] = { books: result, status: "found" };
          } else {
            allTextbooks[name] = { books: [], status: "not_found" };
          }
        } catch (e) {
          allTextbooks[name] = { books: [], status: "not_found" };
        }
      }

      saveCache(allTextbooks);
      renderCourses(allTextbooks);
    } catch (e) {
      console.error("[KULMS] textbook load error:", e);
      showError("\u53D6\u5F97\u306B\u5931\u6557\u3057\u307E\u3057\u305F"); // 取得に失敗しました
    } finally {
      isLoading = false;
    }
  }

  // --- API公開 (課題パネルから呼び出される) ---

  window.__kulmsTextbookAPI = {
    loadInto: function (targetEl, forceRefresh) {
      contentEl = targetEl;
      loadTextbooks(forceRefresh);
    },
    detach: function () {
      contentEl = null;
    },
  };
})();

// === サイドバーリサイズ ===

(function () {
  "use strict";

  if (window !== window.top) return;

  window.__kulmsSettingsReady.then(function (s) {
    if (s.sidebarResize === false) return;

    var STORAGE_KEY = "kulms-sidebar-width";
    var RESET_KEY = "kulms-sidebar-v3";
    var MIN_WIDTH = 120;
    var MAX_WIDTH = 500;

    // 壊れた保存値をリセット
    if (!localStorage.getItem(RESET_KEY)) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(RESET_KEY, "1");
    }

    var sidebar = document.querySelector("#portal-nav-sidebar");
    if (!sidebar) return;

    var gridParent = sidebar.closest(".portal-container") || sidebar.parentElement;
    if (!gridParent) return;
    var parentDisplay = getComputedStyle(gridParent).display;
    if (parentDisplay !== "grid" && parentDisplay !== "inline-grid") return;

    var baseCols = getComputedStyle(gridParent).gridTemplateColumns;

    var styleEl = document.createElement("style");
    styleEl.id = "kulms-sidebar-resize";
    document.head.appendChild(styleEl);

    function applySidebarWidth(w) {
      var parts = baseCols.split(/\s+/);
      var newCols = w + "px 1fr";
      if (parts.length > 2) {
        newCols += " " + parts.slice(2).join(" ");
      }
      styleEl.textContent =
        ".portal-container { grid-template-columns: " + newCols + " !important; }\n" +
        "#portal-nav-sidebar { width: 100% !important; max-width: none !important; }\n" +
        "#portal-nav-sidebar .site-link-block { width: auto !important; flex: 1 !important; min-width: 0 !important; }\n" +
        "#portal-nav-sidebar .sidebar-site-title { width: auto !important; }\n";
    }

    sidebar.style.position = "relative";
    var handle = document.createElement("div");
    handle.className = "kulms-sidebar-handle";
    sidebar.appendChild(handle);

    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      var w = parseInt(saved, 10);
      if (w >= MIN_WIDTH && w <= MAX_WIDTH) applySidebarWidth(w);
    }

    var dragging = false;

    handle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      dragging = true;
      document.body.classList.add("kulms-sidebar-resizing");
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var rect = sidebar.getBoundingClientRect();
      var newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX - rect.left));
      applySidebarWidth(newWidth);
    });

    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("kulms-sidebar-resizing");
      var cols = getComputedStyle(gridParent).gridTemplateColumns;
      var firstCol = parseInt(cols.split(/\s+/)[0], 10);
      if (firstCol >= MIN_WIDTH && firstCol <= MAX_WIDTH) {
        localStorage.setItem(STORAGE_KEY, firstCol);
      }
    });
  });
})();
