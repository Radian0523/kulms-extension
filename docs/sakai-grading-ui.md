# Sakai 採点画面 UI リファレンス

`src/grading-ta.js` (TA 採点支援) が依存している Sakai 採点画面のセレクタ・URL 構造・状態文字列を記録する。Sakai のバージョンアップで挙動が変わったときの修正起点になるようにメンテすること。

## 対象画面

京都大学 LMS (`https://lms.gakusei.kyoto-u.ac.jp/`)。Sakai 23+ の **新 Grader UI** (lit-html ベース) を前提とする。旧 UI (lit 非ベース) は対象外で、`#grader-submitter-select` の存在チェックで自然に切り分けられる。

## 状態マップ取得

Sakai 新 Grader UI では `<sakai-grader>` custom element が `originalSubmissions` を保持している。`src/grading-ta.js` はこれを第一候補として使う。

Chrome extension の content script は isolated world で動くため、Sakai の page-world JS プロパティを直接読めない。`src/grading-ta-page.js` を `web_accessible_resources` として page world に注入し、`CustomEvent` で必要最小限の提出状態だけ content script に返す。

```js
const grader = document.querySelector('sakai-grader[id^="sakai-grader-"]');
const submissions = grader.originalSubmissions;
```

各 `submission` の主要フィールド:

| フィールド | 用途 |
|---|---|
| `id` | `#grader-submitter-select option.value` と一致する submissionId |
| `firstSubmitterName` | 表示名 |
| `status` / `submissionStatus` | Sakai の表示状態文字列。再提出済みなど、boolean だけで区別しにくい状態の分類に使う |
| `draft` | true なら「未採点 - 取組中」 |
| `submittedTime` / `submitted` | `draft` でなければ「未採点 - 提出済み」 |
| `grade` / `graded` | 採点済み |
| `returned` | 返却済み |

2026-05-07 の実機再検証では、個別採点画面の `originalSubmissions` は全員分の配列を返す一方で、`submittedTime` が入る未採点候補数が現在選択中の提出によって揺れた。さらに `submittedTime` が空でも `submitted=true` の提出済み未採点が多数あるため、`draft` でない `submitted=true` は `pendingGrade` として扱う。修正後は 53 名中 `pendingGrade=45` で、提出物一覧ページの「未採点 - 提出済み」と整合した。HTML fetch fallback は `submissionList` を返さず Grader 画面に戻された。

このため実装では、同一タブ・同一課題内で一度見えた `pendingGrade` を `sessionStorage` に保持し、後続の `originalSubmissions` が一時的に `inProgress` / `notSubmitted` 相当に落としても `pendingGrade` を維持する。`graded` / `returned` が明確に見えた場合、および保存・返却系ボタンを押した場合はキャッシュを破棄・上書きする。

提出物一覧ページの HTML fetch は fallback として残すが、`?panel=Main` や `sakai_action=doView_submission_list` では `submissionList` が返らないケースがあるため、通常経路としては使わない。

## 提出物一覧ページ fallback

**URL**:
```
/portal/site/{siteId}/tool/{toolId}?panel=Main
```

`panel=Main` 単体だと、Sakai はセッション状態に応じて一覧か採点画面を出し分ける。実機では個別採点画面から `fetch()` しても `submissionList` が返らなかったため、これは fallback 扱い。

**テーブル**: `<table id="submissionList" class="listHier lines nolines">`

**列構成**:
| idx | thead 文言 | 内容 |
|---|---|---|
| 0 | 再提出の許可をすべて選択/選択解除 | チェックボックス |
| 1 | (空) | 添付アイコン |
| 2 | 受講者 | 名前リンク → 個別採点画面 |
| 3 | 学生番号 | リンク → 同上 |
| 4 | 提出日時 | |
| 5 | 状態 | ★ アイコン付与・ジャンプ判定の根拠 |
| 6 | 成績 | |
| 7 | 開示 | |

**個別採点画面への href（行内の名前リンク）**:
```
?assignmentId=/assignment/a/{siteId}/{assignmentId}
&submissionId=/assignment/s/{siteId}/{assignmentId}/{submissionId}
&panel=Main
&sakai_action=doGrade_submission
```

`submissionId` を抽出する正規表現:
```js
/submissionId=\/assignment\/s\/[^/]+\/[^/]+\/([0-9a-f-]+)/
```

## 状態カラムの全バリエーション

実機 (1 課題 54 名) で観察した値:

| 状態文字列 | 意味 | classifyStatus | アイコン | F1 ジャンプ対象 |
|---|---|---|---|---|
| `返却済み` | 採点+返却済 | `returned` | ✅ | × |
| `未提出 - 未開始` | 学生未着手 | `notSubmitted` | ⚪ | × |
| `未採点 - 取組中` | ドラフト保存中 | `inProgress` | 🟠 | × |
| `未採点 - 提出済み YYYY/MM/DD HH:MM` | **採点待ち** | `pendingGrade` | 🟡 | **○** |
| `再提出済み` / `再提出済み YYYY/MM/DD HH:MM - 遅延` | **再提出後の採点待ち** | `pendingGrade` | 🟡 | **○** |
| `採点済み - 再提出済み` | 再提出後の採点完了・未返却 | `graded` | 🟢 | × |
| `採点済み` | 採点完了・未返却 | `graded` | 🟢 | × |

`未採点 - 提出済み` と `再提出済み` は後ろに日時や遅延表記が付くため prefix/包含判定にする。

## 個別採点画面

**URL pattern**: 上記 `sakai_action=doGrade_submission` 付き。ブラウザのアドレスバーは `?panel=Main` のみに正規化されるが、リンクで遷移すれば中身は採点画面になる。

**判定**: URL では判別不可。**DOM 存在チェックで分岐すること**:
```js
const isGraderPage = !!document.getElementById('grader-submitter-select');
```

### `#grader-submitter-select`

```html
<div>
  <button class="btn btn-transparent" aria-label="前の提出物を表示">
    <i class="si si-arrow-left-circle-fill"></i>
  </button>
  <select id="grader-submitter-select" aria-label="受講者を選択">
    <option value="00af2338-...">STUDENT NAME (xxxx)</option>
    ... 全受講者（value = submissionId UUID）
  </select>
  <button class="btn btn-transparent" aria-label="次の提出物を表示">
    <i class="si si-arrow-right-circle-fill"></i>
  </button>
</div>
```

- option の `value` はそのまま `submissionId`（URL 組立に直結）
- `aria-label` で前後ボタンを特定可能（日本語ロケール固定）
- `<sakai-grader id="sakai-grader-{assignmentId}">` がコンテナ。ここから `assignmentId` を取得

### lit-html 再描画

`<!--?lit$XXXXX$-->` コメントで囲まれた option は lit-html により再描画される。**option text を書き換えても消える**ので、`MutationObserver` で監視し、option に `data-kulms-icon` を付けて多重実行を防ぎつつ再注入する。

### 採点進捗テキスト

DOM 上: `採点済み 41 / 54`（改行混じり）。正規表現 `/採点済み\s*\d+\s*\/\s*\d+/` で見つけ、隣接 span に「未採点提出 N 件」を追加する。

## 成績提出ダイアログ (Bootstrap 5 Offcanvas)

「成績の提出」ボタン押下で出現:
```html
<div id="grader" class="offcanvas offcanvas-end show" role="dialog" aria-modal="true">
  <!-- position: fixed, z-index: 1045, width: 400px, 右からスライドイン -->
  <sakai-grader id="sakai-grader-{assignmentId}">...</sakai-grader>
</div>
<div class="offcanvas-backdrop fade show">
  <!-- position: fixed, z-index: 1040, 全画面 -->
</div>
```

副作用として `<body>` に `overflow: hidden` と `padding-right: Npx`（スクロールバー幅補正）が付与される。

**F4 修正**: `body.kulms-grader-unblocked` クラスを付け、CSS で:
- `.offcanvas-backdrop.show { display: none !important; }`
- `body { overflow: auto !important; padding-right: 0 !important; }`
- `.portal-main-container { width: calc(100% - var(--kulms-ta-grader-width)); margin-right: var(--kulms-ta-grader-width); }`

加えて JS で `#grader` の実幅を `--kulms-ta-grader-width` に同期し、右サイドバーが本文/PDFの上に被らない docked layout にする。Bootstrap の focus trap は現状維持し、背景操作は backdrop 非表示と本文側の幅調整で担保する。

## ロール権限の検証結果

`/portal/role-switch/{siteId}/tool/{toolId}/Student/?panel=Main` で受講者ロールに切り替えた状態で採点画面 URL を直接叩いた結果:

- Sakai がパラメータを完全に剥奪し、課題ツールのトップに正規化リダイレクト
- `submissionList`, `grader-submitter-select`, `#grader`, `<sakai-grader>` **すべて DOM に出現しない**

→ TA 機能は `#grader-submitter-select` の存在チェックのみで、**学生に UI が漏れる経路は存在しない**。明示的ロール判定は不要。

復帰: `/portal/role-switch-out/{siteId}/tool/{toolId}?panel=Main`

## 既存コードとの統合点

`src/grading-ta.js` は既存 IIFE パターン (`src/sidebar-resize.js` 等を参考) を踏襲。

- 起動: `window.__kulmsSettingsReady` 待機後に `setupAll()`
- 設定キーは持たない（学生影響ゼロが担保されているため）
- `t(key, substitutions)` で i18n（`gradingJumpNext` 等のキー、`_locales/{ja,en}/messages.json`）
- CSS クラス: `kulms-grader-unblocked` / `kulms-ta-jump` / `kulms-ta-pending-count`

## 既知の制約

1. **Sakai バージョン依存**: 旧 Grader UI では `#grader-submitter-select` が存在しないため自動的に無効化される
2. **多サイト対応**: `host_permissions` で京大 LMS のみに限定。他大学 Sakai では起動しない
3. **状態文字列の言語依存**: 日本語・英語の主要な Grader 状態文字列に対応しているが、Sakai 側の文言変更や別ロケールでは追加対応が必要になる
