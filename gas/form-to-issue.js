/**
 * Google Apps Script: Google Form → GitHub Issue 自動連携
 *
 * セットアップ:
 * 1. Google Form を作成し、スプレッドシートにリンク
 * 2. スプレッドシートで「拡張機能」→「Apps Script」
 * 3. このコードを貼り付け
 * 4. REPO 変数をプラットフォームに応じて変更
 * 5.「プロジェクトの設定」→ スクリプトプロパティに GITHUB_TOKEN を追加
 * 6.「トリガー」→ onFormSubmit / スプレッドシートから / フォーム送信時
 */

// ===== プラットフォームごとに変更 =====
// Chrome 拡張: "Radian0523/kulms-extension"
// iOS:         "Radian0523/kulms-ios"
// Android:     "Radian0523/kulms-android"
var REPO = "Radian0523/kulms-extension";

var GITHUB_TOKEN = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");

function onFormSubmit(e) {
  var values = e.values;
  // values[0] = タイムスタンプ, values[1] = 種別, values[2] = 内容, values[3] = 連絡先
  var type = values[1] || "その他";
  var content = values[2] || "(内容なし)";
  var contact = values[3] || "";

  var prefix = {
    "バグ報告": "[Bug]",
    "機能リクエスト": "[Feature]"
  };
  var title = (prefix[type] || "[Feedback]") + " " + content.substring(0, 60);

  var labels = {
    "バグ報告": ["bug"],
    "機能リクエスト": ["enhancement"]
  };

  // 連絡先は Issue に載せない（スプレッドシートにのみ残る）
  var body = "## " + type + "\n\n"
    + content
    + "\n\n---\n送信日時: " + values[0]
    + "\n\n*Google Form から自動作成*";

  var response = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + REPO + "/issues",
    {
      method: "POST",
      headers: {
        "Authorization": "token " + GITHUB_TOKEN,
        "Accept": "application/vnd.github.v3+json"
      },
      contentType: "application/json",
      payload: JSON.stringify({
        title: title,
        body: body,
        labels: labels[type] || ["feedback"]
      })
    }
  );

  Logger.log("Issue created: " + response.getContentText());
}
