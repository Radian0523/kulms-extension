# Sakai への通信とページ読み込み速度の調査

KULMS+ と公式 KULMS (Sakai) が、どんな通信を、いつ送っているかの調査メモ。
通信削減・高速化の判断材料として残す。

- 調査日: 2026-10-15
- 計測環境: Chrome (KULMS+ 導入済み)、ログイン済みの学生アカウント、履修 9 科目

## 結論

- **公式 KULMS 側の通信は、ほとんど減らせる余地がない。** 静的ファイルはほぼすべてブラウザのキャッシュから読まれ、ページを開いたままでも裏での定期通信はない。
- **遅さの原因は、サーバーが HTML を返し始めるまでの時間 (TTFB)。** ホーム 1.3 秒、各ページ 0.4〜0.5 秒。クライアント側からは縮められない。
- **Sakai への通信の大半は KULMS+ 自身が送っている。** 2 分ごとの課題更新が、タブごとに独立して走っている。

## 1. 公式 KULMS (Sakai) の通信

### ページごとの計測

`performance.getEntriesByType("navigation" / "resource")` で計測。
「サーバーへ取りに行った数」は `transferSize > 0` のもの (0 はブラウザキャッシュから読まれた)。

| ページ | TTFB | 読み込み完了 | ファイル数 | サーバーへ取りに行った数 |
|---|---|---|---|---|
| ホーム (`/portal`) | 1.3 秒 | 2.2 秒 | 93 | 17 (うち 10 件は翻訳データ) |
| 講義ページ (`/portal/site/{siteId}`) | 0.5 秒 | 1.5 秒 | 81 | 4 |
| 授業資料 (`/portal/site/{siteId}/tool/{toolId}`) | 0.4 秒 | 0.9 秒 | 84 | 3 |

- ホームが遅いのは、ダッシュボードの各ウィジェットが iframe (`/portal/tool/{uuid}?panel=Main`) で 4〜5 個読み込まれるため。

### 毎回サーバーへ取りに行っているもの

| URL | いつ | キャッシュ指示 | 備考 |
|---|---|---|---|
| `/sakai-ws/rest/i18n/getI18nProperties` | ホームで 10 件 | なし | 翻訳データ。1 件約 20ms、ほぼ同時に送られる |
| `/profile2-tool/javascript/profile2-eb.js` | 毎ページ | なし | 1KB |
| `/api/users/me/notifications` | 毎ページ | — | ベルの通知一覧 (約 11KB)。消すと通知が遅れるので触らない |
| `/direct/userPrefs/key/{userId}/resourcesColumn.json` | 授業資料ページ | — | 表の列設定 |

`getI18nProperties` と `profile2-eb.js` は、拡張機能の `declarativeNetRequest` でレスポンスヘッダーの `Cache-Control` を書き換えればキャッシュさせられる。ただし体感はほぼ変わらない。

### キャッシュ設定

| パス | `Cache-Control` | URL のバージョン | 状態 |
|---|---|---|---|
| `/library/...` (JS / CSS) | `max-age=2678400, public` (31 日) | `?version=` あり | 最適 |
| `/webcomponents/bundles/...` | なし (`Last-Modified` のみ) | `?version=` あり | ブラウザのヒューリスティックでキャッシュされている |
| `/portal` (HTML) | `no-store, no-cache, must-revalidate` | — | 毎回サーバーで生成 |

### 定期通信

ホームを開いたまま 2 分間放置して観察したところ、**Sakai 本体からの通信は 0 件**。
presence や通知のポーリングは行われていない。

## 2. KULMS+ の通信

### 一覧

| いつ | 何を送るか | 件数 | 該当コード |
|---|---|---|---|
| **全タブで 2 分ごと** (表示中のタブのみ) | 課題一覧の全取得 | 下記 | `assignments.js` の `init` 内 `setInterval` |
| パネルを開いたタブに戻るたび | 課題一覧の全取得 (キャッシュを見ない) | 下記 | `assignments.js` の `visibilitychange` |
| パネルを開く / 課題タブに切り替え | キャッシュが期限内なら 0、切れていれば全取得 | 下記 | `loadAssignments(false)` |
| 🔄 / 提出直後 / ポップアップの更新 | 課題一覧の全取得 | 下記 | `loadAssignments(true)` |
| 授業資料ページ表示 | `doExpandall` (POST) | 1 (全展開済みなら 0) | `tree-view.js` |
| リンクにマウスを約 200ms 乗せる | ページの先読み (prerender) | 1 | `prerender.js` |
| 教科書タブ (学期に 1 回) | サイト一覧 + 科目ごとの担当教員 | 1 + 科目数 × 2 | `textbooks.js`, `background.js` |
| TA の採点画面 | 提出一覧 HTML | 数件 | `grading-ta.js` |

### 課題一覧の全取得 (`fetchAllAssignments`) の内訳

サイドバーの科目数を N とすると:

| API | 件数 |
|---|---|
| `/direct/assignment/site/{siteId}.json` | N |
| `/direct/sam_pub/context/{siteId}.json` | N |
| `/direct/site/{siteId}/pages.json` (課題ツール URL 調べ) | 最大 N (サイドバーで展開していない科目すべて) |
| `/direct/assignment/item/{assignmentId}.json` (正確な提出状態) | 課題の総数 |

- 実測: 9 科目で 2 分間に 28 件。
- 例: 20 科目・課題 100 件なら 1 回で約 160 件。これを開いているタブ数だけ繰り返す。
- 科目ではない `!gateway` サイトも対象に入っており、`/direct/site/!gateway/pages.json` が毎回 **403** で失敗している。

### 削減案

| # | 内容 | 効果 | リスク |
|---|---|---|---|
| 1 | 定期更新の前にキャッシュの時刻を確認し、他タブが更新済みなら送らない。更新間隔の初期値を 2 分 → 10 分程度に | 大 | ほぼなし |
| 2 | パネルを開いたタブに戻ったときは、キャッシュが新しければ送らない | 中 | ほぼなし |
| 3 | 課題ツール URL (`pages.json` の結果) を科目ごとに保存して使い回す | 中 (毎回 N 件減) | ほぼなし (ツール ID は学期中変わらない) |
| 4 | 受付終了から一定日数たち、評定済みの課題は `item` API を省略して前回結果を使う | 大 | 採点・返却が後から変わった場合の反映が遅れる |
| 5 | 過去学期の科目を対象から外す | 不明 (サイドバーにある過去科目の数による) | 過去科目の課題がパネルに出なくなる |
| 6 | `!gateway` など科目でないサイトを対象から外す | 小 | なし |

## 3. 調査で分かった Sakai の仕組み

### `doExpandall` (授業資料の全展開)

Sakai の `ResourcesAction.java` には、全フォルダを一度に展開するアクションがある。

- 授業資料ページのヘッダーにある「すべて展開」アイコン (`a[onclick*="doExpandall"]`) と同じもの。
- `sakai_action=doExpandall` と `collectionId=/group/{siteId}/` を POST すると、全階層が展開された表が 1 回で返る。
- 展開状態はサーバーのセッションに残る。そのため、同じセッション中に再訪すると最初から展開済みになる。

ソース: <https://github.com/sakaiproject/sakai/blob/master/content/content-tool/tool/src/java/org/sakaiproject/content/tool/ResourcesAction.java> (`doExpandall` / `doUnexpandall`)

### サイドバーのリンクは `tool-reset`

サイドバーのツールリンクは `/portal/site/{siteId}/tool-reset/{toolId}` の形をしている。
これは開くと、そのツールの状態 (授業資料で今いるフォルダなど) を初期化する URL。
先読み (prerender) は、マウスを乗せただけでこの URL を開くので、そのツールの状態がサーバー側で初期化される。
表示中のツール自身のリンクは、先読みの対象から外すのが安全。

## 計測方法 (再計測用)

KULMS のページで DevTools のコンソールに貼り付ける。

```js
const nav = performance.getEntriesByType("navigation")[0];
const res = performance.getEntriesByType("resource");
({
  ttfb: Math.round(nav.responseStart - nav.requestStart),
  load: Math.round(nav.loadEventEnd),
  total: res.length,
  cached: res.filter((e) => e.transferSize === 0).length,
  network: res.filter((e) => e.transferSize > 0).map((e) => new URL(e.name).pathname),
});
```

定期通信の確認は、DevTools の Network タブを開いたまま数分放置して観察する。
