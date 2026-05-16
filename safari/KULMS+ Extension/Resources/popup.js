// === KULMS+ Popup ===

(function () {
  "use strict";

  var LMS_URL = "https://lms.gakusei.kyoto-u.ac.jp/portal";
  var LMS_PATTERN = "https://lms.gakusei.kyoto-u.ac.jp/*";
  var CACHE_KEY = "kulms-assignments";
  var CHECKED_KEY = "kulms-checked-assignments";
  var DISMISSED_KEY = "kulms-dismissed-assignments";
  var MEMO_KEY = "kulms-memos";
  var SETTINGS_KEY = "kulms-settings";

  var settings = {};
  var overrideMessages = null;
  var sectionCollapsedState = {};

  // --- i18n (same approach as settings.js) ---

  function t(key, substitutions) {
    if (overrideMessages && overrideMessages[key]) {
      var entry = overrideMessages[key];
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
    // Safari's chrome.i18n.getMessage has placeholder substitution bugs,
    // so always load messages.json and use manual substitution in t().
    var resolvedLang = lang;
    if (!resolvedLang || resolvedLang === "auto") {
      var uiLang = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || navigator.language || "en";
      resolvedLang = uiLang.toLowerCase().indexOf("ja") === 0 ? "ja" : "en";
    }
    var url = chrome.runtime.getURL("_locales/" + resolvedLang + "/messages.json");
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) { overrideMessages = data; })
      .catch(function () { overrideMessages = null; });
  }

  // --- Utility functions (ported from assignments.js) ---

  function getUrgencyClass(deadline) {
    if (!deadline) return "urgency-other";
    var diff = deadline - Date.now();
    if (diff < 0) return "urgency-overdue";
    if (diff < (settings.dangerHours || 24) * 3600000) return "urgency-danger";
    if (diff < (settings.warningDays || 5) * 86400000) return "urgency-warning";
    if (diff < (settings.successDays || 14) * 86400000) return "urgency-success";
    return "urgency-other";
  }

  function formatDeadline(ts) {
    if (!ts) return "-";
    var d = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function formatRemaining(deadline, closeTime) {
    if (!deadline) return "";
    var diff = deadline - Date.now();
    if (diff < 0) {
      if (closeTime && closeTime > Date.now()) return t("resubmitPeriod");
      return t("expired");
    }
    var days = Math.floor(diff / 86400000);
    var hours = Math.floor((diff % 86400000) / 3600000);
    var mins = Math.floor((diff % 3600000) / 60000);
    if (days > 0) return t("remainDaysHoursMins", [String(days), String(hours), String(mins)]);
    if (hours > 0) return t("remainHoursMins", [String(hours), String(mins)]);
    return t("remainMins", [String(mins)]);
  }

  function isSubmitted(status) {
    if (!status) return false;
    var s = status.toLowerCase();
    return s.includes("提出済") || s.includes("submitted") || s.includes("評定済") || s.includes("graded");
  }

  function getCheckedKey(assignment) {
    if (assignment.entityId) return assignment.entityId;
    return assignment.courseId + ":" + assignment.name;
  }

  function isAssignmentChecked(checkedState, assignment) {
    var key = getCheckedKey(assignment);
    var val = checkedState[key];
    if (val && val !== "active") return true;
    if (assignment.entityId) {
      var legacyKey = assignment.courseId + ":" + assignment.name;
      var legacyVal = checkedState[legacyKey];
      if (legacyVal && legacyVal !== "active") return true;
    }
    return false;
  }

  function isExplicitlyActive(checkedState, assignment) {
    var key = getCheckedKey(assignment);
    return checkedState[key] === "active";
  }

  function isAssignmentDismissed(dismissedState, assignment) {
    var key = getCheckedKey(assignment);
    return !!dismissedState[key];
  }

  // --- Memo helpers ---

  function normalizeMemo(memo) {
    if (typeof memo === "string") return { id: Date.now(), text: memo, created: Date.now() };
    return memo;
  }

  // --- Refresh ---

  function refreshAssignments() {
    var refreshBtn = document.getElementById("refresh-btn");
    refreshBtn.classList.add("spinning");
    refreshBtn.disabled = true;

    try {
      chrome.tabs.query({ url: LMS_PATTERN }, function (tabs) {
        if (!tabs || tabs.length === 0) {
          refreshBtn.classList.remove("spinning");
          refreshBtn.disabled = false;
          showRefreshToast(t("popupNoLmsTab"));
          return;
        }
        // アクティブなタブを優先
        tabs.sort(function (a, b) { return (b.active ? 1 : 0) - (a.active ? 1 : 0); });
        trySendRefresh(tabs, 0, refreshBtn);
      });
    } catch (e) {
      refreshBtn.classList.remove("spinning");
      refreshBtn.disabled = false;
    }
  }

  function trySendRefresh(tabs, index, refreshBtn) {
    if (index >= tabs.length) {
      refreshBtn.classList.remove("spinning");
      refreshBtn.disabled = false;
      showRefreshToast(t("popupRefreshFailed"));
      return;
    }
    chrome.tabs.sendMessage(tabs[index].id, { type: "kulms-refresh-assignments" }, { frameId: 0 }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        trySendRefresh(tabs, index + 1, refreshBtn);
      } else {
        refreshBtn.classList.remove("spinning");
        refreshBtn.disabled = false;
      }
    });
  }

  function showRefreshToast(msg) {
    var existing = document.querySelector(".toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 3000);
  }

  // --- Rendering ---

  function createSection(label, items, type, defaultCollapsed) {
    var collapsed = type in sectionCollapsedState ? sectionCollapsedState[type] : defaultCollapsed;

    var section = document.createElement("div");
    section.className = "section";

    var header = document.createElement("div");
    header.className = "section-header section-" + type;

    var toggle = document.createElement("span");
    toggle.className = "section-toggle" + (collapsed ? " collapsed" : "");
    toggle.textContent = "\u25BC";

    var titleSpan = document.createElement("span");
    titleSpan.textContent = label;

    var count = document.createElement("span");
    count.className = "section-count";
    count.textContent = "(" + items.length + ")";

    header.appendChild(toggle);
    header.appendChild(titleSpan);
    header.appendChild(count);

    var itemsContainer = document.createElement("div");
    itemsContainer.className = "section-items" + (collapsed ? " collapsed" : "");

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

    var card = document.createElement("div");
    card.className = "card " + urgency;
    if (assignment._completed) card.classList.add("completed");

    // Badge row: course pill + type badges
    var badgeRow = document.createElement("div");
    badgeRow.className = "badge-row";

    var pill = document.createElement("span");
    pill.className = "course-pill " + urgency;
    pill.textContent = assignment.courseName;
    badgeRow.appendChild(pill);

    if (assignment.type === "memo") {
      pill.style.background = "#26a69a";
      pill.classList.remove(urgency);
      var mBadge = document.createElement("span");
      mBadge.className = "badge-memo";
      mBadge.textContent = t("memoLabel");
      badgeRow.appendChild(mBadge);
    }

    if (assignment._repeat) {
      var rptBadge = document.createElement("span");
      rptBadge.className = "badge-repeat";
      rptBadge.textContent = t("memoRepeat");
      badgeRow.appendChild(rptBadge);
    }

    if (assignment.type === "quiz") {
      var qBadge = document.createElement("span");
      qBadge.className = "badge-quiz";
      qBadge.textContent = t("badgeQuiz");
      badgeRow.appendChild(qBadge);
    }

    if (assignment._resubmitActive) {
      var rBadge = document.createElement("span");
      if (assignment.allowResubmission) {
        rBadge.className = "badge-resubmit";
        rBadge.textContent = t("badgeResubmit");
      } else {
        rBadge.className = "badge-no-resubmit";
        rBadge.textContent = t("badgeNoResubmit");
      }
      badgeRow.appendChild(rBadge);
    }

    // Title
    var nameDiv = document.createElement("div");
    nameDiv.className = "card-name";
    if (assignment.url) {
      var a = document.createElement("a");
      a.href = assignment.url;
      a.textContent = assignment.name;
      a.addEventListener("click", function (e) {
        e.preventDefault();
        try { chrome.tabs.create({ url: assignment.url }); } catch (ex) { /* context invalidated */ }
      });
      nameDiv.appendChild(a);
    } else {
      nameDiv.textContent = assignment.name;
    }

    // Meta: deadline + remaining
    var meta = document.createElement("div");
    meta.className = "card-meta";

    var deadlineSpan = document.createElement("span");
    deadlineSpan.textContent = formatDeadline(assignment.deadline);
    meta.appendChild(deadlineSpan);

    var remaining = formatRemaining(assignment.deadline, assignment.closeTime);
    if (remaining) {
      var remainEl = document.createElement("span");
      remainEl.className = "time-remain";
      if (remaining === t("expired")) remainEl.classList.add("overdue");
      remainEl.textContent = remaining;
      meta.appendChild(remainEl);
    }

    card.appendChild(badgeRow);
    card.appendChild(nameDiv);
    card.appendChild(meta);
    return card;
  }

  function render(cache, checkedState, dismissedState, memos) {
    var content = document.getElementById("content");
    var cacheInfo = document.getElementById("cache-info");
    content.innerHTML = "";

    if (!cache || !cache.assignments) {
      var emptyDiv = document.createElement("div");
      emptyDiv.className = "empty";
      var icon = document.createElement("div");
      icon.className = "empty-icon";
      icon.textContent = "\uD83D\uDCCB";
      var text = document.createElement("div");
      text.className = "empty-text";
      text.textContent = t("popupNoCache");
      emptyDiv.appendChild(icon);
      emptyDiv.appendChild(text);
      content.appendChild(emptyDiv);
      cacheInfo.textContent = "";
      return;
    }

    // Cache info
    if (cache.timestamp) {
      var ago = Math.floor((Date.now() - cache.timestamp) / 60000);
      cacheInfo.textContent = ago < 1 ? t("lastUpdatedNow") : t("lastUpdatedMins", [String(ago)]);
    }

    var assignments = cache.assignments;
    var now = Date.now();

    // Filter dismissed
    var notDismissed = assignments.filter(function (a) {
      return !isAssignmentDismissed(dismissedState, a);
    });

    // Filter completed + closed
    var visible = notDismissed.filter(function (a) {
      if (isExplicitlyActive(checkedState, a)) return true;
      var done = isAssignmentChecked(checkedState, a) || isSubmitted(a.status);
      var closed = a.closeTime && a.closeTime < now;
      return !(done && closed);
    });

    // Split into completed vs active
    var completed = [];
    var active = [];

    visible.forEach(function (a) {
      var resubmitActive = isExplicitlyActive(checkedState, a);
      a._resubmitActive = resubmitActive;
      if (resubmitActive) {
        active.push(a);
      } else if (isAssignmentChecked(checkedState, a) || isSubmitted(a.status)) {
        a._completed = true;
        completed.push(a);
      } else {
        active.push(a);
      }
    });

    // Sort active by deadline
    active.sort(function (a, b) {
      if (a.deadline && b.deadline) return a.deadline - b.deadline;
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    });

    // Group by urgency
    var overdue = active.filter(function (a) { return getUrgencyClass(a.deadline) === "urgency-overdue"; });
    var danger = active.filter(function (a) { return getUrgencyClass(a.deadline) === "urgency-danger"; });
    var warning = active.filter(function (a) { return getUrgencyClass(a.deadline) === "urgency-warning"; });
    var success = active.filter(function (a) { return getUrgencyClass(a.deadline) === "urgency-success"; });
    var other = active.filter(function (a) { return getUrgencyClass(a.deadline) === "urgency-other"; });

    // Integrate deadline memos into urgency groups
    var plainMemos = [];
    if (settings.memos !== false && memos && memos.length > 0) {
      memos.forEach(function (m) {
        var memo = normalizeMemo(m);
        if (dismissedState["memo-" + memo.id]) return;
        if (!memo.deadline) {
          plainMemos.push(memo);
          return;
        }
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
          _repeat: memo.repeat || null,
        };
        if (isAssignmentChecked(checkedState, memoItem)) {
          memoItem._completed = true;
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

    var dangerLabel = t("sectionDanger", [String(settings.dangerHours || 24)]);
    var warningLabel = t("sectionWarning", [String(settings.warningDays || 5)]);
    var successLabel = t("sectionSuccess", [String(settings.successDays || 14)]);

    if (overdue.length > 0) content.appendChild(createSection(t("sectionOverdue"), overdue, "overdue", false));
    if (danger.length > 0) content.appendChild(createSection(dangerLabel, danger, "danger", false));
    if (warning.length > 0) content.appendChild(createSection(warningLabel, warning, "warning", false));
    if (success.length > 0) content.appendChild(createSection(successLabel, success, "success", false));
    if (other.length > 0) content.appendChild(createSection(t("sectionOther"), other, "other", false));

    // Plain memos (no deadline)
    if (plainMemos.length > 0) {
      content.appendChild(createMemoSection(plainMemos));
    }

    if (completed.length > 0) {
      completed.sort(function (a, b) {
        if (a.deadline && b.deadline) return b.deadline - a.deadline;
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });
      content.appendChild(createSection(t("sectionCompleted"), completed, "checked", true));
    }

    var totalActive = overdue.length + danger.length + warning.length + success.length + other.length;
    if (totalActive === 0 && completed.length === 0 && plainMemos.length === 0 && assignments.length === 0) {
      var noItems = document.createElement("div");
      noItems.className = "empty";
      var noText = document.createElement("div");
      noText.className = "empty-text";
      noText.textContent = t("noAssignments");
      noItems.appendChild(noText);
      content.appendChild(noItems);
    }
  }

  function createMemoSection(plainMemos) {
    var collapsed = "memo" in sectionCollapsedState ? sectionCollapsedState["memo"] : false;

    var section = document.createElement("div");
    section.className = "section";

    var header = document.createElement("div");
    header.className = "section-header section-memo";

    var toggle = document.createElement("span");
    toggle.className = "section-toggle" + (collapsed ? " collapsed" : "");
    toggle.textContent = "\u25BC";

    var titleSpan = document.createElement("span");
    titleSpan.textContent = t("sectionMemo");

    var count = document.createElement("span");
    count.className = "section-count";
    count.textContent = "(" + plainMemos.length + ")";

    header.appendChild(toggle);
    header.appendChild(titleSpan);
    header.appendChild(count);

    var itemsContainer = document.createElement("div");
    itemsContainer.className = "section-items" + (collapsed ? " collapsed" : "");

    plainMemos.forEach(function (memo) {
      var card = document.createElement("div");
      card.className = "card";
      card.style.borderColor = "#26a69a";

      var badgeRow = document.createElement("div");
      badgeRow.className = "badge-row";

      if (memo.courseName) {
        var pill = document.createElement("span");
        pill.className = "course-pill";
        pill.style.background = "#26a69a";
        pill.textContent = memo.courseName;
        badgeRow.appendChild(pill);
      }

      var badge = document.createElement("span");
      badge.className = "badge-memo";
      badge.textContent = t("memoLabel");
      badgeRow.appendChild(badge);

      if (memo.repeat) {
        var rptBadge = document.createElement("span");
        rptBadge.className = "badge-repeat";
        rptBadge.textContent = t("memoRepeat");
        badgeRow.appendChild(rptBadge);
      }

      var nameDiv = document.createElement("div");
      nameDiv.className = "card-name";
      nameDiv.textContent = memo.text;

      card.appendChild(badgeRow);
      card.appendChild(nameDiv);
      itemsContainer.appendChild(card);
    });

    header.addEventListener("click", function () {
      toggle.classList.toggle("collapsed");
      itemsContainer.classList.toggle("collapsed");
      sectionCollapsedState["memo"] = toggle.classList.contains("collapsed");
    });

    section.appendChild(header);
    section.appendChild(itemsContainer);
    return section;
  }

  function reloadFromStorage() {
    try {
      chrome.storage.local.get(
        [CACHE_KEY, CHECKED_KEY, DISMISSED_KEY, MEMO_KEY],
        function (result) {
          render(result[CACHE_KEY] || null, result[CHECKED_KEY] || {}, result[DISMISSED_KEY] || {}, result[MEMO_KEY] || []);
        }
      );
    } catch (e) { /* extension context invalidated */ }
  }

  // --- Init ---

  document.addEventListener("DOMContentLoaded", function () {
    try {
      chrome.storage.local.get(
        [SETTINGS_KEY, CACHE_KEY, CHECKED_KEY, DISMISSED_KEY, MEMO_KEY],
        function (result) {
          var DEFAULTS = {
            dangerHours: 24, warningDays: 5, successDays: 14,
            colorDanger: "#e85555", colorWarning: "#d7aa57",
            colorSuccess: "#62b665", colorOther: "#777777",
            language: "auto"
          };
          settings = Object.assign({}, DEFAULTS, result[SETTINGS_KEY] || {});

          // Apply custom urgency colors
          var root = document.documentElement;
          root.style.setProperty("--color-danger", settings.colorDanger);
          root.style.setProperty("--color-warning", settings.colorWarning);
          root.style.setProperty("--color-success", settings.colorSuccess);
          root.style.setProperty("--color-other", settings.colorOther);

          loadOverrideMessages(settings.language).then(function () {
            document.getElementById("header-title").textContent = t("panelTitle");
            try {
              document.getElementById("header-version").textContent = "v" + chrome.runtime.getManifest().version;
            } catch (e) {
              document.getElementById("header-version").textContent = "";
            }
            document.getElementById("open-lms").textContent = t("popupOpenLms");
            document.getElementById("refresh-btn").title = t("refresh");

            var cache = result[CACHE_KEY] || null;
            var checkedState = result[CHECKED_KEY] || {};
            var dismissedState = result[DISMISSED_KEY] || {};
            var memoState = result[MEMO_KEY] || [];
            render(cache, checkedState, dismissedState, memoState);
          });
        }
      );
    } catch (e) { /* extension context invalidated */ }

    document.getElementById("refresh-btn").addEventListener("click", refreshAssignments);

    document.getElementById("open-lms").addEventListener("click", function (e) {
      e.preventDefault();
      try { chrome.tabs.create({ url: LMS_URL }); } catch (ex) { /* context invalidated */ }
    });

    // --- TOTP Settings ---
    initTotpSection();

    // Re-render when storage changes (after refresh completes)
    try {
      chrome.storage.onChanged.addListener(function (changes) {
        if (changes[CACHE_KEY] || changes[CHECKED_KEY] || changes[DISMISSED_KEY] || changes[MEMO_KEY]) {
          reloadFromStorage();
        }
      });
    } catch (e) { /* extension context invalidated */ }
  });

  // --- TOTP Settings ---

  var BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  var BASE32_RE = /^[A-Z2-7=\s-]+$/i;
  var totpDebugTimer = null;

  function base32DecodePopup(input) {
    var cleaned = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
    if (!cleaned) return null;
    var output = [];
    var buffer = 0;
    var bitsLeft = 0;
    for (var i = 0; i < cleaned.length; i++) {
      var idx = BASE32_ALPHABET.indexOf(cleaned[i]);
      if (idx < 0) return null;
      buffer = (buffer << 5) | idx;
      bitsLeft += 5;
      if (bitsLeft >= 8) {
        bitsLeft -= 8;
        output.push((buffer >> bitsLeft) & 0xff);
      }
    }
    return new Uint8Array(output);
  }

  async function generateTOTPPopup(secret) {
    var key = base32DecodePopup(secret);
    if (!key) return null;
    var counter = Math.floor(Date.now() / 1000 / 30);
    var counterBytes = new ArrayBuffer(8);
    var view = new DataView(counterBytes);
    view.setUint32(0, Math.floor(counter / 0x100000000), false);
    view.setUint32(4, counter & 0xffffffff, false);
    var cryptoKey = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
    );
    var hmacBuffer = await crypto.subtle.sign("HMAC", cryptoKey, counterBytes);
    var hmac = new Uint8Array(hmacBuffer);
    var offset = hmac[19] & 0x0f;
    var code =
      ((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3];
    var otp = code % 1000000;
    return String(otp).padStart(6, "0");
  }

  function initTotpSection() {
    var header = document.getElementById("totp-header");
    var body = document.getElementById("totp-body");
    var toggleIcon = document.getElementById("totp-toggle");
    var input = document.getElementById("totp-input");
    var saveBtn = document.getElementById("totp-save-btn");
    var deleteBtn = document.getElementById("totp-delete-btn");

    var qrBtn = document.getElementById("totp-qr-btn");

    // i18n
    document.getElementById("totp-title").textContent = t("totpSectionTitle");
    document.getElementById("totp-status-text").textContent = t("totpConfigured");
    deleteBtn.textContent = t("totpDelete");
    saveBtn.textContent = t("totpSave");
    document.getElementById("totp-desc-text").textContent = t("totpDescription");
    document.getElementById("totp-security-note").textContent = t("totpSecurityNote");
    input.placeholder = t("totpPlaceholder");
    document.getElementById("totp-qr-btn-text").textContent = t("totpScanFromPage");

    // Toggle expand/collapse
    header.addEventListener("click", function () {
      var visible = body.classList.toggle("visible");
      if (visible) {
        toggleIcon.classList.add("expanded");
      } else {
        toggleIcon.classList.remove("expanded");
      }
    });

    // Load current state
    try {
      chrome.runtime.sendMessage({ type: "kulms-totp-has" }, function (response) {
        renderTotpState(!!(response && response.exists));
      });
    } catch (e) { /* context invalidated */ }

    // Input validation
    input.addEventListener("input", function () {
      saveBtn.disabled = !input.value.trim();
    });

    // Save
    saveBtn.addEventListener("click", function () {
      var cleaned = input.value.replace(/[\s-]/g, "").toUpperCase();
      if (!cleaned || !BASE32_RE.test(cleaned)) {
        showRefreshToast(t("totpInvalidMessage"));
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: "kulms-totp-save", secret: cleaned }, function () {
          input.value = "";
          saveBtn.disabled = true;
          renderTotpState(true);
        });
      } catch (e) { /* context invalidated */ }
    });

    // Show OTP & secret
    var showBtn = document.getElementById("totp-show-btn");
    showBtn.textContent = t("totpShowCode") || "コードを表示";
    showBtn.addEventListener("click", function () {
      var debugEl = document.getElementById("totp-debug");
      if (debugEl.style.display !== "none") {
        debugEl.style.display = "none";
        if (totpDebugTimer) { clearInterval(totpDebugTimer); totpDebugTimer = null; }
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: "kulms-totp-load" }, function (response) {
          var secret = response && response.secret;
          if (!secret) return;
          debugEl.style.display = "block";
          document.getElementById("totp-debug-secret").textContent = "Secret: " + secret;
          function updateCode() {
            generateTOTPPopup(secret).then(function (code) {
              if (code) {
                document.getElementById("totp-debug-otp").textContent = code;
                var remaining = 30 - Math.floor(Date.now() / 1000) % 30;
                document.getElementById("totp-debug-countdown").textContent = "(" + remaining + "s)";
              }
            });
          }
          updateCode();
          if (totpDebugTimer) clearInterval(totpDebugTimer);
          totpDebugTimer = setInterval(updateCode, 1000);
        });
      } catch (e) { /* context invalidated */ }
    });

    // Delete
    deleteBtn.addEventListener("click", function () {
      if (totpDebugTimer) { clearInterval(totpDebugTimer); totpDebugTimer = null; }
      try {
        chrome.runtime.sendMessage({ type: "kulms-totp-delete" }, function () {
          document.getElementById("totp-debug").style.display = "none";
          document.getElementById("totp-qr-display").style.display = "none";
          document.getElementById("totp-qr-canvas").innerHTML = "";
          renderTotpState(false);
        });
      } catch (e) { /* context invalidated */ }
    });

    // QR Code generation (show QR from stored secret)
    var qrgenBtn = document.getElementById("totp-qrgen-btn");
    qrgenBtn.addEventListener("click", function () {
      var qrDisplay = document.getElementById("totp-qr-display");
      var qrCanvas = document.getElementById("totp-qr-canvas");
      if (qrDisplay.style.display !== "none") {
        qrDisplay.style.display = "none";
        qrCanvas.innerHTML = "";
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: "kulms-totp-load" }, function (response) {
          var secret = response && response.secret;
          if (!secret) return;
          var uri = "otpauth://totp/KULMS%2B?secret=" + encodeURIComponent(secret) + "&issuer=KULMS%2B";
          try {
            var qr = qrcode(0, "M");
            qr.addData(uri);
            qr.make();
            qrCanvas.innerHTML = qr.createSvgTag(4, 2);
            qrDisplay.style.display = "block";
          } catch (e) {
            qrCanvas.innerHTML = "";
            qrDisplay.style.display = "none";
          }
        });
      } catch (e) { /* context invalidated */ }
    });

    // QR Scan from page
    qrBtn.addEventListener("click", function () {
      qrBtn.disabled = true;
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (!tabs || tabs.length === 0) {
            showRefreshToast(t("totpScanNotFound"));
            qrBtn.disabled = false;
            return;
          }
          var tabId = tabs[0].id;

          // First inject jsQR library, then run the scan function
          chrome.scripting.executeScript(
            { target: { tabId: tabId }, files: ["vendor/jsqr.min.js"] },
            function () {
              if (chrome.runtime.lastError) {
                showRefreshToast(t("totpScanNotFound"));
                qrBtn.disabled = false;
                return;
              }
              chrome.scripting.executeScript(
                { target: { tabId: tabId }, func: scanPageForQR },
                function (results) {
                  qrBtn.disabled = false;
                  if (chrome.runtime.lastError || !results || !results[0]) {
                    showRefreshToast(t("totpScanNotFound"));
                    return;
                  }
                  var secret = results[0].result;
                  if (secret) {
                    input.value = secret;
                    saveBtn.disabled = false;
                    showRefreshToast(t("totpScanSuccess"));
                  } else {
                    showRefreshToast(t("totpScanNotFound"));
                  }
                }
              );
            }
          );
        });
      } catch (e) {
        qrBtn.disabled = false;
        showRefreshToast(t("totpScanNotFound"));
      }
    });
  }

  // This function runs inside the active tab via chrome.scripting.executeScript
  function scanPageForQR() {
    function extractSecret(uri) {
      if (!uri || !uri.startsWith("otpauth://")) return null;
      try {
        var url = new URL(uri);
        var secret = url.searchParams.get("secret");
        if (secret && /^[A-Z2-7=]+$/i.test(secret.replace(/[\s-]/g, ""))) {
          return secret.replace(/[\s-]/g, "").toUpperCase();
        }
      } catch (e) { /* ignore */ }
      return null;
    }

    function tryDecodeImageData(imageData) {
      if (typeof jsQR !== "function") return null;
      var result = jsQR(imageData.data, imageData.width, imageData.height);
      if (result && result.data) return extractSecret(result.data);
      return null;
    }

    // Scan <img> elements
    var images = document.querySelectorAll("img");
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      if (img.naturalWidth < 20 || img.naturalHeight < 20) continue;
      try {
        var canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var secret = tryDecodeImageData(imageData);
        if (secret) return secret;
      } catch (e) { /* cross-origin tainted canvas - skip */ }
    }

    // Scan <canvas> elements
    var canvases = document.querySelectorAll("canvas");
    for (var j = 0; j < canvases.length; j++) {
      try {
        var c = canvases[j];
        if (c.width < 20 || c.height < 20) continue;
        var cCtx = c.getContext("2d");
        var cData = cCtx.getImageData(0, 0, c.width, c.height);
        var cSecret = tryDecodeImageData(cData);
        if (cSecret) return cSecret;
      } catch (e) { /* tainted or inaccessible - skip */ }
    }

    // Scan <svg> elements (render to canvas)
    var svgs = document.querySelectorAll("svg");
    for (var k = 0; k < svgs.length; k++) {
      try {
        var svg = svgs[k];
        var rect = svg.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) continue;
        var svgData = new XMLSerializer().serializeToString(svg);
        var svgCanvas = document.createElement("canvas");
        svgCanvas.width = rect.width;
        svgCanvas.height = rect.height;
        var svgCtx = svgCanvas.getContext("2d");
        var svgImg = new Image();
        svgImg.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgData);
        // SVG rendering is async, skip if not immediately available
      } catch (e) { /* skip */ }
    }

    return null;
  }

  function renderTotpState(hasSecret) {
    var configured = document.getElementById("totp-configured");
    var unconfigured = document.getElementById("totp-unconfigured");
    if (hasSecret) {
      configured.style.display = "block";
      unconfigured.style.display = "none";
    } else {
      configured.style.display = "none";
      unconfigured.style.display = "block";
    }
  }
})();
