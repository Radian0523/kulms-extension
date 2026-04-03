// KULMS Background Service Worker

// ファイル変更の自動リロード (開発用)
const RELOAD_INTERVAL_MS = 1000;

let lastReloadTime = Date.now();

async function checkForUpdates() {
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    if (response.ok) {
      // self.location.href へのfetchでキャッシュバスト
      // 拡張機能が再読み込みされたらタイムスタンプが変わる
    }
  } catch (e) {
    // ignore
  }
}

// 開発中のデバッグ用ログ
chrome.runtime.onInstalled.addListener(() => {
  console.log("[KULMS Extension] installed/updated");
});
