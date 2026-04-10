// === 教科書・参考書パネル ===

(function () {
  "use strict";

  if (window !== window.top) return;
  if (window.__kulmsSettings && window.__kulmsSettings.textbooks === false) return;

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
