# Sakai テスト/クイズ (Assessment) 提出状態 完全対応表

KULMS+ 拡張機能のテスト/クイズ提出判定ロジック実装のための参考資料。
Sakai ソースコード（GitHub: sakaiproject/sakai, master ブランチ）を解析して作成。

## 課題(Assignment)との根本的な違い

テスト/クイズ (Samigo) は課題 (Assignment) とは全く異なるデータモデルを持つ。

| 観点 | 課題 (Assignment) | テスト/クイズ (Samigo) |
|---|---|---|
| REST API | `/direct/assignment/...` | `/direct/sam_pub/...` |
| Entity Provider | `AssignmentEntityProvider` | `PublishedAssessmentEntityProviderImpl` |
| 提出データ | `AssignmentSubmission` | `AssessmentGradingData` |
| 状態管理 | `SubmissionStatus` enum (文字列) | `Integer` ステータスコード (0-7) |
| 複数提出 | 基本1回（再提出は上書き） | 試行(attempt)ごとに別レコード |
| `submitted`フィールド | `getSubmitted()` (Boolean) | **存在しない** (代わりに `forGrade` + `status`) |
| `userSubmission` | あり | **存在しない** |
| 下書き概念 | `draft=true` | `forGrade=false` かつ `status=IN_PROGRESS(0)` |

## 参照したソースコード

| ファイル | 役割 |
|---|---|
| `samigo/samigo-api/.../entity/api/PublishedAssessmentEntityProvider.java` | `ENTITY_PREFIX = "sam_pub"` 定義 |
| `samigo/samigo-services/.../entity/impl/PublishedAssessmentEntityProviderImpl.java` | REST API (`/direct/sam_pub/...`) のエンティティプロバイダ実装 |
| `samigo/samigo-services/.../facade/PublishedAssessmentFacade.java` | 公開テストのFacadeクラス |
| `samigo/samigo-api/.../data/dao/grading/AssessmentGradingData.java` | **提出(試行)データモデル + ステータス定数定義** |
| `samigo/samigo-api/.../data/ifc/assessment/AssessmentAccessControlIfc.java` | アクセス制御定数（遅延提出、自動提出等） |
| `samigo/samigo-api/.../data/ifc/assessment/AssessmentBaseIfc.java` | テスト本体のステータス定数 |
| `samigo/samigo-api/.../data/ifc/assessment/EvaluationModelIfc.java` | 採点方式定数（最高点/最終/平均） |
| `samigo/samigo-api/.../data/ifc/assessment/AssessmentFeedbackIfc.java` | フィードバック配信モード定数 |
| `samigo/samigo-api/.../data/ifc/shared/TypeIfc.java` | テストタイプ・質問タイプ定数 |
| `samigo/samigo-services/.../services/GradingService.java` | 採点サービス（storeGrades, autoSubmit等） |
| `samigo/samigo-services/.../facade/AssessmentGradingFacadeQueries.java` | DB問い合わせ実装（提出数カウント等） |
| `samigo/samigo-services/.../facade/AutoSubmitFacadeQueries.java` | 自動提出の状態遷移ロジック |
| `samigo/samigo-app/.../ui/listener/delivery/SubmitToGradingActionListener.java` | 学生がテスト提出時の処理 |
| `samigo/samigo-app/.../ui/listener/select/SelectActionListener.java` | テスト一覧画面のフィルタリング・状態判定 |
| `samigo/samigo-hibernate/.../data/dao/assessment/PublishedAssessmentData.java` | テストデータの永続化モデル |
| `samigo/samigo-api/.../samigo/util/SamigoConstants.java` | イベント定数・権限定数 |

## ステータス定数

### テスト本体のステータス（PublishedAssessment.status）

`AssessmentBaseIfc` で定義。テスト自体の公開状態を表す。

| 定数 | 値 | 意味 | 説明 |
|---|---|---|---|
| `INACTIVE_STATUS` | `0` | 非公開 | 作成済みだが未公開 |
| `ACTIVE_STATUS` | `1` | 公開中 | 学生が受験可能な状態 |
| `DEAD_STATUS` | `2` | 削除済み | 論理削除された状態 |
| `RETRACT_FOR_EDIT_STATUS` | `3` | 編集のため回収 | 教員が再編集中の状態 |

**REST APIの `getEntities()` は `status=1`（ACTIVE）のテストのみ返す。**
ただし教員権限（`CAN_PUBLISH`）がある場合は InActive テストも含む。

### 提出(試行)のステータス（AssessmentGradingData.status）

`AssessmentGradingData` で定義。各提出試行の状態を表す。
**これが最も重要な概念。**

| 定数 | 値 | 意味 | 説明 |
|---|---|---|---|
| `REMOVED` | `-1` | 削除済み | ソフトデリート。全クエリで除外される |
| `IN_PROGRESS` | `0` | 受験中 | 学生がテストを開始したが未提出 |
| `SUBMITTED` | `1` | 提出済み | 提出されたがまだ自動採点されていない |
| `AUTO_GRADED` | `2` | 自動採点済み | 自動採点完了。教員が採点ページを開いた時にも設定される |
| `NEED_HUMAN_ATTENTION` | `3` | 人手採点待ち | 記述式(essay)等、手動採点が必要 |
| `ASSESSMENT_UPDATED_NEED_RESUBMIT` | `4` | 再提出必要 | テストが再公開され、再提出が要求された |
| `NO_SUBMISSION` | `5` | 提出なし | 提出はないが教員がスコアを更新した |
| `ASSESSMENT_UPDATED` | `6` | テスト更新済み | テストが再公開され、受験中の作業に警告が必要 |
| `AUTOSUBMIT_UPDATED` | `7` | 自動提出(追加) | 自動提出ジョブが検出した持続的な受験中状態（同一テスト・同一学生の2件目以降） |

### `forGrade` フラグ

`AssessmentGradingData.forGrade` (Boolean) は課題の `submitted` に最も近い概念。

| 値 | 意味 |
|---|---|
| `false` | 受験中（未提出）。テスト保存時のデフォルト |
| `true` | 採点対象として提出済み。学生が「提出」ボタンを押した時に設定 |

**提出カウントのクエリは全て `forGrade=true` を条件に含む。**

```java
// 提出数カウントの典型的なクエリ
"select count(a) from AssessmentGradingData a
 where a.forGrade = true
 and a.publishedAssessmentId = :id
 and a.status > :status"  // status > REMOVED(-1)
```

## `forGrade` と `status` の関係

### 提出の状態遷移

```
[学生がテストを開始]
  → AssessmentGradingData 作成
  → forGrade = false
  → status = IN_PROGRESS (0)

[学生が途中保存]
  → forGrade = false (変化なし)
  → status = IN_PROGRESS (0) (変化なし)
  → submittedDate = null

[学生が「提出」ボタンを押す]
  → forGrade = true (←ここが重要)
  → status = SUBMITTED (1) (setIsLate() 内で設定)
  → submittedDate = new Date() (storeGrades 内で設定)
  → isLate = dueDate前ならfalse, 後ならtrue

[自動採点完了 / 教員が採点ページ表示]
  → forGrade = true
  → status = AUTO_GRADED (2) or NEED_HUMAN_ATTENTION (3)

[テスト再公開時]
  → forGrade = false (受験中の場合)
  → status = ASSESSMENT_UPDATED (6) or ASSESSMENT_UPDATED_NEED_RESUBMIT (4)

[再提出時 (状態4 or 6から)]
  → status = IN_PROGRESS (0) にリセット
  → gradedBy = null, gradedDate = null, comments = null
  → totalOverrideScore = 0

[自動提出ジョブ実行時]
  自動提出条件:
    - autoSubmit=1 が設定されている
    - forGrade=false (未提出)
    - hasAutoSubmissionRun=false
    - 期限経過
    → attemptDate != null かつ submittedDate == null の場合:
        status = REMOVED (-1)  ← 何も回答していない場合は削除
    → それ以外:
        forGrade = true
        status = SUBMITTED (1) (初回) or AUTOSUBMIT_UPDATED (7) (同一テスト・同一学生の2件目以降)
        isAutoSubmitted = true
```

## テストのアクセス制御定数

`AssessmentAccessControlIfc` で定義。

### 遅延提出 (Late Handling)

| 定数 | 値 | 意味 |
|---|---|---|
| `ACCEPT_LATE_SUBMISSION` | `1` | 遅延提出を受け付ける（retractDate まで） |
| `NOT_ACCEPT_LATE_SUBMISSION` | `2` | 遅延提出を受け付けない（dueDate で締切） |

### 自動提出 (Auto Submit)

| 定数 | 値 | 意味 |
|---|---|---|
| `AUTO_SUBMIT` | `1` | 時間切れ時に自動提出する |
| `DO_NOT_AUTO_SUBMIT` | `0` | 自動提出しない |

### 提出回数

| 定数 | 値 | 意味 |
|---|---|---|
| `UNLIMITED_SUBMISSIONS` | `1` | 無制限提出フラグ |
| `LIMITED_SUBMISSIONS` | `0` | 提出回数制限あり |
| `UNLIMITED_SUBMISSIONS_ALLOWED` | `9999` | 「無制限」時の内部値 |

### 時間制限

| 定数 | 値 | 意味 |
|---|---|---|
| `TIMED_ASSESSMENT` | `1` | 制限時間あり |
| `DO_NOT_TIMED_ASSESSMENT` | `0` | 制限時間なし |

### ナビゲーション

| 定数 | 値 | 意味 |
|---|---|---|
| `LINEAR_ACCESS` | `1` | 順次アクセス（戻れない） |
| `RANDOM_ACCESS` | `2` | ランダムアクセス（自由に移動可能） |

## 採点方式定数

`EvaluationModelIfc` で定義。複数回受験可能なテストでどのスコアを記録するか。

| 定数 | 値 | 意味 |
|---|---|---|
| `HIGHEST_SCORE` | `1` | 最高得点を記録 |
| `LAST_SCORE` | `2` | 最後の提出を記録 |
| `ALL_SCORE` | `3` | 全試行を表示 |
| `AVERAGE_SCORE` | `4` | 平均得点を記録 |

## フィードバック配信モード定数

`AssessmentFeedbackIfc` で定義。

| 定数 | 値 | 意味 |
|---|---|---|
| `IMMEDIATE_FEEDBACK` | `1` | 即時フィードバック（回答中に表示） |
| `FEEDBACK_BY_DATE` | `2` | 指定日以降にフィードバック |
| `NO_FEEDBACK` | `3` | フィードバックなし |
| `FEEDBACK_ON_SUBMISSION` | `4` | 提出時にフィードバック |

## REST API (`/direct/sam_pub/...`) の動作

### エンドポイント構造

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/direct/sam_pub.json?siteId={siteId}` | GET | サイト内の公開テスト一覧 |
| `/direct/sam_pub/{id}.json` | GET | 個別テストの情報（ダミーEntityData返却） |
| `/direct/sam_pub/context/{siteId}.json` | GET | URLマッピングによるサイトコンテキスト |

### 重要: getEntity() はダミーを返す

```java
public Object getEntity(EntityReference ref) {
    return new EntityData(new EntityReference("dummy reference"), "dummy");
}
```

**個別テスト取得 (`/direct/sam_pub/{id}.json`) はダミーデータしか返さない。**
有用な情報は `getProperties()` と `getEntities()` から取得する。

### getProperties() が返すフィールド

`/direct/sam_pub/{id}.json` の代わりに、プロパティとして以下が取得可能:

| フィールド名 | 型 | 説明 |
|---|---|---|
| `title` | String | テスト名 |
| `description` | String | テスト説明 |
| `author` | String | 作成者 |
| `created_date` | String (DateFormat) | 作成日 |
| `modified_by` | String | 最終更新者 |
| `modified_date` | String (DateFormat) | 最終更新日 |
| `totalScore` | String | 合計点 |
| `start_date` | String (DateFormat) | 開始日時 |
| `due_date` | String (DateFormat) | 提出期限 |
| `retract_date` | String (DateFormat) | 回収日時 |
| `comments` | String | コメント |
| `siteId` | String | サイトID |

### getEntities() が返すオブジェクト

`/direct/sam_pub.json?siteId={siteId}` のレスポンス:

Entity Broker が `PublishedAssessmentFacade` を自動的にJSON化する。
JavaBean のゲッターメソッドから以下のフィールドが含まれる:

| フィールド | 型 | 説明 |
|---|---|---|
| `publishedAssessmentId` | Long | テストID |
| `title` | String | テスト名 |
| `description` | String | 説明文 |
| `status` | Integer | テスト本体のステータス (0/1/2/3) |
| `startDate` | Date | 開始日時 |
| `dueDate` | Date | 提出期限 |
| `retractDate` | Date | 回収日時 |
| `releaseTo` | String | 公開先 ("Selected Groups" 等) |
| `lateHandling` | Integer | 遅延提出ポリシー (1=受付, 2=拒否) |
| `unlimitedSubmissions` | Boolean | 無制限提出か |
| `submissionsAllowed` | Integer | 許可提出回数 |
| `scoringType` | Integer | 採点方式 (1=最高, 2=最終, 4=平均) |
| `feedbackDelivery` | Integer | フィードバック配信モード |
| `feedbackDate` | Date | フィードバック開始日 |
| `feedbackEndDate` | Date | フィードバック終了日 |
| `timeLimit` | Integer | 制限時間(秒) |
| `createdBy` | String | 作成者ID |
| `createdDate` | Date | 作成日 |
| `lastModifiedBy` | String | 最終更新者ID |
| `lastModifiedDate` | Date | 最終更新日 |
| `submissionSize` | int | 全提出数 |
| `submittedCount` | int | 提出済み数 |
| `inProgressCount` | int | 受験中数 |
| `hasAssessmentGradingData` | boolean | 採点データの有無 |

**重要: `sam_pub` のREST APIにはテスト本体の情報は含まれるが、学生個人の提出(AssessmentGradingData)の詳細は含まれない。**

提出状態はテスト一覧の `submittedCount`, `inProgressCount`, `hasAssessmentGradingData` でのみ間接的に分かる。
学生個人のスコアや提出回数を取得するには別のAPIまたは画面スクレイピングが必要。

## 日付フィールドの意味と動作

### テスト本体の日付

| フィールド | 意味 | 動作 |
|---|---|---|
| `startDate` | テスト開始日時 | この日時以前は学生に表示されない |
| `dueDate` | 提出期限 | この日時以降の提出は `isLate=true` になる |
| `retractDate` | 回収日時 | `lateHandling=1` の場合: この日時まで遅延提出可能。この日時以降はテストが非表示 |

### 日付によるテストの表示/非表示ロジック

```
Active テスト（status=1）がAPIで返される条件:

教員権限(CAN_PUBLISH)の場合: 全Active + 全InActive テスト
学生権限(CAN_TAKE)の場合: Active テストのみ
  → さらに以下でフィルタ:
     startDate == null OR currentDate > startDate
  → InActive判定（一覧から除外されるもの）:
     dueDate != null AND dueDate <= currentDate
     AND (retractDate != null AND retractDate <= currentDate)
```

### 提出試行の日付

| フィールド | 意味 |
|---|---|
| `attemptDate` | テスト開始日時（「開始」ボタンを押した日時） |
| `submittedDate` | 提出日時（「提出」ボタンを押した/自動提出された日時） |
| `gradedDate` | 採点日時 |

## 自動提出 (Auto-Submit) の詳細ロジック

Quartzジョブ `AutoSubmitAssessmentsJob` が定期的に実行。

### 自動提出の対象条件

```sql
-- 自動提出対象のクエリ条件
WHERE
  c.autoSubmit = 1                              -- 自動提出が有効
  AND ((c.lateHandling = 1 AND c.retractDate <= now)  -- 遅延受付ありの場合: retractDate経過
    OR (c.lateHandling = 2 AND c.dueDate <= now))     -- 遅延拒否の場合: dueDate経過
  AND a.status NOT IN (-1, 5)                   -- REMOVED, NO_SUBMISSION は除外
  AND (a.hasAutoSubmissionRun = 0 OR a.hasAutoSubmissionRun IS NULL) -- 未処理
  AND a.attemptDate IS NOT NULL                 -- テストを開始している
```

### 自動提出の状態遷移

```
processAttempt() の処理フロー:

1. hasAutoSubmissionRun = true に設定（二重処理防止）

2. forGrade==false かつ assessment.status != DEAD の場合のみ処理:

   3. 延長時間(ExtendedTime)の確認
      → 延長されている場合、延長後の期限で判定

   4. まだ期限内であれば何もしない（return true）

   5. attemptDate != null かつ submittedDate == null の場合:
      → status = REMOVED (-1)
      → 解釈: テストを開始したが何も回答せずに放棄

   6. それ以外（何らかの回答がある場合）:
      → forGrade = true
      → isAutoSubmitted = true
      → 同一テスト・同一学生の前のレコードが既にある場合:
          status = AUTOSUBMIT_UPDATED (7)
        そうでない場合:
          status = SUBMITTED (1)
      → isLate の判定:
          attemptDate > dueDate → isLate = true
          submittedDate > dueDate → isLate = true
      → completeItemGradingData() で回答データを補完

   7. DBに保存

   8. 自動提出された場合:
      → Gradebook に通知
      → イベントログを更新
```

## 複数試行 (Multiple Attempts) の扱い

### テスト設定

```
unlimitedSubmissions = true  → 何回でも受験可能
unlimitedSubmissions = false → submissionsAllowed 回まで
```

### 受験可能判定 (SelectActionListener.isAvailable)

```
totalSubmitted = そのテストの forGrade=true かつ status > REMOVED の提出数

maxSubmissionsAllowed = unlimitedSubmissions ? 9999 : submissionsAllowed

dueDate 前:
  totalSubmitted < maxSubmissionsAllowed + numberRetake → 受験可能

dueDate 後:
  lateHandling == ACCEPT_LATE_SUBMISSION の場合:
    totalSubmitted == 0 → 受験可能（初回は遅延でも受付）
    actualNumberRetake < numberRetake → 受験可能（教員がリテイク許可）
    それ以外 → 受験不可
  lateHandling == NOT_ACCEPT_LATE_SUBMISSION の場合:
    → 受験不可
```

### リテイク (Retake)

教員が手動で `StudentGradingSummaryData.numberRetake` を増加させることで、
提出回数上限を超えた追加受験を許可する仕組み。

## テストタイプ

`TypeIfc` で定義。テスト自体のタイプ（質問タイプではない）。

| 定数 | 値 | 説明 |
|---|---|---|
| `QUIZ` | `61` | クイズ |
| `HOMEWORK` | `62` | 宿題 |
| `MIDTERM` | `63` | 中間試験 |
| `FINAL` | `64` | 期末試験 |

**注意: これらはテンプレートとしてのタイプであり、REST APIの動作には影響しない。**
全タイプで同じ `sam_pub` エンティティプロバイダが使用される。

## 全パターン対応表

### テスト本体の状態パターン

| # | 状態 | `status` | API に含まれるか | 説明 |
|---|---|---|---|---|
| A1 | 公開中 | `1` (ACTIVE) | はい | 学生が受験可能 |
| A2 | 非公開 | `0` (INACTIVE) | いいえ | 教員にのみ表示 |
| A3 | 削除済み | `2` (DEAD) | いいえ | 論理削除 |
| A4 | 編集のため回収 | `3` (RETRACT_FOR_EDIT) | 教員のみ | 再編集中 |

### 学生から見た提出(試行)の状態パターン

| # | 状態 | `forGrade` | `status` | `submittedDate` | `isLate` | `isAutoSubmitted` | 説明 |
|---|---|---|---|---|---|---|---|
| S1 | 未受験 | - | - | - | - | - | AssessmentGradingData レコードなし |
| S2 | 受験中（途中保存） | `false` | `0` (IN_PROGRESS) | `null` | - | `false` | テストを開始したが未提出 |
| S3 | 提出済み（期限内） | `true` | `1` (SUBMITTED) | 日時あり | `false` | `false` | 正常提出 |
| S4 | 提出済み（遅延） | `true` | `1` (SUBMITTED) | 日時あり | `true` | `false` | 期限後に提出 |
| S5 | 自動採点済み | `true` | `2` (AUTO_GRADED) | 日時あり | varies | `false` | 客観式問題の自動採点完了 |
| S6 | 人手採点待ち | `true` | `3` (NEED_HUMAN_ATTENTION) | 日時あり | varies | `false` | 記述式問題あり、教員の採点待ち |
| S7 | 再提出必要 | `false` | `4` (ASSESSMENT_UPDATED_NEED_RESUBMIT) | varies | varies | `false` | テスト再公開により再提出要求 |
| S8 | テスト更新済み（警告） | `false` | `6` (ASSESSMENT_UPDATED) | varies | varies | `false` | テスト再公開により受験中に警告 |
| S9 | 自動提出済み | `true` | `1` (SUBMITTED) | 日時あり | varies | `true` | タイマー切れ/期限切れで自動提出 |
| S10 | 自動提出済み(追加) | `true` | `7` (AUTOSUBMIT_UPDATED) | 日時あり | varies | `true` | 同一テスト・同一学生の2件目以降の自動提出 |
| S11 | 教員スコア更新のみ | `false` | `5` (NO_SUBMISSION) | `null` | - | `false` | 学生は未提出だが教員がスコアを設定 |
| S12 | 削除済み | - | `-1` (REMOVED) | varies | varies | varies | ソフトデリート。クエリから除外 |
| S13 | 放棄（自動処理） | - | `-1` (REMOVED) | `null` | - | - | 自動提出ジョブで回答なしと判定され削除 |

### 状態 S7, S8 からの再提出

テスト再公開時、既存の受験中データの状態が変更される:

```
受験中(forGrade=false)のデータ:
  再提出必須設定あり → status = ASSESSMENT_UPDATED_NEED_RESUBMIT (4)
  再提出必須設定なし → status = ASSESSMENT_UPDATED (6)

学生が再提出を開始すると:
  status → IN_PROGRESS (0) にリセット
  gradedBy → null
  gradedDate → null
  comments → null
  totalOverrideScore → 0
```

## 「提出済み」の判定方法

### 課題との違い

課題には `userSubmission` と `submitted` の2つのフラグがあり、
その組み合わせで判定したが、テスト/クイズにはそれらは存在しない。

### テスト/クイズの提出判定

**信頼できる判定方法: `forGrade=true` かつ `status > 0` (REMOVED以上)**

これはSakai内部の提出カウントクエリと完全に一致する:

```java
// Sakai内部の提出カウント
"select count(a) from AssessmentGradingData a
 where a.forGrade = true
 and a.publishedAssessmentId = :id
 and a.agentId = :agent
 and a.status > :status"  // status > REMOVED(-1)
```

### sam_pub REST APIの制限

**重要: `sam_pub` のREST APIは学生個人の提出データを直接返さない。**

Entity Provider の `getEntities()` は `PublishedAssessmentFacade` を返し、
これにはテスト本体の情報（タイトル、日付等）は含まれるが、
個人の `AssessmentGradingData`（提出ステータス、スコア等）は含まれない。

学生個人の提出状態を取得するには:
1. 別のAPIエンドポイント（存在する場合）
2. 画面スクレイピング
3. `submittedCount`, `inProgressCount` フィールド（教員権限のみ？）

## フィードバック表示判定

テスト提出後のフィードバック表示は以下のロジックで判定される:

```
feedbackDelivery の値:
  1 (IMMEDIATE) or 4 (ON_SUBMISSION):
    → "show" (常に表示)

  2 (FEEDBACK_BY_DATE):
    feedbackDate != null かつ feedbackEndDate == null:
      currentDate > feedbackDate → "show"
      それ以外 → "blank"
    feedbackDate != null かつ feedbackEndDate != null:
      feedbackDate < currentDate < feedbackEndDate → "show"
      それ以外 → "blank"
    feedbackScoreThreshold != null の場合:
      得点率 < threshold → "show" (閾値未満の場合のみ表示)
      得点率 >= threshold → "blank"

  3 (NO_FEEDBACK):
    → "na" (非表示)
```

## 日本語翻訳（SelectIndexMessages_ja.properties）

テスト一覧画面の日本語翻訳:

| キー | 日本語 | 説明 |
|---|---|---|
| `take_assessment` | テストを受験 | テスト一覧タイトル |
| `review_assessment` | テストを確認 | 提出済みテスト一覧タイトル |
| `take_assessment_notAvailable` | 受験可能なテストは現在ありません。 | テストなし |
| `review_assessment_notAvailable` | まだ何のテストも提出していません。 | 未提出 |
| `assessment_updated` | *テストが更新されました。* | 状態 S8 |
| `assessment_updated_need_resubmit` | (再提出必要の旨) | 状態 S7 |
| `assessmentRetractedForEdit` | (編集のため回収) | 状態 A4 |
| `recorded_score` | 記録済み点数 | 記録スコア列 |
| `highest_score` | (最高) | HIGHEST_SCORE |
| `last_score` | (最後) | LAST_SCORE |
| `average_score` | (平均) | AVERAGE_SCORE |

### DeliveryMessages_ja.properties

| キー | 日本語 | 説明 |
|---|---|---|
| `submission` | 提出 | 提出ラベル |
| `submission_dttm` | 提出済み | 提出日時列 |
| `auto_submit` | 自動提出 | 自動提出ラベル |
| `auto_submit_when_tim` | 時間切れの際は自動提出 | 自動提出設定 |
| `timeOutSubmission` | このテストは時間切れになりました。すべての回答は自動的に提出されました。 | タイムアウト |
| `assessment_has_been_submitted_title` | テストが提出されました | 提出完了タイトル |
| `submission_confirmation_message_4` | あなたはこのテストを完了しました。 | 提出確認 |
| `feedback_not_available` | テストが再公開されるまでフィードバックは利用できません。 | 状態 A4 |
| `done` | 完了 | 完了ラベル |

### FCKeditor Messages_ja.properties

```
entitybrowser.sam_pub=テストを公開
```

## KULMS+ での推奨実装

### テスト一覧の取得

```javascript
// サイト内のテスト一覧取得
const response = await fetch(`${LMS_URL}/direct/sam_pub.json?siteId=${siteId}`, {
  headers: { 'Cookie': sakaiSession }
});
const data = await response.json();
// data.sam_pub_collection にテスト一覧が含まれる
```

### 各テストの日付情報による状態判定

sam_pub API はテスト本体の情報のみ返すため、日付ベースで以下を判定:

```javascript
function getAssessmentStatus(assessment) {
  const now = new Date();
  const startDate = assessment.startDate ? new Date(assessment.startDate) : null;
  const dueDate = assessment.dueDate ? new Date(assessment.dueDate) : null;
  const retractDate = assessment.retractDate ? new Date(assessment.retractDate) : null;

  // テスト本体のステータス
  if (assessment.status !== 1) return 'inactive';

  // 開始前
  if (startDate && now < startDate) return 'not_started';

  // 期限内
  if (!dueDate || now <= dueDate) return 'available';

  // 期限後、回収前（遅延提出可能期間）
  if (assessment.lateHandling === 1 && retractDate && now <= retractDate) {
    return 'late_acceptable';
  }

  // 期限後
  return 'closed';
}
```

### 提出状態の判定（API制限への対応）

**`sam_pub` REST APIは学生個人の提出状態を直接返さない。**
以下のいずれかのアプローチが必要:

#### アプローチ1: 画面スクレイピング

テスト一覧ページ（`/samigo-app/servlet/Login?id=xxx`）をスクレイピングして
提出済みテストの一覧を取得する。

#### アプローチ2: 別の REST API を探す

`sam_pub` 以外にも `sam_publishedassessment` 等の候補がある可能性がある。
ただし Sakai のソースコードを確認した限り、学生の提出データを返す
パブリックな REST API エンドポイントは標準では存在しない。

#### アプローチ3: テスト本体の情報のみで判定

```javascript
// テストが受験可能かどうかのみ判定（提出済みかは判定不可）
function canTakeAssessment(assessment) {
  const status = getAssessmentStatus(assessment);
  return status === 'available' || status === 'late_acceptable';
}

// 期限切れかどうかの判定
function isPastDue(assessment) {
  const dueDate = assessment.dueDate ? new Date(assessment.dueDate) : null;
  return dueDate && new Date() > dueDate;
}
```

## 課題との対応比較（KULMS+ 実装者向け）

| 判定 | 課題での方法 | テストでの方法 |
|---|---|---|
| 提出済みか | `userSubmission && submitted` | `forGrade=true && status > 0` (**API未提供**) |
| 下書きか | `submitted=false && draft=true` | `forGrade=false && status=0` (**API未提供**) |
| 遅延か | `status` に "遅延" を含む | `isLate=true` (**API未提供**) |
| 期限切れか | `dueDate` と比較 | `dueDate` と比較 (API提供あり) |
| 採点済みか | `graded=true && returned=true` | `status=2(AUTO_GRADED)` or `status=3(NEED_HUMAN)` (**API未提供**) |
| 受験可能か | 常に可能（1回提出型） | 日付 + 提出回数上限 + リテイク |

## まとめ

1. **`sam_pub` REST API はテスト本体の情報（タイトル、日付、設定）を返す**
2. **学生個人の提出データ（提出済みか、スコア等）は `sam_pub` API では取得できない**
3. テスト/クイズの提出状態は `AssessmentGradingData` の `forGrade` + `status` で管理される
4. 状態は Integer コード（-1 ~ 7）で管理され、課題のような文字列ステータスではない
5. 自動提出機能があり、期限切れ時に自動的に `forGrade=true` に遷移する
6. 複数回受験が可能で、各試行ごとに別の `AssessmentGradingData` レコードが作成される
7. 採点方式（最高/最終/平均）によって、どのスコアが記録されるかが異なる

### 今後の調査事項

- 京都大学 KULMS が `sam_pub` API にカスタム拡張（個人提出データ含む）を追加しているか確認
- テスト一覧ページのスクレイピングで取得可能な情報の調査
- `/direct/sam_pub/{id}/...` のサブリソースとして提出データが取得可能か調査
