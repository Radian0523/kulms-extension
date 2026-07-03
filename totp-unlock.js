// === KULMS+ WebAuthn(PRF) 生体認証ページ ===
// action=enroll : 生体認証(Windows Hello / Touch ID)を登録し、PRF 出力で DEK をラップ
// action=unlock : 登録済みクレデンシャルで PRF 出力を得て DEK をアンロック
//
// 儀式(navigator.credentials.create/get)はユーザー操作(クリック)を起点に実行する。
// action ポップアップだと Hello のシステムダイアログにフォーカスを奪われて閉じるため、
// このページは別ウィンドウ(chrome.windows.create)で開かれる前提。

(function () {
  "use strict";

  function t(key, fallback) {
    try {
      var m = chrome.i18n.getMessage(key);
      if (m) return m;
    } catch (e) {
      /* noop */
    }
    return fallback;
  }

  function abToB64(buf) {
    var b = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function b64ToBytes(b64) {
    return Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
  }

  function sendMsg(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  var titleEl = document.getElementById("title");
  var descEl = document.getElementById("desc");
  var runBtn = document.getElementById("run-btn");
  var closeBtn = document.getElementById("close-btn");
  var statusEl = document.getElementById("status");

  var params = new URLSearchParams(location.search);
  var action = params.get("action") === "enroll" ? "enroll" : "unlock";

  titleEl.textContent = t("extName", "KULMS+");
  descEl.textContent =
    action === "enroll"
      ? t("waEnrollDesc", "生体認証（Windows Hello / Touch ID）をこの端末に登録します。認証してください。")
      : t("waUnlockDesc", "生体認証（Windows Hello / Touch ID）でロックを解除します。認証してください。");
  runBtn.textContent = t("waAuthenticate", "認証する");
  closeBtn.textContent = t("waClose", "閉じる");

  closeBtn.addEventListener("click", function () { window.close(); });

  function showError(msgKey, fallback) {
    statusEl.textContent = t(msgKey, fallback);
    statusEl.className = "err";
    runBtn.style.display = "none";
    closeBtn.style.display = "";
  }
  function showOk() {
    statusEl.textContent = t("waDone", "完了しました。このウィンドウは自動的に閉じます。");
    statusEl.className = "ok";
    runBtn.style.display = "none";
  }

  // PRF 出力を get() で取得する（create で results が返らない環境向けの共通経路）
  async function evalPrf(credIdBuf, prfSalt) {
    var challenge = crypto.getRandomValues(new Uint8Array(32));
    var assertion = await navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        allowCredentials: [{ type: "public-key", id: credIdBuf }],
        userVerification: "required",
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    var ext = assertion.getClientExtensionResults();
    if (!ext || !ext.prf || !ext.prf.results || !ext.prf.results.first) {
      throw new Error("PRF_NO_RESULT");
    }
    return ext.prf.results.first;
  }

  async function enroll() {
    var prfSalt = crypto.getRandomValues(new Uint8Array(32));
    var userId = crypto.getRandomValues(new Uint8Array(16));
    var challenge = crypto.getRandomValues(new Uint8Array(32));
    var cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: "KULMS+" }, // id は省略 → 拡張オリジンが既定になる
        user: { id: userId, name: "KULMS+ TOTP", displayName: "KULMS+ TOTP" },
        challenge: challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "preferred",
          userVerification: "required",
        },
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    var ext = cred.getClientExtensionResults();
    if (!ext || !ext.prf || ext.prf.enabled === false) {
      throw new Error("PRF_UNSUPPORTED");
    }
    var prfOut = ext.prf.results && ext.prf.results.first;
    var credId = cred.rawId;
    if (!prfOut) {
      // create で PRF 出力が返らない環境: get() で取得
      prfOut = await evalPrf(credId, prfSalt);
    }
    var r = await sendMsg({
      type: "kulms-totp-webauthn-add",
      prfOutput: abToB64(prfOut),
      credentialId: abToB64(credId),
      prfSalt: abToB64(prfSalt),
    });
    if (!r || !r.ok) throw new Error(r && r.error === "locked" ? "LOCKED" : "ADD_FAILED");
  }

  async function unlock() {
    var info = await sendMsg({ type: "kulms-totp-get-webauthn" });
    if (!info || !info.hasWebauthn) throw new Error("NO_WEBAUTHN");
    var credId = b64ToBytes(info.credentialId);
    var prfSalt = b64ToBytes(info.prfSalt);
    var prfOut = await evalPrf(credId, prfSalt);
    var r = await sendMsg({ type: "kulms-totp-webauthn-unlock", prfOutput: abToB64(prfOut) });
    if (!r || !r.ok) throw new Error("UNLOCK_FAILED");
  }

  function mapError(e) {
    var name = (e && e.name) || "";
    var msg = (e && e.message) || "";
    if (name === "NotAllowedError") return ["waErrCancelled", "認証がキャンセルされました。もう一度お試しください。"];
    if (msg === "PRF_UNSUPPORTED") return ["waErrPrfUnsupported", "この端末/ブラウザは生体認証（PRF）に対応していません。パスフレーズをご利用ください。"];
    if (msg === "LOCKED") return ["waErrLocked", "先にパスフレーズでアンロックしてから登録してください。"];
    if (msg === "NO_WEBAUTHN") return ["waErrNoWebauthn", "生体認証が登録されていません。"];
    if (name === "NotSupportedError" || name === "SecurityError") return ["waErrUnavailable", "この環境では生体認証を利用できません。パスフレーズをご利用ください。"];
    return ["waErrGeneric", "認証に失敗しました。もう一度お試しください。"];
  }

  async function run() {
    runBtn.disabled = true;
    statusEl.textContent = "";
    statusEl.className = "";
    try {
      if (action === "enroll") await enroll();
      else await unlock();
      showOk();
      setTimeout(function () { window.close(); }, 1200);
    } catch (e) {
      var m = mapError(e);
      showError(m[0], m[1]);
    }
  }

  if (!window.PublicKeyCredential || !navigator.credentials || !navigator.credentials.create) {
    showError("waErrUnavailable", "この環境では生体認証を利用できません。パスフレーズをご利用ください。");
  } else {
    runBtn.addEventListener("click", run);
  }
})();
