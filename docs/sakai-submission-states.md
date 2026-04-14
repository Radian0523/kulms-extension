# Sakai 課題提出状態 完全対応表

KULMS+ 拡張機能の提出判定ロジック改善のための参考資料。
Sakai ソースコード（GitHub: sakaiproject/sakai）を解析して作成。

## 参照したソースコード

| ファイル | 役割 |
|---|---|
| `assignment/tool/.../AssignmentEntityProvider.java` | REST API (`/direct/assignment/...`) のレスポンス生成 |
| `assignment/impl/.../AssignmentServiceImpl.java` | 提出状態の判定ロジック本体 |
| `assignment/api/.../AssignmentConstants.java` | SubmissionStatus enum 定義 |
| `assignment/api/.../model/AssignmentSubmission.java` | 提出データモデル |
| `assignment/tool/.../AssignmentToolUtils.java` | isDraftSubmission 判定 |
| `assignment/tool/.../AssignmentAction.java` | 提出時のフラグ設定処理 |

## `userSubmission` vs `submitted` の違い

**これが最重要ポイント。2つは別物。**

### `submitted` (Boolean)
- 提出レコードが「ドラフトでない」状態を示す
- **教員が採点画面を開くだけで、全学生に `submitted=true` のプレースホルダーが自動生成される**
- `submitted=true` は「学生が実際に提出した」ことを意味しない

### `userSubmission` (Boolean)
- 学生が実際に提出アクションを行ったかどうか
- `false` = システム生成のプレースホルダー or 誓約のみ
- `true` = 学生が本当に提出した（テキスト入力 or ファイル添付）

### 設定タイミング（AssignmentAction.java）
```java
// 学生が提出ボタンを押した時
submission.setUserSubmission(true);
submission.setSubmittedText(text);
submission.setSubmitted(post);  // post=true: 提出, false: 下書き保存
if (post) submission.setDateSubmitted(Instant.now());
```

## SubmissionStatus enum

```
NOT_STARTED       - 未開始
HONOR_ACCEPTED    - 誓約同意済み（未提出）
IN_PROGRESS       - 下書き保存中
SUBMITTED         - 提出済み
RESUBMITTED       - 再提出済み
LATE              - 遅延再提出
NO_SUBMISSION     - 提出なし（教員ビューのみ）
UNGRADED          - 未採点（教員ビューのみ）
RETURNED          - 返却済み
COMMENTED         - コメント付き（教員ビューのみ。学生ビューには出現しない）
GRADED            - 採点済み
RESUBMIT_ALLOWED  - 再提出可
```

## 学生ビューの状態判定フローチャート

```
submission が null → NOT_STARTED

submitted == true:
  dateSubmitted != null:
    returned == true:
      returnTime < submitTime:
        graded == false:
          submitTime > dueDate → LATE
          else → RESUBMITTED
        graded == true:
          canResubmit → RESUBMIT_ALLOWED
          else → RETURNED
      returnTime >= submitTime:
        returnTime > submitTime:
          canResubmit → RESUBMIT_ALLOWED
          else → RETURNED
        else → RETURNED
    returned == false → SUBMITTED
  dateSubmitted == null:
    returned == true → RETURNED
    returned == false:
      honorPledge && sub.honorPledge → HONOR_ACCEPTED
      else → NOT_STARTED  ← プレースホルダーがここに来る

submitted == false:
  graded == true:
    returned == true:
      modifiedTime > returnTime + 10s → IN_PROGRESS
      else → RETURNED
    returned == false → IN_PROGRESS
  graded == false:
    honorPledge && sub.honorPledge && created == modified → HONOR_ACCEPTED
    else → IN_PROGRESS
```

## API レスポンスの全パターン対応表

### 注意: API エンドポイントによる `submitted` の意味の違い

| エンドポイント | レスポンス形式 | `submitted` フィールドの意味 |
|---|---|---|
| `/direct/assignment/site/{siteId}.json` | `SimpleSubmission` | `getSubmitted()`（ドラフトでない） |
| `/direct/assignment/item/{id}.json` | `submissionToMap` | **`getUserSubmission()`**（学生が操作したか） |

**KULMS+ はサイト一覧API（`SimpleSubmission`）を使用。** 以下の対応表はこの形式を前提とする。
個別取得APIでは `submitted` と `userSubmission` が同じ値（`getUserSubmission()`）になるため注意。

また、`userSubmission`, `graded`, `returned` は値が `true` のときだけJSONに含まれる。
`false` の場合はフィールド自体が存在しない（JS では `undefined` = falsy）。

### 学生ビュー（KULMS+が受け取るデータ）

| # | 状態 | `userSubmission` | `submitted` | `draft` | `graded` | `returned` | `dateSubmitted` | `status` (EN) | `status` (京大) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 提出なし（submissionレコードなし） | - | - | - | - | - | - | - | - |
| 2 | プレースホルダー（教員が採点画面を開いた） | `false` | `true` | `false` | `false` | `false` | `null`/`""` | "Not Started" | "未開始" |
| 3 | 誓約同意のみ（Honor Pledge） | `false` | `true` | `false` | `false` | `false` | `null`/`""` | "Honor Pledge Accepted" | "宣誓済み" |
| 4 | 下書き保存 | `true` | `false` | `true` | `false` | `false` | `null`/`""` | "In progress" | "取組中" |
| 5 | **提出済み** | `true` | `true` | `false` | `false` | `false` | 日時あり | "Submitted {date}" | "提出済み {date}" |
| 6 | 採点済み（未返却） | `true` | `true` | `false` | `true` | `false` | 日時あり | "Submitted {date}" | "提出済み {date}" |
| 7 | 返却済み（採点付き） | `true` | `true` | `false` | `true` | `true` | 日時あり | "Returned" / "Resubmission Allowed" | "返却済" / "再提出可" |
| 8 | 返却済み（採点なし） | `true` | `true` | `false` | `false` | `true` | 日時あり | "Returned" | "返却済" |
| 9 | 再提出済み | `true` | `true` | `false` | `false` | `true`(前回) | 日時あり(新) | "Re-submitted" | "再提出済み" |
| 10 | 遅延再提出 | `true` | `true` | `false` | `false` | `true`(前回) | 日時あり(期限後) | "Re-submitted {date}- late" | "再提出済み {date}- 遅延" |
| 11 | 返却後に作業中 | `true` | `false` | varies | `true` | `true` | 前回の日時 | "In progress" | "取組中" |
| 12 | 誓約同意のみ（submitted=false経路） | `false` | `false` | `false` | `false` | `false` | `null`/`""` | "Honor Pledge Accepted" | "宣誓済み" |

**注意: #12 は `submitted=false` かつ `created == modified`（作成後に変更なし）の場合のみ。** 学生が下書き編集を行うと `created != modified` となり IN_PROGRESS になる。

### 注意: #2 と #3 の区別

プレースホルダー（#2）と誓約同意（#3）は `userSubmission`, `submitted`, `draft`, `graded` が完全に同じ。
区別には `status` 文字列を見るしかない（"未開始" vs "宣誓済み"）。

### 注意: #5 と #6 の区別

採点済み（#6）は学生ビューでは `SUBMITTED` と表示される（返却されるまで学生に採点結果を見せない）。
`graded=true` でも `returned=false` なら学生には「提出済み」としか見えない。

## 京都大学のカスタム翻訳

京大 Sakai は upstream の `assignment_ja.properties` と異なるカスタム翻訳を使用。

| SubmissionStatus | upstream 日本語 | 京大カスタム |
|---|---|---|
| NOT_STARTED | "開始されていません" | "未開始" |
| SUBMITTED | "提出日時 {date}" | "提出済み {date}" |
| HONOR_ACCEPTED | (未翻訳→英語fallback) | "宣誓済み" |
| IN_PROGRESS | "進行中" | "取組中" |
| RESUBMITTED | "再提出済み" | "再提出済み" |
| LATE | "再提出済み {date}- 遅延" | "再提出済み {date}- 遅延" |
| GRADED | "採点済み" | "評定済" |
| RETURNED | "返却されました" | "返却済" |
| RESUBMIT_ALLOWED | (未翻訳→英語fallback) | "再提出可" |
| COMMENTED | "コメントされました" | - (教員ビューのみ) |
| NO_SUBMISSION | "未提出" | - (教員ビューのみ) |
| UNGRADED | "採点しない" | - (教員ビューのみ) |

**→ status 文字列でのマッチングは京大カスタム翻訳に合わせる必要がある**

## `isDraftSubmission` の判定

```java
// AssignmentToolUtils.java
public boolean isDraftSubmission(AssignmentSubmission s) {
    return !s.getSubmitted() &&
            (StringUtils.isNotEmpty(s.getSubmittedText()) || !s.getAttachments().isEmpty());
}
```

`draft=true` になる条件: `submitted=false` かつ（テキスト入力あり or 添付ファイルあり）

## KULMS+ 拡張機能での推奨判定ロジック

### 各フィールドの信頼性

| フィールド | 単体で信頼できるか | 理由 |
|---|---|---|
| `userSubmission` | **単体では不十分** | `true` は「学生が操作した」だが下書きも含む |
| `submitted` | **単体では不十分** | 教員が採点画面を開くだけで `true` になるプレースホルダーがある |
| `dateSubmitted` | **単体では不十分** | 返却後の再提出作業中（状態#11）でも前回の値が残る |
| `userSubmission && submitted` | **最も信頼できる組み合わせ** | プレースホルダー除外 + 下書き除外 = 確実に提出済み |
| `status` 文字列 | **フォールバック用** | 京大カスタム翻訳への依存がある |

### 推奨コード

```javascript
// 提出済み判定（推奨）
function isSubmitted(sub) {
  // 1. userSubmission=true かつ submitted=true → 確実に提出済み
  //    - userSubmission: 学生が実際に操作した（プレースホルダー除外）
  //    - submitted: ドラフトでない（下書き除外）
  if (sub.userSubmission && sub.submitted) return true;
  // 2. status 文字列による判定（フォールバック: 京大カスタム翻訳対応）
  const s = (sub.status || "").toLowerCase();
  if (s.includes("提出済") || s.includes("submitted") ||
      s.includes("再提出") || s.includes("resubmitted") ||
      s.includes("評定済") || s.includes("graded") ||
      s.includes("採点済") || s.includes("返却") || s.includes("returned")) {
    return true;
  }
  return false;
}

// 採点済み判定
function isGraded(sub) {
  if (sub.graded && sub.returned) return true;
  const s = (sub.status || "").toLowerCase();
  return s.includes("評定済") || s.includes("graded") || s.includes("採点済");
}

// 除外すべき状態（提出済みではない）
// - "未開始" / "Not Started" → プレースホルダー or 未着手
// - "宣誓済み" / "Honor Pledge Accepted" → 誓約のみ、未提出
// - "取組中" / "In progress" → 下書き保存中
```

### 注意: `dateSubmitted` を単体で使ってはいけない理由

状態#11（返却後に再提出作業中）では `submitted=false` だが前回提出時の
`dateSubmitted` が残っている。`dateSubmitted` 単体で判定すると、
下書き作業中なのに「提出済み」と誤判定する。

## 実データ（2026/04/14 取得）

| 課題名 | `userSubmission` | `submitted` | `draft` | `graded` | `status` | 備考 |
|---|---|---|---|---|---|---|
| レポート課題 第1回 | `false` | `true` | `false` | `false` | "宣誓済み" | #3: 誓約のみ |
| 第1回(4/13)松尾担当分 | `false` | `true` | `false` | `false` | "未開始" | #2: プレースホルダー |
| 4月9日の講義における課題 | `true` | `true` | `false` | `false` | "提出済み {date}" | #5: 正常提出 |
| 課題１（採点しない） | `true` | `true` | `false` | `false` | "提出済み {date}" | #5: 正常提出（遅延反映あり） |
| 1. 電気機器... | `true` | `false` | `true` | `false` | "取組中" | #4: 下書き |
