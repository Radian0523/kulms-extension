// === ページ先読み (Speculation Rules) ===
// サイドバー / お気に入りバーのリンクにマウスを乗せた時点で遷移先を裏で描画しておき、
// クリックした瞬間に表示する。対応ブラウザ (Chrome / Edge) のみ。

(function () {
  "use strict";

  if (window !== window.top) return;
  var ScriptEl = window.HTMLScriptElement;
  if (!ScriptEl || !ScriptEl.supports || !ScriptEl.supports("speculationrules")) return;

  var RULES = {
    prerender: [{
      where: {
        and: [
          { href_matches: "/portal/site/*" },
          { selector_matches: "#portal-nav-sidebar a, #kulms-top-favbar a" },
          { not: { selector_matches: "[target], [download], [onclick]" } },
          { not: { href_matches: { pathname: "/portal/site/*", search: "*sakai_action*" } } }
        ]
      },
      // moderate: 約 200ms ホバー (タッチ端末ではタッチ開始) で先読み
      eagerness: "moderate"
    }]
  };

  window.__kulmsSettingsReady.then(function (s) {
    if (s.linkPrerender === false) return;
    var script = document.createElement("script");
    script.type = "speculationrules";
    script.id = "kulms-speculation-rules";
    script.textContent = JSON.stringify(RULES);
    document.head.appendChild(script);
  });
})();
