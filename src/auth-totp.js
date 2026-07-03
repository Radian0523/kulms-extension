// === KULMS+ TOTP Auto-Fill ===
// /otplogin.cgi ページで TOTP コードを自動生成・入力する。

(function () {
  "use strict";

  var BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function base32Decode(input) {
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

  async function generateTOTP(secret) {
    var key = base32Decode(secret);
    if (!key) return null;

    // 現在の UNIX 時間を 30 秒ステップに変換
    var counter = Math.floor(Date.now() / 1000 / 30);
    var counterBytes = new ArrayBuffer(8);
    var view = new DataView(counterBytes);
    // DataView.setUint32 で上位・下位 32 ビットをセット
    view.setUint32(0, Math.floor(counter / 0x100000000), false);
    view.setUint32(4, counter & 0xffffffff, false);

    // HMAC-SHA1 (Web Crypto API)
    var cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    var hmacBuffer = await crypto.subtle.sign("HMAC", cryptoKey, counterBytes);
    var hmac = new Uint8Array(hmacBuffer);

    // Dynamic Truncation (RFC 4226)
    var offset = hmac[19] & 0x0f;
    var code =
      ((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3];
    var otp = code % 1000000;

    return String(otp).padStart(6, "0");
  }

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
  var TOTP_UNLOCK_OPENED_KEY = "kulms-totp-unlock-opened";
  var currentWindow = String(Math.floor(Date.now() / 1000 / 30));
  var lastAttempt = sessionStorage.getItem(TOTP_ATTEMPTED_KEY);

  function tryAutofill(secret) {
    if (sessionStorage.getItem(TOTP_ATTEMPTED_KEY) === currentWindow) return;
    generateTOTP(secret)
      .then(function (code) {
        if (code) {
          sessionStorage.setItem(TOTP_ATTEMPTED_KEY, currentWindow);
          injectCode(code);
        }
      })
      .catch(function () {
        // エラー時は手動入力に委ねる
      });
  }

  // 生体解錠の完了を待ってから自動入力する（~60秒であきらめる）。
  function pollUnlockThenFill() {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (tries > 40) {
        clearInterval(iv);
        return;
      }
      chrome.runtime.sendMessage({ type: "kulms-totp-load" }, function (resp) {
        var secret = resp && resp.secret;
        if (secret) {
          clearInterval(iv);
          tryAutofill(secret);
        }
      });
    }, 1500);
  }

  // メイン処理（background の暗号化ストア経由）
  chrome.runtime.sendMessage({ type: "kulms-totp-status" }, function (status) {
    if (!status || !status.exists) return; // 未設定 → 手動入力に委ねる

    if (status.locked) {
      // ロック中: 生体認証が登録済みなら自動で解錠フローへ。
      // (パスフレーズのみ等は popup での手動解錠に委ねる)
      if (status.methods && status.methods.webauthn) {
        if (sessionStorage.getItem(TOTP_UNLOCK_OPENED_KEY) === currentWindow) return;
        sessionStorage.setItem(TOTP_UNLOCK_OPENED_KEY, currentWindow);
        chrome.runtime.sendMessage({ type: "kulms-totp-open-unlock" });
        pollUnlockThenFill();
      }
      return;
    }

    // アンロック済み or auto モード → 取得して自動入力
    if (lastAttempt === currentWindow) return;
    chrome.runtime.sendMessage({ type: "kulms-totp-load" }, function (resp) {
      var secret = resp && resp.secret;
      if (secret) tryAutofill(secret);
    });
  });
})();
