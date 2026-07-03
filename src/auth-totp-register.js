// === KULMS+ TOTP Registration ===
// /user/index.php?app=qrsecret ページで TOTP シークレットを自動取得し、
// OTP を生成・入力して京大側の TOTP 登録を補助する。
// 登録完了後（「設定が完了しました」ページ）にシークレットを拡張機能に保存する。

(function () {
  "use strict";

  // === 登録完了ページの検知（URL チェックより先に行う） ===
  // フォーム送信後のリダイレクトで URL から app=qrsecret が落ちる場合があるため、
  // 「設定が完了しました」テキストの検知を最優先で行う。
  // 保留シークレットはページの sessionStorage には置かない（平文残留を避けるため）。
  // 代わりに background の chrome.storage.session（メモリのみ・端末外に出ない）へ
  // stash し、完了ページでは commit を送るだけにする（stash が無ければ background 側で no-op）。
  if (document.body.innerText.includes("設定が完了しました")) {
    chrome.runtime.sendMessage({ type: "kulms-totp-pending-commit" });
    console.log("[KULMS] TOTP registration: commit sent after successful registration");
    if (!location.search.includes("app=qrsecret")) return;
  }

  // qrsecret ページ以外では QR スキャン・OTP 生成を行わない
  if (!location.search.includes("app=qrsecret")) return;

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
    var counter = Math.floor(Date.now() / 1000 / 30);
    var counterBytes = new ArrayBuffer(8);
    var view = new DataView(counterBytes);
    view.setUint32(0, Math.floor(counter / 0x100000000), false);
    view.setUint32(4, counter & 0xffffffff, false);
    var cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
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

  // QR コードから otpauth URI を読み取り、secret を抽出する
  function scanQRFromPage() {
    if (typeof jsQR !== "function") return null;

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
        var result = jsQR(imageData.data, imageData.width, imageData.height);
        if (result && result.data && result.data.startsWith("otpauth://")) {
          try {
            var url = new URL(result.data);
            var secret = url.searchParams.get("secret");
            if (secret && /^[A-Z2-7=]+$/i.test(secret.replace(/[\s-]/g, ""))) {
              return secret.replace(/[\s-]/g, "").toUpperCase();
            }
          } catch (e) {
            // invalid URI
          }
        }
      } catch (e) {
        // cross-origin tainted canvas - skip
      }
    }
    return null;
  }

  // フォールバック: 「QRコードを読み込めない場合」リンクでシークレットテキストを取得
  function getSecretFromPageText() {
    var links = document.querySelectorAll("a");
    for (var i = 0; i < links.length; i++) {
      if (links[i].textContent.includes("QR") && links[i].href.includes("void")) {
        links[i].click();
        break;
      }
    }
    var match = document.body.innerText.match(
      /シークレット[:：\s]*([A-Za-z2-7=]+)/
    );
    if (match) return match[1].replace(/[\s-]/g, "").toUpperCase();
    return null;
  }

  async function run() {
    // 1. シークレット取得（QR スキャン → テキストフォールバック）
    var secret = scanQRFromPage();
    if (!secret) {
      secret = getSecretFromPageText();
    }
    if (!secret) {
      console.warn("[KULMS] TOTP registration: secret not found on page");
      return;
    }
    console.log("[KULMS] TOTP registration: secret obtained");

    // 2. シークレットを background の session（メモリのみ）に一時 stash する。
    //    登録完了ページで commit されるまで、ページの sessionStorage には残さない。
    chrome.runtime.sendMessage({ type: "kulms-totp-pending-set", secret: secret });

    // 3. TOTP コード生成
    var otp = await generateTOTP(secret);
    if (!otp) {
      console.warn("[KULMS] TOTP registration: failed to generate OTP");
      return;
    }
    console.log("[KULMS] TOTP registration: OTP generated");

    // 4. フォームに OTP を入力（送信はユーザーに委ねる）
    var input = document.querySelector('input[type="number"]');
    if (input) {
      input.value = otp;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  run();
})();
