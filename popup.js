// === KULMS+ Popup ===

(function () {
  "use strict";

  var LMS_URL = "https://lms.gakusei.kyoto-u.ac.jp/portal";
  var LMS_PATTERN = "https://lms.gakusei.kyoto-u.ac.jp/*";
  var CACHE_KEY = "kulms-assignments";
  var CHECKED_KEY = "kulms-checked-assignments";
  var DISMISSED_KEY = "kulms-dismissed-assignments";
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

  function formatRemaining(deadline) {
    if (!deadline) return "";
    var diff = deadline - Date.now();
    if (diff < 0) return t("expired");
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

    var remaining = formatRemaining(assignment.deadline);
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

  function render(cache, checkedState, dismissedState) {
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
    if (assignments.length === 0) {
      var emptyMsg = document.createElement("div");
      emptyMsg.className = "empty";
      var emptyText = document.createElement("div");
      emptyText.className = "empty-text";
      emptyText.textContent = t("noAssignments");
      emptyMsg.appendChild(emptyText);
      content.appendChild(emptyMsg);
      return;
    }

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

    var dangerLabel = t("sectionDanger", [String(settings.dangerHours || 24)]);
    var warningLabel = t("sectionWarning", [String(settings.warningDays || 5)]);
    var successLabel = t("sectionSuccess", [String(settings.successDays || 14)]);

    if (overdue.length > 0) content.appendChild(createSection(t("sectionOverdue"), overdue, "overdue", false));
    if (danger.length > 0) content.appendChild(createSection(dangerLabel, danger, "danger", false));
    if (warning.length > 0) content.appendChild(createSection(warningLabel, warning, "warning", false));
    if (success.length > 0) content.appendChild(createSection(successLabel, success, "success", false));
    if (other.length > 0) content.appendChild(createSection(t("sectionOther"), other, "other", false));

    if (completed.length > 0) {
      completed.sort(function (a, b) {
        if (a.deadline && b.deadline) return b.deadline - a.deadline;
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });
      content.appendChild(createSection(t("sectionCompleted"), completed, "checked", true));
    }

    if (active.length === 0 && completed.length === 0) {
      var noItems = document.createElement("div");
      noItems.className = "empty";
      var noText = document.createElement("div");
      noText.className = "empty-text";
      noText.textContent = t("noAssignments");
      noItems.appendChild(noText);
      content.appendChild(noItems);
    }
  }

  function reloadFromStorage() {
    try {
      chrome.storage.local.get(
        [CACHE_KEY, CHECKED_KEY, DISMISSED_KEY],
        function (result) {
          render(result[CACHE_KEY] || null, result[CHECKED_KEY] || {}, result[DISMISSED_KEY] || {});
        }
      );
    } catch (e) { /* extension context invalidated */ }
  }

  // --- Init ---

  document.addEventListener("DOMContentLoaded", function () {
    try {
      chrome.storage.local.get(
        [SETTINGS_KEY, CACHE_KEY, CHECKED_KEY, DISMISSED_KEY],
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
            render(cache, checkedState, dismissedState);
          });
        }
      );
    } catch (e) { /* extension context invalidated */ }

    document.getElementById("refresh-btn").addEventListener("click", refreshAssignments);

    document.getElementById("open-lms").addEventListener("click", function (e) {
      e.preventDefault();
      try { chrome.tabs.create({ url: LMS_URL }); } catch (ex) { /* context invalidated */ }
    });

    // Re-render when storage changes (after refresh completes)
    try {
      chrome.storage.onChanged.addListener(function (changes) {
        if (changes[CACHE_KEY] || changes[CHECKED_KEY] || changes[DISMISSED_KEY]) {
          reloadFromStorage();
        }
      });
    } catch (e) { /* extension context invalidated */ }
  });
})();
