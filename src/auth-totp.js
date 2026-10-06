// === KULMS+ TOTP Auto-Fill ===
// /otplogin.cgi ページで TOTP コードを自動入力する。
// コードは background が暗号化ストアのシークレットから計算し、このページには
// コードだけを渡す（シークレットは渡さない）。

(function () {
  "use strict";

  function injectCode(code) {
    var passwordInput = document.getElementById("password_input");
    var loginForm = document.getElementById("login");
    if (passwordInput && loginForm) {
      passwordInput.value = code;
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
      loginForm.submit();
    }
  }

  // 無限ループ防止: OTP 失敗でページがリロードされた場合に
  // 連続して自動入力・送信し続けないようにする。
  // 同一 30 秒ウィンドウ内では 1 回だけ試行する。
  var TOTP_ATTEMPTED_KEY = "kulms-totp-attempted";
  var currentWindow = String(Math.floor(Date.now() / 1000 / 30));
  var lastAttempt = sessionStorage.getItem(TOTP_ATTEMPTED_KEY);
  if (lastAttempt === currentWindow) return; // この TOTP ウィンドウでは既に試行済み

  // メイン処理（background がその時のコードを計算して返す）
  chrome.runtime.sendMessage({ type: "kulms-totp-code" }, function (response) {
    var code = response && response.code;
    if (!code) return; // シークレット未設定 → 手動入力に委ねる
    sessionStorage.setItem(TOTP_ATTEMPTED_KEY, currentWindow);
    injectCode(code);
  });
})();
