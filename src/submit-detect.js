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

  window.__kulmsSettingsReady.then(function () {
    if (window.__kulmsSettings && window.__kulmsSettings.autoComplete === false) return;
    detectSubmit();
    new MutationObserver(function () {
      detectSubmit();
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
