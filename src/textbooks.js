// === 教科書・参考書パネル ===

(function () {
  "use strict";

  if (window !== window.top) return;
  if (window.__kulmsSettings && window.__kulmsSettings.textbooks === false) return;

  const TEXTBOOK_CACHE_KEY = "kulms-textbooks-v3";
  // キャッシュは学期内は無期限 (更新ボタンで手動リフレッシュ)、学期が変わると取り直す
  const BASE_URL = window.location.origin;

  function extractLectureCodeFromSiteId(siteId) {
    if (!siteId) return "";
    var parts = String(siteId).split("-");
    if (parts.length < 3) return "";
    var lectureCode = parts.slice(2).join("").trim();
    return /^[A-Za-z0-9]+$/.test(lectureCode) ? lectureCode.toUpperCase() : "";
  }

  // --- コース一覧取得 ---
  // Sakai APIを優先（正確なコース名・タイプを返す）

  async function fetchCoursesFromAPI() {
    const res = await fetch(BASE_URL + "/direct/site.json?_limit=200", {
      credentials: "include",
    });
    if (!res.ok) throw new Error("API failed");
    // リダイレクトで別のオリジンや http に移った応答は、TLS が LMS のものと保証しない
    var from = null;
    try { from = new URL(res.url).origin; } catch { from = null; }
    if (from !== BASE_URL) throw new Error("API was redirected to another origin");
    const data = await res.json();
    return (data.site_collection || [])
      .filter((s) => s.type === "course" || s.type === "project")
      .map((s) => ({
        id: s.id,
        name: s.title,
        lectureCode: extractLectureCodeFromSiteId(s.id),
      }));
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
          courses.push({
            id: match[1],
            name: a.textContent.trim(),
            lectureCode: extractLectureCodeFromSiteId(match[1]),
          });
        }
      });
    var seen = new Set();
    return courses.filter(function (c) {
      if (!c.name || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }

  // --- 学期判定 ---
  // 科目名の先頭 [2026前期水２] から年度・学期を読み、今の学期の科目だけ残す。
  // 京大の年度は4月始まりで、前期は4〜9月、後期は10〜翌3月。
  var TERM_RE = /^\s*\[(\d{4})(前期|後期|通年)?/;

  function getCurrentTerm() {
    var now = new Date();
    var month = now.getMonth() + 1;
    var year = month >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    return { year: year, term: month >= 4 && month <= 9 ? "前期" : "後期" };
  }

  function getCurrentTermKey() {
    var cur = getCurrentTerm();
    return cur.year + cur.term;
  }

  function isCurrentTermCourse(name) {
    var m = String(name || "").match(TERM_RE);
    // 年度表記のないサイト（プロジェクトサイト等）は判定できないので残す
    if (!m) return true;
    var cur = getCurrentTerm();
    if (parseInt(m[1], 10) !== cur.year) return false;
    // 通年・集中など前期/後期以外は同じ年度なら残す
    return !m[2] || m[2] === "通年" || m[2] === cur.term;
  }

  async function getCourses() {
    var courses = [];
    // APIを優先
    try {
      courses = await fetchCoursesFromAPI();
    } catch {
      // fallthrough to DOM
    }
    if (courses.length === 0) courses = extractCoursesFromDOM();
    return courses.filter(function (c) {
      return isCurrentTermCourse(c.name);
    });
  }

  // --- キャッシュ ---

  async function loadCache() {
    return new Promise((resolve) => {
      window.__kulmsSafeStorage.get(TEXTBOOK_CACHE_KEY, (result) => {
        const cached = result[TEXTBOOK_CACHE_KEY];
        // 学期が変わったら（または学期情報のない古いキャッシュは）取り直す
        if (cached && cached.data && cached.term === getCurrentTermKey()) {
          resolve(cached.data);
        } else {
          resolve(null);
        }
      });
    });
  }

  function saveCache(data) {
    window.__kulmsSafeStorage.set({
      [TEXTBOOK_CACHE_KEY]: { timestamp: Date.now(), term: getCurrentTermKey(), data: data },
    });
  }

  // --- background へリクエスト ---

  function fetchTextbooksForCourse(course) {
    return new Promise((resolve) => {
      if (!window.__kulmsAlive()) {
        window.__kulmsShowReloadBanner();
        resolve({ books: [], syllabusUrl: "" });
        return;
      }
      try {
        chrome.runtime.sendMessage(
          {
            action: "fetchTextbooks",
            courseName: course.name,
            lectureCode: course.lectureCode || "",
            siteId: course.id || "",
          },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve({ books: [], syllabusUrl: "" });
              return;
            }
            resolve(response ? { books: response.books || [], syllabusUrl: response.syllabusUrl || "" } : { books: [], syllabusUrl: "" });
          }
        );
      } catch (e) {
        window.__kulmsShowReloadBanner();
        resolve({ books: [], syllabusUrl: "" });
      }
    });
  }

  // --- 曜日・時限ソート (course-name.js と同じロジック) ---
  var SORT_RE = /\[(?:\d{4}[^\]]*?)?([月火水木金土日])\s*([０-９0-9]+)\s*\]/;
  var DAY_ORDER = { 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6, 日: 7 };

  function toHalfWidth(s) {
    return parseInt(
      s.replace(/[０-９]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48);
      }), 10);
  }

  function getCourseSortKey(text) {
    var m = text.match(SORT_RE);
    if (!m) return Infinity;
    return (DAY_ORDER[m[1]] || 99) * 100 + toHalfWidth(m[2]);
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

    var courseNames = Object.keys(allTextbooks).sort(function (a, b) {
      return getCourseSortKey(a) - getCourseSortKey(b);
    });
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

      if (entry.syllabusUrl) {
        var syllabusLink = document.createElement("a");
        syllabusLink.href = entry.syllabusUrl;
        syllabusLink.target = "_blank";
        syllabusLink.rel = "noopener";
        syllabusLink.className = "kulms-textbook-syllabus";
        syllabusLink.textContent = "\u30B7\u30E9\u30D0\u30B9"; // シラバス
        syllabusLink.addEventListener("click", function (e) { e.stopPropagation(); });
        header.appendChild(syllabusLink);
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
        var course = courses[i];
        var name = course.name;
        showLoading(
          "\u30B7\u30E9\u30D0\u30B9\u3092\u53D6\u5F97\u4E2D... (" +
            (i + 1) +
            "/" +
            courses.length +
            ")"
        );
        try {
          var result = await fetchTextbooksForCourse(course);
          if (result.books.length > 0) {
            allTextbooks[name] = { books: result.books, syllabusUrl: result.syllabusUrl, status: "found" };
          } else {
            allTextbooks[name] = { books: [], syllabusUrl: result.syllabusUrl, status: result.syllabusUrl ? "no_textbook" : "not_found" };
          }
        } catch (e) {
          allTextbooks[name] = { books: [], syllabusUrl: "", status: "not_found" };
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
