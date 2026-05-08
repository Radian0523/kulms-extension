// Page-world bridge for Sakai Grader properties.
(function () {
  "use strict";

  if (window.__kulmsTaPageBridgeInstalled) return;
  window.__kulmsTaPageBridgeInstalled = true;

  function serializeGrade(grade) {
    if (grade == null) return "";
    if (typeof grade === "string") return grade.trim();
    if (typeof grade === "number") return String(grade);
    return "";
  }

  function serializeStatus(status) {
    return typeof status === "string" ? status.trim() : "";
  }

  function serializeSubmission(submission) {
    if (!submission || typeof submission !== "object") return null;
    var id = submission.id || submission.submissionId || "";
    if (!id && submission.reference) {
      var match = String(submission.reference).match(/\/([^/]+)$/);
      id = match ? match[1] : "";
    }

    return {
      id: id,
      firstSubmitterName: submission.firstSubmitterName || "",
      status: serializeStatus(submission.status || submission.submissionStatus),
      submittedTime: submission.submittedTime || "",
      submitted: !!submission.submitted,
      draft: !!submission.draft,
      grade: serializeGrade(submission.grade),
      graded: !!submission.graded,
      returned: !!submission.returned
    };
  }

  function normalizeSubmissions(source) {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    if (source instanceof Map) return Array.from(source.values());
    if (typeof source.length === "number") return Array.from(source);
    if (typeof source === "object") return Object.keys(source).map(function (key) {
      return source[key];
    });
    return [];
  }

  window.addEventListener("kulms-ta-get-submissions", function (event) {
    var detail = parseBridgeDetail(event.detail);
    var requestId = detail && detail.requestId;
    var grader = document.querySelector('sakai-grader[id^="sakai-grader-"]') ||
      document.querySelector("sakai-grader");
    var source = grader && grader.originalSubmissions;
    var submissions = normalizeSubmissions(source).map(serializeSubmission).filter(function (submission) {
      return submission && submission.id;
    });
    window.dispatchEvent(new window.CustomEvent("kulms-ta-submissions", {
      detail: JSON.stringify({
        requestId: requestId,
        count: submissions.length,
        submissions: submissions
      })
    }));
  });

  function parseBridgeDetail(detail) {
    if (typeof detail === "string") {
      try {
        return JSON.parse(detail);
      } catch {
        return null;
      }
    }
    return detail && typeof detail === "object" ? detail : null;
  }
})();
