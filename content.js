// KULMS Content Script
// このファイルがLMSページ上で実行されます

console.log("[KULMS Extension] loaded on:", window.location.href);

// === 設定読み込み ===

window.__kulmsSettingsReady = new Promise(function (resolve) {
  var DEFAULTS = {
    theme: true, assignments: true, textbooks: true,
    treeView: true, courseNameCleanup: true, pinSort: true,
    courseRowClick: true, toolVisibility: true, sidebarResize: true
  };
  chrome.storage.local.get("kulms-settings", function (result) {
    var saved = result["kulms-settings"] || {};
    window.__kulmsSettings = Object.assign({}, DEFAULTS, saved);
    resolve(window.__kulmsSettings);
  });
});

// === サイドバーツールバー ===

(function () {
  "use strict";

  if (window !== window.top) return;

  function insertToolbar() {
    if (document.getElementById("kulms-toolbar")) return true;
    // Sakai ヘッダーのナビリストに挿入
    var header = document.querySelector("header.portal-header");
    var navList = header && header.querySelector("ul.nav");
    if (!navList) return false;
    var li = document.createElement("li");
    li.id = "kulms-toolbar";
    navList.appendChild(li);
    window.__kulmsToolbar = li;
    window.dispatchEvent(new CustomEvent("kulms-toolbar-ready"));
    return true;
  }

  if (!insertToolbar()) {
    var observer = new MutationObserver(function () {
      if (insertToolbar()) {
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();

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

  // パネル内のアクティブ状態を更新
  function updateActiveState(themeId) {
    const panel = document.getElementById("kulms-theme-panel");
    if (!panel) return;
    panel.querySelectorAll(".kulms-theme-option").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.theme === themeId);
    });
  }

  // ツールバーボタンを生成
  function createToggleButton() {
    const btn = document.createElement("button");
    btn.id = "kulms-theme-toggle";
    btn.title = "テーマ切り替え";
    btn.addEventListener("click", togglePanel);

    btn.className = "kulms-toolbar-btn";
    btn.innerHTML = '<span class="kulms-toolbar-icon">\uD83C\uDFA8</span><span class="kulms-toolbar-label">テーマ</span>';
    if (window.__kulmsToolbar) {
      window.__kulmsToolbar.appendChild(btn);
    } else {
      window.addEventListener("kulms-toolbar-ready", function () {
        window.__kulmsToolbar.appendChild(btn);
      }, { once: true });
    }
  }

  // テーマ選択パネルを生成
  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "kulms-theme-panel";
    panel.style.display = "none";

    const title = document.createElement("div");
    title.className = "kulms-panel-title";
    title.textContent = "テーマ選択";
    panel.appendChild(title);

    THEMES.forEach((theme) => {
      const option = document.createElement("button");
      option.className = "kulms-theme-option";
      option.dataset.theme = theme.id;

      const dot = document.createElement("span");
      dot.className = "kulms-color-dot";
      dot.style.backgroundColor = theme.color;

      const label = document.createElement("span");
      label.textContent = theme.label;

      option.appendChild(dot);
      option.appendChild(label);
      option.addEventListener("click", () => {
        applyTheme(theme.id);
        saveTheme(theme.id);
      });
      panel.appendChild(option);
    });

    document.body.appendChild(panel);
  }

  // パネルの表示・非表示を切り替え
  function togglePanel() {
    const panel = document.getElementById("kulms-theme-panel");
    if (!panel) return;
    const isVisible = panel.style.display !== "none";
    if (isVisible) {
      panel.style.display = "none";
    } else {
      const btn = document.getElementById("kulms-theme-toggle");
      if (btn && btn.classList.contains("kulms-toolbar-btn")) {
        const rect = btn.getBoundingClientRect();
        panel.style.position = "fixed";
        panel.style.top = (rect.bottom + 4) + "px";
        panel.style.left = rect.left + "px";
        panel.style.bottom = "auto";
        panel.style.right = "auto";
      }
      panel.style.display = "block";
    }
  }

  // パネル外クリックで閉じる
  function handleOutsideClick(e) {
    const panel = document.getElementById("kulms-theme-panel");
    const toggle = document.getElementById("kulms-theme-toggle");
    if (!panel || !toggle) return;
    if (
      panel.style.display !== "none" &&
      !panel.contains(e.target) &&
      !toggle.contains(e.target)
    ) {
      panel.style.display = "none";
    }
  }

  // 初期化
  function init() {
    if (window !== window.top) return;
    createToggleButton();
    createPanel();
    loadSavedTheme();
    document.addEventListener("click", handleOutsideClick);
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

  // --- 日付・緊急度 ---

  function getUrgencyClass(deadline) {
    if (!deadline) return "urgency-ok";
    const now = Date.now();
    const diff = deadline - now;
    if (diff < 0) return "urgency-overdue";
    if (diff < 24 * 60 * 60 * 1000) return "urgency-24h";
    if (diff < 72 * 60 * 60 * 1000) return "urgency-72h";
    return "urgency-ok";
  }

  function formatDeadline(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // --- 課題データ取得 (Sakai Direct API) ---

  function extractTimestamp(val) {
    if (!val) return null;
    if (typeof val === "number") return val;
    if (typeof val === "object" && val.time) return val.time;
    if (typeof val === "string") {
      const n = Number(val);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  async function fetchAssignmentsForCourse(course) {
    try {
      const data = await sakaiGet(
        "/direct/assignment/site/" + course.id + ".json"
      );
      const list = data.assignment_collection || [];
      return list.map((a) => {
        const deadline =
          extractTimestamp(a.dueTime) ||
          extractTimestamp(a.dueDate) ||
          extractTimestamp(a.closeTime);

        // 提出状態の判定
        let status = "";
        if (a.submitted === true) {
          status = "提出済";
        } else if (a.submissionStatus) {
          status = a.submissionStatus;
        }

        // 課題URL
        const assignUrl = a.entityURL
          ? a.entityURL.startsWith("http")
            ? a.entityURL
            : BASE_URL + a.entityURL
          : BASE_URL + "/portal/site/" + course.id;

        return {
          courseName: course.name,
          courseId: course.id,
          name: a.title || "",
          url: assignUrl,
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

    const allAssignments = [];
    let completed = 0;

    for (let i = 0; i < courses.length; i += CONCURRENT_LIMIT) {
      const batch = courses.slice(i, i + CONCURRENT_LIMIT);
      const results = await Promise.allSettled(
        batch.map((c) => fetchAssignmentsForCourse(c))
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

  // --- UI ---

  let panelEl = null;
  let contentEl = null;
  let cacheInfoEl = null;

  function createFloatingButton() {
    const btn = document.createElement("button");
    btn.id = "kulms-assign-toggle";
    btn.title = "KULMS Extension";
    btn.addEventListener("click", togglePanel);

    btn.className = "kulms-toolbar-btn";
    btn.innerHTML = '<span class="kulms-toolbar-icon">\u2699</span><span class="kulms-toolbar-label">Ext</span>';
    if (window.__kulmsToolbar) {
      window.__kulmsToolbar.appendChild(btn);
    } else {
      window.addEventListener("kulms-toolbar-ready", function () {
        window.__kulmsToolbar.appendChild(btn);
      }, { once: true });
    }
  }

  function createPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "kulms-assign-panel";

    // ヘッダー
    const header = document.createElement("div");
    header.className = "kulms-assign-header";

    const title = document.createElement("span");
    title.className = "kulms-assign-header-title";
    title.textContent = "課題一覧";

    const settingsBtn = document.createElement("button");
    settingsBtn.textContent = "\u2699"; // ⚙
    settingsBtn.title = "設定";
    settingsBtn.addEventListener("click", showSettingsView);

    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "\uD83D\uDD04"; // 🔄
    refreshBtn.title = "更新";
    refreshBtn.addEventListener("click", () => loadAssignments(true));

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715"; // ✕
    closeBtn.title = "閉じる";
    closeBtn.addEventListener("click", closePanel);

    header.appendChild(title);
    header.appendChild(settingsBtn);
    header.appendChild(refreshBtn);
    header.appendChild(closeBtn);

    // キャッシュ情報
    cacheInfoEl = document.createElement("div");
    cacheInfoEl.className = "kulms-assign-cache-info";
    cacheInfoEl.textContent = "";

    // コンテンツ
    contentEl = document.createElement("div");
    contentEl.className = "kulms-assign-content";

    panelEl.appendChild(header);
    panelEl.appendChild(cacheInfoEl);
    panelEl.appendChild(contentEl);
    document.body.appendChild(panelEl);
  }

  function togglePanel() {
    if (!panelEl) return;
    const isOpen = panelEl.classList.contains("open");
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function openPanel() {
    if (!panelEl) return;
    // 教科書パネルが開いていれば閉じる
    var textbookPanel = document.getElementById("kulms-textbook-panel");
    if (textbookPanel && textbookPanel.classList.contains("open")) {
      textbookPanel.classList.remove("open");
      document.body.classList.remove("kulms-textbook-panel-open");
    }
    panelEl.classList.add("open");
    document.body.classList.add("kulms-panel-open");
    sessionStorage.setItem("kulms-panel-open", "1");
    loadAssignments(false);
  }

  function closePanel() {
    if (!panelEl) return;
    panelEl.classList.remove("open");
    document.body.classList.remove("kulms-panel-open");
    sessionStorage.removeItem("kulms-panel-open");
  }

  function updateCacheInfo(timestamp) {
    if (!cacheInfoEl || !timestamp) {
      if (cacheInfoEl) cacheInfoEl.textContent = "";
      return;
    }
    const ago = Math.floor((Date.now() - timestamp) / 60000);
    cacheInfoEl.textContent =
      ago < 1 ? "最終更新: たった今" : `最終更新: ${ago}分前`;
  }

  function showLoading(progress, total) {
    if (!contentEl) return;
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
    if (!contentEl) return;
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
    if (!contentEl) return;
    contentEl.innerHTML = "";

    if (assignments.length === 0) {
      const empty = document.createElement("div");
      empty.className = "kulms-assign-empty";
      empty.textContent = "課題が見つかりませんでした";
      contentEl.appendChild(empty);
      return;
    }

    const notSubmitted = assignments
      .filter((a) => !isSubmitted(a.status))
      .sort((a, b) => {
        if (a.deadline && b.deadline) return a.deadline - b.deadline;
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });

    const submitted = assignments
      .filter((a) => isSubmitted(a.status))
      .sort((a, b) => {
        if (a.deadline && b.deadline) return b.deadline - a.deadline;
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });

    if (notSubmitted.length > 0) {
      contentEl.appendChild(
        createSection("未提出", notSubmitted, false)
      );
    }

    if (submitted.length > 0) {
      contentEl.appendChild(
        createSection("提出済み", submitted, true)
      );
    }
  }

  function createSection(label, items, collapsed) {
    const section = document.createElement("div");
    section.className = "kulms-assign-section";

    const header = document.createElement("div");
    header.className = "kulms-assign-section-header";

    const toggle = document.createElement("span");
    toggle.className =
      "kulms-assign-section-toggle" + (collapsed ? " collapsed" : "");
    toggle.textContent = "\u25BC"; // ▼

    const titleSpan = document.createElement("span");
    titleSpan.textContent = label;

    const count = document.createElement("span");
    count.className = "kulms-assign-section-count";
    count.textContent = `(${items.length})`;

    header.appendChild(toggle);
    header.appendChild(titleSpan);
    header.appendChild(count);

    const itemsContainer = document.createElement("div");
    itemsContainer.className =
      "kulms-assign-section-items" + (collapsed ? " collapsed" : "");

    items.forEach((a) => {
      itemsContainer.appendChild(createCard(a));
    });

    header.addEventListener("click", () => {
      toggle.classList.toggle("collapsed");
      itemsContainer.classList.toggle("collapsed");
    });

    section.appendChild(header);
    section.appendChild(itemsContainer);
    return section;
  }

  function createCard(assignment) {
    const card = document.createElement("div");
    card.className = `kulms-assign-card ${getUrgencyClass(assignment.deadline)}`;

    const course = document.createElement("div");
    course.className = "kulms-assign-card-course";
    course.textContent = assignment.courseName;

    const nameDiv = document.createElement("div");
    nameDiv.className = "kulms-assign-card-name";
    if (assignment.url) {
      const a = document.createElement("a");
      a.href = assignment.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = assignment.name;
      nameDiv.appendChild(a);
    } else {
      nameDiv.textContent = assignment.name;
    }

    const meta = document.createElement("div");
    meta.className = "kulms-assign-card-meta";

    const deadline = document.createElement("span");
    deadline.textContent = formatDeadline(assignment.deadline);

    const badge = document.createElement("span");
    badge.className = `kulms-assign-badge ${getStatusBadgeClass(assignment.status)}`;
    badge.textContent = getStatusLabel(assignment.status);

    meta.appendChild(deadline);
    meta.appendChild(badge);

    card.appendChild(course);
    card.appendChild(nameDiv);
    card.appendChild(meta);
    return card;
  }

  // --- 設定ビュー ---

  const FEATURES = [
    { key: "theme", label: "テーマ切り替え", desc: "ダーク・セピア・ブルーテーマ" },
    { key: "assignments", label: "課題一覧", desc: "全科目の課題を一覧表示" },
    { key: "textbooks", label: "教科書パネル", desc: "シラバスから教科書情報を取得" },
    { key: "treeView", label: "ツリービュー", desc: "授業資料をツリー形式で表示" },
    { key: "courseNameCleanup", label: "科目名の整理", desc: "年度・学期を省略して短縮表示" },
    { key: "pinSort", label: "ピン留めソート", desc: "曜日・時限順に自動ソート" },
    { key: "courseRowClick", label: "コース行クリック展開", desc: "サイドバーの科目行全体をクリック可能に" },
    { key: "toolVisibility", label: "ツール表示管理", desc: "不要なツールを「その他」に折りたたみ" },
    { key: "sidebarResize", label: "サイドバーリサイズ", desc: "サイドバー幅のドラッグ調整" },
  ];

  let currentView = "assignments"; // "assignments" | "settings"

  function showSettingsView() {
    if (currentView === "settings") return;
    currentView = "settings";

    // ヘッダータイトルを変更
    var titleEl = panelEl.querySelector(".kulms-assign-header-title");
    if (titleEl) {
      titleEl.textContent = "\u2190 \u8A2D\u5B9A"; // ← 設定
      titleEl.style.cursor = "pointer";
      titleEl.onclick = showAssignmentsView;
    }

    // キャッシュ情報非表示
    if (cacheInfoEl) cacheInfoEl.style.display = "none";

    // 設定UIを構築
    contentEl.innerHTML = "";
    var settingsView = document.createElement("div");
    settingsView.className = "kulms-settings-view";

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

      // トグルスイッチ
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

    // フッター
    var footer = document.createElement("div");
    footer.className = "kulms-settings-footer";
    footer.textContent = "\u5909\u66F4\u306F\u30DA\u30FC\u30B8\u518D\u8AAD\u307F\u8FBC\u307F\u5F8C\u306B\u53CD\u6620"; // 変更はページ再読み込み後に反映

    settingsView.appendChild(footer);
    contentEl.appendChild(settingsView);
  }

  function showAssignmentsView() {
    if (currentView === "assignments") return;
    currentView = "assignments";

    // ヘッダータイトルを復元
    var titleEl = panelEl.querySelector(".kulms-assign-header-title");
    if (titleEl) {
      titleEl.textContent = "\u8AB2\u984C\u4E00\u89A7"; // 課題一覧
      titleEl.style.cursor = "";
      titleEl.onclick = null;
    }

    // キャッシュ情報表示
    if (cacheInfoEl) cacheInfoEl.style.display = "";

    // 課題を再読み込み
    loadAssignments(false);
  }

  // --- メインロジック ---

  let isLoading = false;

  async function loadAssignments(forceRefresh) {
    if (isLoading) return;
    isLoading = true;

    try {
      if (!forceRefresh) {
        const cached = await loadCache();
        if (cached) {
          updateCacheInfo(cached.timestamp);
          renderAssignments(cached.assignments);
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
    } catch (e) {
      console.error("[KULMS Extension] assignment fetch error:", e);
      showError(e.message || "課題の取得に失敗しました");
    } finally {
      isLoading = false;
    }
  }

  // --- 初期化 ---

  function init() {
    if (window !== window.top) return;
    createFloatingButton();
    createPanel();
    // ページ遷移前にパネルが開いていたら自動復元
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

    tr.classList.add("kulms-tree-row");
    tr.classList.add(folder ? "kulms-tree-folder" : "kulms-tree-file");
    tr.dataset.kulmsDepth = String(depth);

    // 祖先レベルのガイドラインを追加
    for (var d = 0; d < depth; d++) {
      var ancestorPx = paddingByDepth.get(d);
      if (ancestorPx === undefined) continue;
      var guide = document.createElement("span");
      guide.className = "kulms-tree-guide";
      guide.style.left = (ancestorPx + 6) + "px";
      td.appendChild(guide);
    }
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
  var SORT_RE = /\[([月火水木金土日])\s*([０-９0-9]+)\]/;

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

  const AMAZON_AFFILIATE_TAG = "rrddrd-22";
  const TEXTBOOK_CACHE_KEY = "kulms-textbooks";
  const TEXTBOOK_CACHE_TTL = 24 * 60 * 60 * 1000; // 24時間
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
        if (
          cached &&
          cached.timestamp &&
          Date.now() - cached.timestamp < TEXTBOOK_CACHE_TTL
        ) {
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
    return "https://www.amazon.co.jp/s?k=" + encodeURIComponent(query) + "&i=stripbooks&tag=" + AMAZON_AFFILIATE_TAG;
  }

  // --- UI ---

  var panelEl = null;
  var contentEl = null;
  var isLoading = false;

  function createToggleButton() {
    var btn = document.createElement("button");
    btn.id = "kulms-textbook-toggle";
    btn.title = "\u6559\u79D1\u66F8\u30FB\u53C2\u8003\u66F8"; // 教科書・参考書
    btn.addEventListener("click", togglePanel);

    btn.className = "kulms-toolbar-btn";
    btn.innerHTML = '<span class="kulms-toolbar-icon">\uD83D\uDCDA</span><span class="kulms-toolbar-label">教科書</span>';
    if (window.__kulmsToolbar) {
      window.__kulmsToolbar.appendChild(btn);
    } else {
      window.addEventListener("kulms-toolbar-ready", function () {
        window.__kulmsToolbar.appendChild(btn);
      }, { once: true });
    }
  }

  function createPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "kulms-textbook-panel";

    // ヘッダー
    var header = document.createElement("div");
    header.className = "kulms-textbook-panel-header";

    var title = document.createElement("span");
    title.className = "kulms-textbook-panel-title";
    title.textContent = "\u6559\u79D1\u66F8\u30FB\u53C2\u8003\u66F8"; // 教科書・参考書

    var refreshBtn = document.createElement("button");
    refreshBtn.textContent = "\uD83D\uDD04"; // 🔄
    refreshBtn.title = "\u66F4\u65B0"; // 更新
    refreshBtn.addEventListener("click", function () {
      loadTextbooks(true);
    });

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715"; // ✕
    closeBtn.title = "\u9589\u3058\u308B"; // 閉じる
    closeBtn.addEventListener("click", closePanel);

    header.appendChild(title);
    header.appendChild(refreshBtn);
    header.appendChild(closeBtn);

    // コンテンツ
    contentEl = document.createElement("div");
    contentEl.className = "kulms-textbook-panel-content";

    panelEl.appendChild(header);
    panelEl.appendChild(contentEl);
    document.body.appendChild(panelEl);
  }

  function togglePanel() {
    if (!panelEl) return;
    if (panelEl.classList.contains("open")) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function openPanel() {
    if (!panelEl) return;
    // 課題パネルが開いていれば閉じる
    var assignPanel = document.getElementById("kulms-assign-panel");
    if (assignPanel && assignPanel.classList.contains("open")) {
      assignPanel.classList.remove("open");
      document.body.classList.remove("kulms-panel-open");
      sessionStorage.removeItem("kulms-panel-open");
    }
    panelEl.classList.add("open");
    document.body.classList.add("kulms-textbook-panel-open");
    loadTextbooks(false);
  }

  function closePanel() {
    if (!panelEl) return;
    panelEl.classList.remove("open");
    document.body.classList.remove("kulms-textbook-panel-open");
  }

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

  // --- 初期化 ---

  window.__kulmsSettingsReady.then(function (s) {
    if (s.textbooks === false) return;
    createToggleButton();
    createPanel();
  });
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
