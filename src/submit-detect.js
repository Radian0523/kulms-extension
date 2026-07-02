// === 課題提出検知 ===

(function () {
  "use strict";

  var detected = false;

  // Sakaiの提出フォームの assignmentId は reference 形式
  // (/assignment/a/{siteId}/{uuid}) で入る。末尾のUUIDを取り出すと
  // 課題API の entityId (素のUUID) と一致し、assignments.js の
  // checkedState のキーと噛み合う。
  function extractAssignmentUuid(ref) {
    if (!ref || ref === "$assignmentReference") return "";
    var parts = ref.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function detectSubmit() {
    if (detected) return;

    // Sakaiの課題提出フォームを探す
    var form = document.querySelector("#addSubmissionForm");
    if (!form) return;

    var assignmentIdInput = form.querySelector("[name='assignmentId']");
    // プレースホルダーのままなら、まだ入力ページ。assignmentId が
    // 解決されるのは「進める」後の確認ページなので、そこまで待つ。
    if (!assignmentIdInput || assignmentIdInput.value === "$assignmentReference") return;

    // 提出(post)ボタンは確認ページにのみ存在する。「進める(confirm)」は
    // プレビューへ進むだけなので検知対象にしない。
    var postBtn = document.querySelector("[name='post']")
      || document.querySelector("input[name='eventSubmit_doSave_submission']");
    if (!postBtn) return;

    detected = true;

    // URLからcourseIdを抽出（タイトルフォールバック用）
    var courseMatch = location.href.match(/\/portal\/site\/([^\/?#]+)/);
    var courseId = courseMatch ? courseMatch[1] : "";

    postBtn.addEventListener("click", function () {
      // 保存キーを決定。entityId(UUID)を最優先。
      var key = extractAssignmentUuid(assignmentIdInput.value);

      // フォールバック: UUIDが取れない場合はページ上の課題タイトルでキーを作る
      if (!key && courseId) {
        var titleEl = document.querySelector(".page-header h3, h3.assignment-title");
        if (!titleEl) {
          var headings = document.querySelectorAll("h3");
          for (var i = 0; i < headings.length; i++) {
            var text = headings[i].textContent.trim();
            if (text && !text.match(/^\d{4}/) && text.length < 200) {
              titleEl = headings[i];
              break;
            }
          }
        }
        if (titleEl) key = courseId + ":" + titleEl.textContent.trim();
      }

      // 提出クリックは即フォーム送信→ページ遷移する。chrome.storage は
      // 非同期で遷移に間に合わないため、同期で書ける sessionStorage に
      // 提出キーを記録し、遷移先(提出完了ページ)の assignments.js が
      // 確実に拾って checkedState へ反映する。
      sessionStorage.setItem("kulms-submitted", Date.now().toString());
      if (key) {
        var pending;
        try {
          pending = JSON.parse(sessionStorage.getItem("kulms-submitted-ids") || "[]");
        } catch (e) {
          pending = [];
        }
        if (pending.indexOf(key) === -1) pending.push(key);
        sessionStorage.setItem("kulms-submitted-ids", JSON.stringify(pending));
      }
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
