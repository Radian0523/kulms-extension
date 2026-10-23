// KULMS+ のサイト（docs/）のスクリプト。
// CSP（script-src 'self'）と Trusted Types（require-trusted-types-for 'script'）の
// 下で動くよう、HTML を文字列で組み立てず、DOM の API だけを使う。

(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // タブ（トップページの更新履歴、2 段階認証のページの手順）。
  // WAI-ARIA の tabs のパターンに従い、クリックのほか矢印キー、Home、End でも選べる
  document.querySelectorAll(".tabs").forEach(function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll(".tab"));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute("aria-selected", selected ? "true" : "false");
        t.tabIndex = selected ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !selected;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        select(tab, false);
      });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (next) {
          e.preventDefault();
          select(next, true);
        }
      });
    });
  });

  // 機能のカルーセル
  var carousel = document.getElementById("carousel");
  var dots = document.getElementById("dots");
  if (carousel && dots) {
    var slides = carousel.querySelectorAll(".slide");
    var n = slides.length;
    var current = 0;
    for (var i = 0; i < n; i++) {
      var dot = document.createElement("button");
      dot.type = "button";
      dot.className = "dot";
      dot.setAttribute("aria-label", "スライド " + (i + 1) + " / " + n);
      dot.setAttribute("aria-current", i === 0 ? "true" : "false");
      dot.dataset.index = String(i);
      dots.appendChild(dot);
    }
    var allDots = dots.querySelectorAll(".dot");

    // スライド i を表示するときの横のスクロール位置
    var leftOf = function (i) {
      return slides[i].offsetLeft - slides[0].offsetLeft;
    };
    var mark = function (index) {
      current = index;
      allDots.forEach(function (d, j) {
        d.setAttribute("aria-current", j === index ? "true" : "false");
      });
    };
    // いまのスクロール位置にいちばん近いスライド
    var nearest = function () {
      var x = carousel.scrollLeft;
      var best = 0;
      for (var j = 1; j < n; j++) {
        if (Math.abs(leftOf(j) - x) < Math.abs(leftOf(best) - x)) best = j;
      }
      return best;
    };
    // ボタンや点で選んだスライド（無ければ -1）。そこへのスクロールが止まるまでは、
    // 途中のスクロール位置で現在のスライドを決め直さない。決め直すと、続けて
    // 押したボタンが同じスライドを指し、押した回数だけ進まない
    var target = -1;
    var show = function (index) {
      mark(index);
      var left = leftOf(index);
      // 動かないときは scroll も scrollend も起きないので、目標を残さない
      target = Math.abs(carousel.scrollLeft - left) < 1 ? -1 : index;
      carousel.scrollTo({ left: left, behavior: reducedMotion ? "auto" : "smooth" });
    };
    // 最後に位置を合わせたときのカルーセルの幅。幅が変わってから ResizeObserver が
    // 位置を合わせ直すまでのスクロール位置は古いレイアウトでの位置なので、それで
    // 現在のスライドを決め直さない（大きさが変わると、合わせ直す前に scroll が
    // 起きるブラウザーがあり、別のスライドに合わせ直してしまう）
    var hasResizeObserver = "ResizeObserver" in window;
    var alignedWidth = carousel.clientWidth;
    var aligned = function () {
      return !hasResizeObserver || carousel.clientWidth === alignedWidth;
    };
    // スクロールが止まったら、止まった位置のスライドを現在のスライドとする
    var settle = function () {
      target = -1;
      if (aligned()) mark(nearest());
    };

    var ticking = false;
    var settleTimer = 0;
    var hasScrollEnd = "onscrollend" in window;
    carousel.addEventListener("scroll", function () {
      // scrollend の無いブラウザーでは、scroll が 150 ms 途絶えたら止まったとみなす
      if (!hasScrollEnd) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, 150);
      }
      if (target >= 0 || ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        if (target < 0 && aligned()) mark(nearest());
      });
    });
    if (hasScrollEnd) carousel.addEventListener("scrollend", settle);
    // 利用者が自分でスクロールし始めたら、ボタンや点で選んだ目標は捨てる
    ["pointerdown", "wheel", "keydown"].forEach(function (type) {
      carousel.addEventListener(type, function () {
        target = -1;
      }, { passive: true });
    });
    dots.addEventListener("click", function (e) {
      var clicked = e.target.closest(".dot");
      if (clicked) show(Number(clicked.dataset.index));
    });
    document.getElementById("prev").addEventListener("click", function () {
      show(Math.max(0, current - 1));
    });
    document.getElementById("next").addEventListener("click", function () {
      show(Math.min(n - 1, current + 1));
    });
    // 画面の大きさが変わると、スライドの幅もスクロールの位置の意味も変わる。
    // 大きさが変わるたびに、見ていたスライドに位置を合わせ直す
    if (hasResizeObserver) {
      new ResizeObserver(function () {
        alignedWidth = carousel.clientWidth;
        carousel.scrollTo({ left: leftOf(current), behavior: "auto" });
      }).observe(carousel);
    }
  }

  // スクロールで現れる節。読み込んだ時点で画面の外にある節だけを隠し、
  // 少しでも画面に入ったら現す。画面に入っている節は隠さないので、
  // どの大きさの画面でも内容が隠れたままになることはない
  if (!reducedMotion && "IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.remove("reveal-pending");
        observer.unobserve(entry.target);
      });
    });
    document.querySelectorAll(".reveal").forEach(function (section) {
      var r = section.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight) return;
      section.querySelectorAll(".downloads > .btn, .release").forEach(function (child, j) {
        child.classList.add("reveal-child");
        child.style.transitionDelay = Math.min(j, 8) * 0.08 + "s";
      });
      section.classList.add("reveal-pending");
      observer.observe(section);
    });
  }
})();
