// === ファイル D&D ===
(function () {
  "use strict";

  var injected = false;

  function injectDropZone() {
    if (injected) return;
    var form = document.querySelector("#addSubmissionForm");
    if (!form) return;
    var panel = document.getElementById("attachmentspanel");
    if (!panel) return;
    var h3 = panel.querySelector("h3");
    if (!h3) return;

    injected = true;

    var zone = document.createElement("div");
    zone.className = "kulms-file-drop-zone";
    zone.textContent = t("fileDropHint");

    h3.insertAdjacentElement("afterend", zone);

    var dragCounter = 0;

    zone.addEventListener("dragenter", function (e) {
      e.preventDefault();
      dragCounter++;
      zone.classList.add("kulms-file-drop-active");
      zone.textContent = t("fileDropActive");
    });

    zone.addEventListener("dragover", function (e) {
      e.preventDefault();
    });

    zone.addEventListener("dragleave", function (e) {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        zone.classList.remove("kulms-file-drop-active");
        updateZoneText(zone);
      }
    });

    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      dragCounter = 0;
      zone.classList.remove("kulms-file-drop-active");

      var files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      var input = document.getElementById("clonableUpload");
      if (!input) return;

      var dt = new DataTransfer();
      for (var i = 0; i < files.length; i++) {
        dt.items.add(files[i]);
      }
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));

      // ファイル名表示
      var existing = zone.querySelectorAll(".kulms-file-drop-file");
      for (var j = 0; j < existing.length; j++) existing[j].remove();
      for (var k = 0; k < files.length; k++) {
        var span = document.createElement("span");
        span.className = "kulms-file-drop-file";
        span.textContent = files[k].name;
        zone.appendChild(span);
      }
      updateZoneText(zone);
    });

    // クリックでファイル選択ダイアログを開く
    zone.addEventListener("click", function () {
      var input = document.getElementById("clonableUpload");
      if (input) input.click();
    });
  }

  function updateZoneText(zone) {
    // テキストノードだけ更新（spanは残す）
    var hasFiles = zone.querySelector(".kulms-file-drop-file");
    var firstChild = zone.firstChild;
    if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
      firstChild.textContent = hasFiles ? "" : t("fileDropHint");
    }
  }

  window.__kulmsSettingsReady.then(function (settings) {
    if (settings && settings.fileDrop === false) return;
    injectDropZone();
    new MutationObserver(function () {
      injectDropZone();
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
