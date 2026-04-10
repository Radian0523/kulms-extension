// KULMS Content Script
// このファイルがLMSページ上で実行されます

console.log("[KULMS Extension] loaded on:", window.location.href);

// === 設定読み込み ===

window.__kulmsSettingsReady = new Promise(function (resolve) {
  var DEFAULTS = {
    theme: true, assignments: true, textbooks: true,
    treeView: true, courseNameCleanup: true, pinSort: true,
    courseRowClick: true, toolVisibility: true, sidebarResize: true,
    tabColoring: true, notificationBadge: true, sidebarStyle: true, memos: true,
    panelPush: false, previewMode: false
  };
  chrome.storage.local.get("kulms-settings", function (result) {
    var saved = result["kulms-settings"] || {};
    window.__kulmsSettings = Object.assign({}, DEFAULTS, saved);
    resolve(window.__kulmsSettings);
  });
});

// === テーマ切り替え機能 ===

(function () {
  "use strict";

  const THEMES = [
    { id: "default", label: "デフォルト", color: "#ffffff" },
    { id: "dark", label: "ダーク", color: "#1a1a2e" },
    { id: "sepia", label: "セピア", color: "#f4ecd8" },
    { id: "blue", label: "ブルー", color: "#e8eef7" },
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

  window.__kulmsSettingsReady.then(function (s) {
    if (s.theme === false) return;
    init();
  });
})();

// === 全科目課題一覧機能 ===

(function () {
  "use strict";

  const CACHE_KEY = "kulms-assignments";
  const CACHE_TTL = 30 * 60 * 1000; // 30分
  const CONCURRENT_LIMIT = 4;
  const BASE_URL = window.location.origin;
  const CHECKED_KEY = "kulms-checked-assignments";
  const MEMO_KEY = "kulms-memos";
  const PREV_ASSIGNMENTS_KEY = "kulms-prev-assignment-ids";

  // --- State ---
  let checkedState = {};
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

    throw new Error("登録コースが見つかりませんでした");
  }

  // --- 日付・緊急度 (CPandA準拠) ---

  function getUrgencyClass(deadline) {
    if (!deadline) return "urgency-other";
    var now = Date.now();
    var diff = deadline - now;
    if (diff < 0) return "urgency-overdue";
    if (diff < 24 * 60 * 60 * 1000) return "urgency-danger";
    if (diff < 5 * 24 * 60 * 60 * 1000) return "urgency-warning";
    if (diff < 14 * 24 * 60 * 60 * 1000) return "urgency-success";
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
    if (diff < 0) return "期限切れ";
    var days = Math.floor(diff / (24 * 60 * 60 * 1000));
    var hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days > 0) return "残り" + days + "日" + hours + "時間";
    if (hours > 0) return "残り" + hours + "時間";
    var mins = Math.floor(diff / (60 * 1000));
    return "残り" + mins + "分";
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

  // サイドバーDOMから各コースの「課題」ツールURLを抽出
  function buildAssignmentToolMap() {
    var map = {};
    document.querySelectorAll(".nav-item a").forEach(function (a) {
      if (!a.textContent.trim().match(/^課題/)) return;
      var match = a.href.match(/\/portal\/site\/([^\/?#]+)\/tool\//);
      if (match) map[match[1]] = a.href;
    });
    return map;
  }

  async function fetchAssignmentsForCourse(course, toolMap) {
    try {
      const data = await sakaiGet(
        "/direct/assignment/site/" + course.id + ".json"
      );
      const list = data.assignment_collection || [];

      // コースの課題ツールURL（ポータル内遷移）
      var courseAssignUrl = toolMap[course.id]
        || BASE_URL + "/portal/site/" + course.id;

      return list.map((a) => {
        const deadline =
          extractTimestamp(a.dueTime) ||
          extractTimestamp(a.dueDate) ||
          extractTimestamp(a.closeTime);

        let status = "";
        if (a.submitted === true) {
          status = "提出済";
        } else if (a.submissionStatus) {
          status = a.submissionStatus;
        }

        return {
          courseName: course.name,
          courseId: course.id,
          name: a.title || "",
          url: courseAssignUrl,
          deadline: deadline,
          deadlineText: deadline ? formatDeadline(deadline) : "",
          status: status,
          grade: a.gradeDisplay || a.grade || "",
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

  async function fetchAllAssignments(onProgress) {
    const courses = await getCourses();
    if (courses.length === 0) {
      throw new Error("登録コースが見つかりませんでした");
    }

    // サイドバーから課題ツールURLを取得（この時点では描画済み）
    var toolMap = buildAssignmentToolMap();

    const allAssignments = [];
    let completed = 0;

    for (let i = 0; i < courses.length; i += CONCURRENT_LIMIT) {
      const batch = courses.slice(i, i + CONCURRENT_LIMIT);
      const results = await Promise.allSettled(
        batch.map((c) => fetchAssignmentsForCourse(c, toolMap))
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
    if (!status) return "未提出";
    if (isGraded(status)) return "評定済";
    if (isSubmitted(status)) return "提出済";
    return status;
  }

  // --- キャッシュ ---

  async function loadCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(CACHE_KEY, (result) => {
        const cached = result[CACHE_KEY];
        if (
          cached &&
          cached.timestamp &&
          Date.now() - cached.timestamp < CACHE_TTL
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
    return assignment.courseId + ":" + assignment.name;
  }

  function isAssignmentChecked(assignment) {
    return !!checkedState[getCheckedKey(assignment)];
  }

  function toggleChecked(assignment) {
    var key = getCheckedKey(assignment);
    if (checkedState[key]) {
      delete checkedState[key];
    } else {
      checkedState[key] = Date.now();
    }
    saveCheckedState();
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
    logo.textContent = "KULMS Ext";

    var headerRight = document.createElement("div");
    headerRight.className = "kulms-assign-header-right";

    var refreshBtn = document.createElement("button");
    refreshBtn.className = "kulms-assign-header-btn";
    refreshBtn.textContent = "\uD83D\uDD04"; // 🔄
    refreshBtn.title = "更新";
    refreshBtn.addEventListener("click", function () {
      if (currentView === "assignments") loadAssignments(true);
      else if (currentView === "textbooks" && window.__kulmsTextbookAPI) {
        window.__kulmsTextbookAPI.loadInto(contentEl, true);
      }
    });

    var closeBtn = document.createElement("button");
    closeBtn.className = "kulms-assign-close";
    closeBtn.textContent = "\u00D7"; // ×
    closeBtn.title = "閉じる";
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
    tabAssign.appendChild(document.createTextNode("課題"));
    tabs.push(tabAssign);

    var tabTextbook = document.createElement("label");
    tabTextbook.className = "kulms-panel-tab";
    var radioTextbook = document.createElement("input");
    radioTextbook.type = "radio";
    radioTextbook.name = "kulms-tab";
    radioTextbook.value = "textbooks";
    tabTextbook.appendChild(radioTextbook);
    tabTextbook.appendChild(document.createTextNode("教科書"));
    tabs.push(tabTextbook);

    var tabSettings = document.createElement("label");
    tabSettings.className = "kulms-panel-tab";
    var radioSettings = document.createElement("input");
    radioSettings.type = "radio";
    radioSettings.name = "kulms-tab";
    radioSettings.value = "settings";
    tabSettings.appendChild(radioSettings);
    tabSettings.appendChild(document.createTextNode("設定"));
    tabs.push(tabSettings);

    function setActiveTab(activeTab) {
      tabs.forEach(function (t) { t.classList.remove("active"); });
      activeTab.classList.add("active");
    }

    var assignEnabled = !window.__kulmsSettings || window.__kulmsSettings.assignments !== false;
    var textbooksEnabled = !window.__kulmsSettings || window.__kulmsSettings.textbooks !== false;

    if (assignEnabled) tabBar.appendChild(tabAssign);
    if (textbooksEnabled) {
      tabBar.appendChild(tabTextbook);
    }
    tabBar.appendChild(tabSettings);

    // デフォルトのアクティブタブ
    var defaultTab = assignEnabled ? tabAssign : textbooksEnabled ? tabTextbook : tabSettings;
    defaultTab.classList.add("active");

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
      ago < 1 ? "最終更新: たった今" : `最終更新: ${ago}分前`;
  }

  function showLoading(progress, total) {
    if (!contentEl || currentView !== "assignments") return;
    const text =
      progress != null && total != null
        ? `課題を取得中... (${progress}/${total})`
        : "コース情報を取得中...";
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
    retryBtn.textContent = "再試行";
    retryBtn.addEventListener("click", () => loadAssignments(true));

    errorDiv.appendChild(msgEl);
    errorDiv.appendChild(retryBtn);
    contentEl.appendChild(errorDiv);
  }

  function renderAssignments(assignments) {
    if (!contentEl || currentView !== "assignments") return;
    contentEl.innerHTML = "";
    lastAssignments = assignments;

    if (assignments.length === 0 && (!memos || memos.length === 0)) {
      var empty = document.createElement("div");
      empty.className = "kulms-assign-empty";
      empty.textContent = "課題が見つかりませんでした";
      contentEl.appendChild(empty);
      appendMemoButton();
      return;
    }

    // 振り分け: checked / submitted / active
    var checked = [];
    var submitted = [];
    var active = [];

    assignments.forEach(function (a) {
      if (isAssignmentChecked(a)) {
        checked.push(a);
      } else if (isSubmitted(a.status)) {
        submitted.push(a);
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
    var danger = active.filter(function (a) {
      var u = getUrgencyClass(a.deadline);
      return u === "urgency-danger" || u === "urgency-overdue";
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

    if (danger.length > 0) {
      contentEl.appendChild(createSection("緊急", danger, "danger", false));
    }
    if (warning.length > 0) {
      contentEl.appendChild(createSection("5日以内", warning, "warning", false));
    }
    if (success.length > 0) {
      contentEl.appendChild(createSection("14日以内", success, "success", false));
    }
    if (other.length > 0) {
      contentEl.appendChild(createSection("その他", other, "other", false));
    }
    if (submitted.length > 0) {
      submitted.sort(function (a, b) {
        if (a.deadline && b.deadline) return b.deadline - a.deadline;
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });
      contentEl.appendChild(createSection("提出済み", submitted, "other", true));
    }
    if (checked.length > 0) {
      contentEl.appendChild(createSection("完了済み", checked, "checked", true));
    }

    // メモ
    renderMemos();
    // メモ追加ボタン
    appendMemoButton();
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
      if (remaining === "期限切れ") remainEl.classList.add("overdue");
      remainEl.textContent = remaining;
      meta.appendChild(remainEl);
    }

    body.appendChild(pill);
    body.appendChild(nameDiv);
    body.appendChild(meta);

    card.appendChild(checkbox);
    card.appendChild(body);
    return card;
  }

  // --- メモ UI ---

  function renderMemos() {
    if (window.__kulmsSettings && window.__kulmsSettings.memos === false) return;
    if (!memos || memos.length === 0) return;

    var section = document.createElement("div");
    section.className = "kulms-assign-section";

    var header = document.createElement("div");
    header.className = "kulms-assign-section-header kulms-section-memo";

    var toggle = document.createElement("span");
    toggle.className = "kulms-assign-section-toggle";
    toggle.textContent = "\u25BC";

    var titleSpan = document.createElement("span");
    titleSpan.textContent = "メモ";

    var count = document.createElement("span");
    count.className = "kulms-assign-section-count";
    count.textContent = "(" + memos.length + ")";

    header.appendChild(toggle);
    header.appendChild(titleSpan);
    header.appendChild(count);

    var itemsContainer = document.createElement("div");
    itemsContainer.className = "kulms-assign-section-items";

    memos.forEach(function (memo) {
      var card = document.createElement("div");
      card.className = "kulms-assign-card kulms-memo-card";

      var badge = document.createElement("span");
      badge.className = "kulms-badge-memo";
      badge.textContent = "メモ";

      var text = document.createElement("div");
      text.className = "kulms-memo-text";
      text.textContent = memo.text;

      var delBtn = document.createElement("button");
      delBtn.className = "kulms-memo-delete";
      delBtn.textContent = "\u00D7";
      delBtn.title = "削除";
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        memos = memos.filter(function (m) { return m.id !== memo.id; });
        saveMemos();
        renderAssignments(lastAssignments);
      });

      card.appendChild(badge);
      card.appendChild(text);
      card.appendChild(delBtn);
      itemsContainer.appendChild(card);
    });

    header.addEventListener("click", function () {
      toggle.classList.toggle("collapsed");
      itemsContainer.classList.toggle("collapsed");
    });

    section.appendChild(header);
    section.appendChild(itemsContainer);
    contentEl.appendChild(section);
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
    textarea.placeholder = "メモを入力...";
    textarea.rows = 3;

    var actions = document.createElement("div");
    actions.className = "kulms-memo-form-actions";

    var saveBtn = document.createElement("button");
    saveBtn.className = "kulms-memo-save";
    saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", function () {
      var text = textarea.value.trim();
      if (!text) return;
      memos.push({ id: Date.now(), text: text, created: Date.now() });
      saveMemos();
      renderAssignments(lastAssignments);
    });

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "kulms-memo-cancel";
    cancelBtn.textContent = "キャンセル";
    cancelBtn.addEventListener("click", function () {
      form.style.display = "none";
      addBtn.style.display = "";
      textarea.value = "";
    });

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(textarea);
    form.appendChild(actions);

    // ＋ボタン
    var addBtn = document.createElement("button");
    addBtn.className = "kulms-memo-btn";
    addBtn.textContent = "\uFF0B"; // ＋
    addBtn.title = "メモを追加";
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

  var FEATURES = [
    { key: "theme", label: "テーマ切り替え", desc: "ダーク・セピア・ブルーテーマ" },
    { key: "assignments", label: "課題一覧", desc: "全科目の課題を一覧表示" },
    { key: "textbooks", label: "教科書パネル", desc: "シラバスから教科書情報を取得" },
    { key: "treeView", label: "ツリービュー", desc: "授業資料をツリー形式で表示" },
    { key: "courseNameCleanup", label: "科目名の整理", desc: "年度・学期を省略して短縮表示" },
    { key: "pinSort", label: "ピン留めソート", desc: "曜日・時限順に自動ソート" },
    { key: "courseRowClick", label: "コース行クリック展開", desc: "サイドバーの科目行全体をクリック可能に" },
    { key: "toolVisibility", label: "ツール表示管理", desc: "不要なツールを「その他」に折りたたみ" },
    { key: "sidebarResize", label: "サイドバーリサイズ", desc: "サイドバー幅のドラッグ調整" },
    { key: "tabColoring", label: "科目タブ色分け", desc: "サイドバーの科目を締切の緊急度で色分け" },
    { key: "notificationBadge", label: "新着課題バッジ", desc: "新しい課題が追加されたコースにバッジ表示" },
    { key: "sidebarStyle", label: "サイドバースタイル変更", desc: "選択中科目の青背景を除去し左ボーダー表示に変更" },
    { key: "memos", label: "メモ機能", desc: "課題タブにメモを追加・保存できる機能" },
    { key: "panelPush", label: "パネル押し出し表示", desc: "パネルを開くとページを横に押す（OFFで重ねて表示）" },
    { key: "previewMode", label: "プレビューモード", desc: "ダミー課題を表示してUIを確認（開発用）" },
  ];

  var currentView = assignEnabled ? "assignments" : textbooksEnabled ? "textbooks" : "settings";

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

    // テーマセレクター
    var themeAPI = window.__kulmsThemeAPI;
    if (themeAPI) {
      var themeSection = document.createElement("div");
      themeSection.className = "kulms-settings-theme-section";

      var themeLabel = document.createElement("div");
      themeLabel.className = "kulms-settings-row-label";
      themeLabel.textContent = "テーマ";
      themeSection.appendChild(themeLabel);

      var themeRow = document.createElement("div");
      themeRow.className = "kulms-theme-picker";

      var currentTheme = themeAPI.getCurrent();

      themeAPI.themes.forEach(function (theme) {
        var dot = document.createElement("button");
        dot.className = "kulms-theme-dot";
        if (theme.id === currentTheme) dot.classList.add("active");
        dot.style.backgroundColor = theme.color;
        dot.title = theme.label;
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

    // 機能トグル
    var currentSettings = window.__kulmsSettings || {};

    FEATURES.forEach(function (feat) {
      var row = document.createElement("div");
      row.className = "kulms-settings-row";

      var labelArea = document.createElement("div");
      labelArea.className = "kulms-settings-row-text";

      var labelEl = document.createElement("div");
      labelEl.className = "kulms-settings-row-label";
      labelEl.textContent = feat.label;

      var descEl = document.createElement("div");
      descEl.className = "kulms-settings-row-desc";
      descEl.textContent = feat.desc;

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
    });

    // ご意見箱リンク
    var feedbackRow = document.createElement("div");
    feedbackRow.className = "kulms-settings-row kulms-settings-feedback";
    var feedbackLink = document.createElement("a");
    feedbackLink.href = "https://docs.google.com/forms/d/e/1FAIpQLSdFa9VASkP0ea8uHK9GEPS3r3VnoOcIpKO0dsIeCACElvCH-Q/viewform";
    feedbackLink.target = "_blank";
    feedbackLink.rel = "noopener";
    feedbackLink.className = "kulms-feedback-link";
    feedbackLink.textContent = "\uD83D\uDCEC ご意見・要望を送る";
    feedbackRow.appendChild(feedbackLink);
    settingsView.appendChild(feedbackRow);

    var footer = document.createElement("div");
    footer.className = "kulms-settings-footer";
    footer.textContent = "変更はページ再読み込み後に反映";

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
      msg.textContent = "教科書機能が無効です";
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
      "#portal-nav-sidebar li.site-list-item.is-current-site.cs-tab-danger { border-left: 4px solid #e85555 !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site.cs-tab-warning { border-left: 4px solid #d7aa57 !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site.cs-tab-success { border-left: 4px solid #62b665 !important; }" +
      "#portal-nav-sidebar li.site-list-item.is-current-site.cs-tab-other { border-left: 4px solid #999 !important; }" +
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
          var toolMap = buildAssignmentToolMap();
          cached.assignments.forEach(function (a) {
            if (toolMap[a.courseId]) a.url = toolMap[a.courseId];
          });
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
      showError(e.message || "課題の取得に失敗しました");
    } finally {
      isLoading = false;
    }
  }

  // --- 初期化 ---

  async function init() {
    if (window !== window.top) return;
    await loadCheckedState();
    await loadMemos();
    createFloatingButton();
    createPanel();
    injectSidebarOverride();

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
  }

  init();
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
    Array.from(toolList.querySelectorAll(":scope > .nav-item")).forEach(function (t) {
      t.style.display = "";
      t.classList.remove("kulms-hidden-tool");
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
      btn.title = vis ? "その他に移動" : "メインに表示";
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
    visible.forEach(function (t) { toolList.appendChild(t); });

    if (hidden.length > 0) {
      var toggleLi = document.createElement("li");
      toggleLi.className = "kulms-other-toggle nav-item";
      var toggleA = document.createElement("a");
      toggleA.className = "btn kulms-other-btn";
      toggleA.innerHTML = '<div class="d-flex align-items-center">' +
        '<span class="kulms-other-label">その他 ▶</span></div>';
      toggleLi.appendChild(toggleA);
      toolList.appendChild(toggleLi);

      hidden.forEach(function (t) {
        t.classList.add("kulms-hidden-tool");
        toolList.appendChild(t);
      });

      toggleLi.addEventListener("click", function (e) {
        e.preventDefault();
        var label = toggleLi.querySelector(".kulms-other-label");
        var isOpen = label.textContent.indexOf("▼") !== -1;
        label.textContent = isOpen ? "その他 ▶" : "その他 ▼";
        hidden.forEach(function (t) {
          t.classList.toggle("kulms-hidden-tool", isOpen);
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
