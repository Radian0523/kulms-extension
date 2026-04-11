# KULMS+ 開発ドキュメント

## 概要

KULMS+は、京都大学のSakai LMS (KULMS) のUIを拡張するChrome拡張機能。公式APIが限定的な環境で、DOM操作・非公開API・CSSオーバーライドを組み合わせて多数の機能（個別設定可能）を実現している。

## 技術スタック

| 技術 | 用途 |
|------|------|
| **Chrome Manifest V3** | 拡張機能基盤。Service Worker + Content Script構成 |
| **Vanilla JavaScript (ES5/ES6混在)** | フレームワーク不使用。IIFE (即時実行関数式) で機能を分離 |
| **Sakai Direct API** | `/direct/site.json`, `/direct/assignment/site/{id}.json`, `/direct/sam_pub/context/{id}.json` で課題・クイズデータ取得 |
| **chrome.storage API** | 設定・キャッシュ・メモ・チェック状態・削除済み状態の永続化 |
| **chrome.i18n API** | 多言語対応（日本語/英語）。言語上書き機能付き |
| **CSS Custom Properties** | 緊急度カラーのカスタマイズ (`--kulms-color-danger` 等) |
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
src/
├── settings.js          # 設定読み込み (共有Promise: window.__kulmsSettingsReady) + i18nヘルパー
├── assignments.js       # IIFE: 課題一覧パネル ★メイン機能
│   ├── Sakai API通信層 (sakaiGet, getCourses, fetchAssignments, fetchQuizzes)
│   ├── キャッシュ層 (chrome.storage, TTL 30分)
│   ├── 状態管理層 (checked, dismissed, memos)
│   ├── UI層 (パネル, カード, セクション, メモ, 削除済み)
│   ├── 設定UI (グループ化セクション、閾値、カラーピッカー)
│   └── サイドバー連携 (色分け, バッジ, スタイル注入)
├── submit-detect.js     # IIFE: 提出ボタン検出
├── tree-view.js         # IIFE: 授業資料ツリービュー
├── course-name.js       # IIFE: 科目名整理 + ピン留めソート
├── course-click.js      # IIFE: コース行クリック
├── tool-visibility.js   # IIFE: ツール表示管理
├── textbooks.js         # IIFE: 教科書パネル (background.jsと連携)
└── sidebar-resize.js    # IIFE: サイドバーリサイズ
```

Manifest V3の `content_scripts.js` 配列で上記の順序通り注入される。各ファイルはIIFE（即時実行関数式）で機能を分離しており、`settings.js` で定義されるグローバル変数（`window.__kulmsSettingsReady`, `t()` 関数）を共有インターフェースとして疎結合を実現している。

### データフロー

```
Sakai API → fetchAllAssignments() → saveCache() → chrome.storage
             fetchQuizzesForCourse()
                                   → renderAssignments() → DOM
                                   → colorSidebarTabs() → サイドバーDOM
                                   → checkNotificationBadges() → サイドバーDOM

ページ読み込み時:
chrome.storage → loadCache() → colorSidebarTabs() (パネルを開かなくても色分け適用)
```

### 状態管理

| ストレージキー | 内容 |
|----------------|------|
| `kulms-settings` | 全設定値 (機能ON/OFF、閾値、色、言語) |
| `kulms-assignments` | 課題キャッシュ (TTL 30分) |
| `kulms-checked-assignments` | チェック済み状態 (`{ entityId: timestamp }`) |
| `kulms-dismissed-assignments` | 削除済み状態 (`{ key: { dismissedAt, name, ... } }`)。30日で自動パージ |
| `kulms-memos` | メモ一覧 (`[{ id, text, courseId, deadline, ... }]`) |
| `kulms-prev-assignment-ids` | 前回取得の課題ID一覧 (新着バッジ用) |

### i18n (多言語対応)

Chrome拡張の `chrome.i18n.getMessage()` はブラウザのロケールに従い、実行時に変更できない。ユーザーが設定から言語を上書きできるよう、独自の仕組みを実装:

```javascript
var __kulmsOverrideMessages = null;

function t(key, substitutions) {
  // 1. 上書き辞書があればそちらを使用
  if (__kulmsOverrideMessages && __kulmsOverrideMessages[key]) {
    // プレースホルダー置換を手動で実行
    ...
  }
  // 2. フォールバック: chrome.i18n.getMessage()
  return chrome.i18n.getMessage(key, substitutions) || key;
}

async function loadOverrideMessages(lang) {
  if (lang === "auto") { __kulmsOverrideMessages = null; return; }
  // chrome.runtime.getURL() でローカルJSONを取得
  var url = chrome.runtime.getURL("_locales/" + lang + "/messages.json");
  var resp = await fetch(url);
  __kulmsOverrideMessages = await resp.json();
}
```

### 削除済み (dismiss) システム

削除されたアイテムは即座に消えず「削除済み」セクションに移動する:

1. **削除操作**: 2クリック確認パターン（1回目: 「削除しますか？」表示、3秒で自動リセット。2回目: 実行）
2. **保存**: `dismissedState` にアイテム情報とタイムスタンプを保存
3. **表示**: 「削除済み」セクション（デフォルト折りたたみ）に打ち消し線で表示
4. **復元**: 「元に戻す」ボタンでワンクリック復元
5. **自動パージ**: `loadDismissedState()` 時に30日超のエントリを自動削除。メモの場合は `memos` 配列からも完全削除

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
    if (val.epochSecond) return val.epochSecond * 1000;
    if (val.time) return val.time;
  }
  if (typeof val === "string") {
    var n = Number(val);
    return isNaN(n) ? null : n;
  }
  return null;
}
```

### 2. 課題リンクのポータル内遷移

**問題**: Sakai APIの `entityURL` は `/direct/assignment/{id}` というAPI直接リンクを返す。これをクリックするとJSON画面や概要ページに飛んでしまい、ユーザーが期待する課題ページに到達しない。

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

### 3. CSS詳細度の戦い

**問題**: Sakaiの選択中科目に適用される青背景を除去したかったが、拡張機能のCSSファイル (`styles.css`) からの `!important` 指定が効かなかった。

**原因**: SakaiのCSSセレクタは非常に高い詳細度を持ち、Chrome拡張のContent Script CSSは読み込み順序により負けていた。

**解決策**: Content Scriptから `<style>` タグをDOMに直接注入する方式に切り替え。これによりSakaiのCSSより後に読み込まれることが保証され、同じ詳細度 + `!important` で確実にオーバーライドできる。

### 4. サイドバーのURL形式の不一致

**問題**: サイドバーの色分け機能が動作しなかった。

**原因**: コードは `/portal/site/` でリンクを検索していたが、実際のリンクは `/portal/site-reset/{siteId}` 形式だった。

**解決策**: セレクタとregexを修正して `/portal/site` と `/portal/site-reset/` の両方に対応。

### 5. タブ切り替え時のUI汚染

**問題**: 教科書タブでデータ取得中に課題タブに切り替えると、「取得中...」のテキストが課題タブに表示された。

**原因**: 教科書IIFEと課題IIFEが同じ `contentEl` DOM要素を共有していた。

**解決策**: `currentView` ガードを追加し、現在のビューと異なるタブからのDOM更新をブロック。

### 6. チェック状態のキー安定性

**問題**: チェック済み課題の識別に `courseId:name` を使用していたが、課題名が変更されるとチェック状態が失われた。

**解決策**: Sakai APIの `entityId` をプライマリキーとして使用し、`courseId:name` はフォールバックとして維持。既存データは `migrateCheckedKeys()` で自動移行。

### 7. 一覧APIの提出状態が不正確

**問題**: `/direct/assignment/site/{siteId}.json`（一覧API）から取得した `submissions[0]` の提出状態が、実際に提出済みの課題でも `userSubmission: false`、`dateSubmittedEpochSeconds: 0`、`status: "未開始"` を返す。一方 `submitted: true` は全課題で常に `true` であり、提出判定に使えない。

**調査**: 個別API `/direct/assignment/item/{assignmentId}.json` で同じ課題を取得したところ、正確な提出状態が返ることを確認:

| フィールド | 一覧API (site) | 個別API (item) |
|---|---|---|
| `userSubmission` | `false` | `true` |
| `dateSubmittedEpochSeconds` | `0` | `1775813377` |
| `submittedAttachments` | `[]` | `[課題1.pdf.pdf]` |
| `status` | `"未開始"` | `"提出済み 2026/04/10 18:29"` |

**解決策**: 一覧APIで課題ID一覧を取得後、各課題の個別APIを `Promise.allSettled` で並列取得し、正確な提出状態を使用。個別APIが失敗した場合は一覧APIのデータにフォールバック。

### 8. i18n関数名の衝突

**問題**: ツール表示管理IIFEの `forEach` コールバックパラメータ名 `t` がグローバルの `t()` i18n関数をシャドウイングし、翻訳が機能しなかった。

**解決策**: コールバックパラメータ名を `li` にリネームして衝突を解消。

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

各コースの課題・クイズ取得を4並列 (`CONCURRENT_LIMIT = 4`) に制限:

```javascript
for (let i = 0; i < courses.length; i += CONCURRENT_LIMIT) {
  const batch = courses.slice(i, i + CONCURRENT_LIMIT);
  const results = await Promise.allSettled(
    batch.flatMap((c) => [
      fetchAssignmentsForCourse(c, toolMap),
      fetchQuizzesForCourse(c, toolMap)
    ])
  );
}
```

`Promise.allSettled` を使用することで、一部のコースでAPI失敗が発生しても他のコースのデータは正常に取得・表示される。

## 設定システム

機能を個別にオン/オフ可能な設定システム。グループ化されたUIで管理:

```javascript
window.__kulmsSettingsReady = new Promise(function (resolve) {
  var DEFAULTS = {
    textbooks: true, tabColoring: true,
    dangerHours: 24, warningDays: 5, successDays: 14,
    colorDanger: "#e85555", colorWarning: "#d7aa57",
    colorSuccess: "#62b665", colorOther: "#777777",
    language: "auto",
    /* 他はfalse */
  };
  chrome.storage.local.get("kulms-settings", function (result) {
    window.__kulmsSettings = Object.assign({}, DEFAULTS, saved);
    loadOverrideMessages(window.__kulmsSettings.language).then(function () {
      resolve(window.__kulmsSettings);
    });
  });
});
```

設定UIはグループ化:

| セクション | 内容 |
|------------|------|
| 外観 | 言語 |
| パネル | 教科書パネル、メモ機能、パネル押し出し |
| サイドバー | タブ色分け、色分けスタイル (border/background/bold)、新着バッジ、科目名整理、ピンソート、行クリック、ツール管理、リサイズ、スタイル |
| コースページ | ツリービュー |
| 課題更新 | 自動更新間隔 |
| 緊急度カスタマイズ | 閾値（時間/日）、カラーピッカー |
| 開発者 | プレビューモード |

## 対応環境

- **LMS**: Sakai (京都大学KULMS)
- **ブラウザ**: Google Chrome (Manifest V3)
- **フレーム対応**: `all_frames: true` で全iframe内でも実行。`window !== window.top` ガードでトップフレーム限定機能を制御
- **言語**: 日本語 / 英語 (ブラウザ設定に連動、手動切り替え可)
