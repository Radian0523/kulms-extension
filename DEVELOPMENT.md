# KULMS+ 開発ドキュメント

## 概要

KULMS+は、京都大学のSakai LMS (KULMS) のUIを拡張するChrome拡張機能。公式APIが限定的な環境で、DOM操作・非公開API・CSSオーバーライドを組み合わせて15の機能（うち13機能を個別設定可能）を実現している。

## 技術スタック

| 技術 | 用途 |
|------|------|
| **Chrome Manifest V3** | 拡張機能基盤。Service Worker + Content Script構成 |
| **Vanilla JavaScript (ES5/ES6混在)** | フレームワーク不使用。IIFE (即時実行関数式) で機能を分離 |
| **Sakai Direct API** | `/direct/site.json`, `/direct/assignment/site/{id}.json` で課題データ取得 |
| **chrome.storage API** | 設定・キャッシュ・メモ・チェック状態の永続化 |
| **DOM Injection** | `<style>` タグの動的注入によるCSS詳細度の制御 |

### フレームワークを使わない判断

Content Scriptとしてページに注入される性質上、React/Vueなどのフレームワークは以下の理由で不採用とした:
- ページのDOMと直接やり取りする必要がある（サイドバー操作、ツール表示管理など）
- バンドルサイズを最小化したい（ユーザーの全ページロードに影響）
- ビルドステップなしで開発・デバッグできる利点
- LMSの既存CSSとの共存にフレームワークのスコープ管理は過剰

代わりにIIFEパターンで各機能を分離し、`window.__kulmsSettings` を共有インターフェースとして機能間の疎結合を実現した。

## アーキテクチャ

### Content Script構成

```
content.js
├── 設定読み込み (共有Promise: window.__kulmsSettingsReady)
├── IIFE: テーマ切り替え
├── IIFE: 課題一覧パネル ★メイン機能
│   ├── Sakai API通信層 (sakaiGet, getCourses, fetchAssignments)
│   ├── キャッシュ層 (chrome.storage, TTL 30分)
│   ├── UI層 (パネル, カード, セクション, メモ)
│   └── サイドバー連携 (色分け, バッジ, スタイル注入)
├── IIFE: 授業資料ツリービュー
├── IIFE: 科目名整理 + ピン留めソート
├── IIFE: コース行クリック
├── IIFE: ツール表示管理
├── IIFE: サイドバーリサイズ
└── IIFE: 教科書パネル (background.jsと連携)
```

### データフロー

```
Sakai API → fetchAllAssignments() → saveCache() → chrome.storage
                                   → renderAssignments() → DOM
                                   → colorSidebarTabs() → サイドバーDOM
                                   → checkNotificationBadges() → サイドバーDOM

ページ読み込み時:
chrome.storage → loadCache() → colorSidebarTabs() (パネルを開かなくても色分け適用)
```

## 直面した技術的課題と解決策

### 1. Sakaiのタイムスタンプ形式が不統一

**問題**: Sakai APIが返す日時データの形式が一定でなく、課題の締切日が取得できない場合があった。

**調査**: Chrome DevToolsで実際のAPIレスポンスを確認したところ、以下の3パターンが存在した:

```javascript
// パターン1: ミリ秒のnumber
"dueTime": 1776844800000

// パターン2: Java Instantオブジェクト（これが最も多かった）
"dueTime": { "epochSecond": 1776844800, "nano": 0 }

// パターン3: ミリ秒の入れ子オブジェクト
"dueTime": { "time": 1776844800000 }
```

**解決策**: 全形式に対応するパーサーを実装:

```javascript
function extractTimestamp(val) {
  if (!val) return null;
  if (typeof val === "number") return val;
  if (typeof val === "object") {
    if (val.epochSecond) return val.epochSecond * 1000;  // 秒→ミリ秒変換
    if (val.time) return val.time;
  }
  if (typeof val === "string") {
    var n = Number(val);
    return isNaN(n) ? null : n;
  }
  return null;
}
```

**学び**: 外部APIは仕様書通りとは限らない。実データの検証が不可欠。

### 2. 課題リンクのポータル内遷移

**問題**: Sakai APIの `entityURL` は `/direct/assignment/{id}` というAPI直接リンクを返す。これをクリックするとJSON画面や概要ページに飛んでしまい、ユーザーが期待する課題ページに到達しない。

**調査**: サイドバーの「課題」リンクは `/portal/site/{siteId}/tool/{toolId}` という形式で、これがユーザーの期待する遷移先だった。

**解決策**: サイドバーのDOMから各コースの課題ツールURLを抽出するマッピング関数を実装:

```javascript
function buildAssignmentToolMap() {
  var map = {};
  document.querySelectorAll(".nav-item a").forEach(function (a) {
    if (!a.textContent.trim().match(/^課題/)) return;
    var match = a.href.match(/\/portal\/site\/([^\/?#]+)\/tool\//);
    if (match) map[match[1]] = a.href;
  });
  return map;
}
```

さらに、キャッシュされた課題データのURLも古いままになる問題があったため、キャッシュ読み込み時にもURLを最新のポータルURLに差し替える処理を追加した。

**学び**: APIのレスポンスとユーザーの期待する動線は異なることがある。DOM情報との組み合わせで補完するアプローチが有効。

### 3. CSS詳細度の戦い

**問題**: Sakaiの選択中科目に適用される青背景を除去したかったが、拡張機能のCSSファイル (`styles.css`) からの `!important` 指定が効かなかった。

**原因**: Sakaiのセレクタは `#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head` と非常に高い詳細度を持っていた。Chrome拡張のContent Script CSSは通常のauthor stylesheetとして扱われるが、読み込み順序によりSakai側のルールが後勝ちしていた。

**解決策**: Content Scriptから `<style>` タグをDOMに直接注入する方式に切り替え:

```javascript
(function injectSidebarOverride() {
  var style = document.createElement("style");
  style.textContent =
    "#portal-nav-sidebar li.site-list-item.is-current-site .site-list-item-head " +
    "{ background-color: transparent !important; }";
  document.head.appendChild(style);
})();
```

これによりSakaiのCSSより後に読み込まれることが保証され、同じ詳細度 + `!important` で確実にオーバーライドできるようになった。

**学び**: Content Script CSSの読み込み順序は保証されない。確実にオーバーライドしたい場合はDOM注入が有効。

### 4. サイドバーのURL形式の不一致

**問題**: サイドバーの色分け機能 (`colorSidebarTabs`) が動作しなかった。

**原因**: コードは `a[href*="/portal/site/"]` でサイドバーのリンクを検索していたが、実際のサイドバーリンクは `/portal/site-reset/{siteId}` という形式を使用していた。`/portal/site/` は `/portal/site-reset/` の部分文字列ではない（`site/` vs `site-reset/`）。

**解決策**: セレクタとregexを修正:

```javascript
// Before
var link = li.querySelector('a[href*="/portal/site/"]');
var match = link.href.match(/\/portal\/site\/([^\/?#]+)/);

// After
var link = li.querySelector('a[href*="/portal/site"]');
var match = link.href.match(/\/portal\/site(?:-reset)?\/([^\/?#]+)/);
```

**学び**: URLのパターンマッチは部分文字列の境界に注意。実際のDOMを検証してからセレクタを書くべき。

### 5. タブ切り替え時のUI汚染

**問題**: 教科書タブでデータ取得中に課題タブに切り替えると、「取得中...」のテキストが課題タブに表示されてしまう。

**原因**: 教科書IIFEと課題IIFEが同じ `contentEl` DOM要素を共有しており、非同期処理の完了タイミングで他方のビューが汚染された。

**解決策**:
1. 教科書APIに `detach()` メソッドを追加し、タブ切り替え時に進行中の処理を中断
2. 課題側の `renderAssignments`, `showLoading`, `showError` に `currentView` ガードを追加:

```javascript
function showLoading(done, total) {
  if (currentView !== "assignments") return;  // ガード
  // ...
}
```

**学び**: 共有DOM要素を複数の非同期処理が操作する場合、状態管理（現在のビュー）によるガードが必要。

### 6. 選択中科目の視覚デザイン

**問題**: Sakaiデフォルトの選択中スタイル（青背景 + 白文字 + 太字拡大）を除去した後、選択状態が識別できなくなった。加えて、課題の緊急度を示す背景色と選択状態の青背景が競合していた。

**設計過程**: 複数のアプローチを検討した:
- 背景色ベタ塗り → 選択状態の青と緊急度の色が混在して視認性が悪い
- ドット表示 → 情報量が少なすぎる
- **左ボーダー方式** → 選択状態(灰色3px) と緊急度(色付き4px) を同じ視覚言語で表現でき、背景を塗らないためクリーン

**解決策**: 左ボーダー方式を採用。CSS詳細度の問題から、ボーダーの適用もDOM注入スタイルで行った。課題色がある場合は選択ボーダーを上書きし、課題情報を優先表示する。

## コース取得の3段階フォールバック

Sakai環境の不安定さに対応するため、コース一覧の取得に3段階のフォールバックを実装:

```
1. サイドバーDOM解析 (最速、ページ描画済みの場合)
   ↓ 失敗時
2. Sakai Direct API (/direct/site.json?_limit=200)
   ↓ 失敗時
3. ポータルHTMLのフェッチ・パース
```

## 並行リクエスト制御

各コースの課題取得を4並列 (`CONCURRENT_LIMIT = 4`) に制限:

```javascript
for (let i = 0; i < courses.length; i += CONCURRENT_LIMIT) {
  const batch = courses.slice(i, i + CONCURRENT_LIMIT);
  const results = await Promise.allSettled(
    batch.map((c) => fetchAssignmentsForCourse(c, toolMap))
  );
}
```

`Promise.allSettled` を使用することで、一部のコースでAPI失敗が発生しても他のコースのデータは正常に取得・表示される。

## 設定システム

15機能のうち13機能を個別にオン/オフ可能な設定システム（課題一覧・テーマは常時有効）:

```javascript
// 起動時にPromiseで設定を読み込み、全IIFEが参照可能に
window.__kulmsSettingsReady = new Promise(function (resolve) {
  var DEFAULTS = { textbooks: true, tabColoring: true, /* 他はfalse */ };
  chrome.storage.local.get("kulms-settings", function (result) {
    window.__kulmsSettings = Object.assign({}, DEFAULTS, saved);
    resolve(window.__kulmsSettings);
  });
});

// 各IIFEは設定読み込み完了後に初期化
window.__kulmsSettingsReady.then(function (s) {
  if (s.treeView === false) return;  // 機能無効時はスキップ
  initTreeView();
});
```

デフォルトONは教科書パネルと科目タブ色分けのみ。IIFE間で直接の依存関係を持たず、`window.__kulmsSettingsReady` Promiseのみを共有インターフェースとすることで、機能の追加・削除が容易なアーキテクチャになっている。

## 対応環境

- **LMS**: Sakai (京都大学KULMS)
- **ブラウザ**: Google Chrome (Manifest V3)
- **フレーム対応**: `all_frames: true` で全iframe内でも実行。`window !== window.top` ガードでトップフレーム限定機能を制御
