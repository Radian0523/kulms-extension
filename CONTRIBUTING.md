# Contributing

KULMS+ への貢献を歓迎します。

## 開発環境のセットアップ

1. リポジトリをフォーク & クローン
   ```bash
   git clone https://github.com/<your-username>/kulms-extension.git
   ```
2. Chrome で `chrome://extensions` を開き、デベロッパーモードを有効化
3. 「パッケージ化されていない拡張機能を読み込む」でクローンしたフォルダを選択
4. KULMS (`https://lms.gakusei.kyoto-u.ac.jp/`) にアクセスして動作確認

コードを変更したら、`chrome://extensions` でリロードボタンを押して反映します。

## プロジェクト構成

- `src/` 配下に機能ごとの IIFE ファイル（`manifest.json` の `content_scripts` で読み込み順を定義）
- `styles.css` に全機能のスタイルを集約
- `background.js` はサービスワーカー（シラバス取得など）
- `_locales/` に i18n メッセージファイル

技術詳細は [DEVELOPMENT.md](DEVELOPMENT.md) を参照してください。

## コーディング規約

- 外部ライブラリ・ビルドツールは使用しない（Vanilla JS のみ）
- 各機能は IIFE で独立させ、グローバル汚染を避ける
- 設定キーは `src/settings.js` の `DEFAULT_SETTINGS` に定義
- UI テキストは `t('key')` ヘルパーで i18n 対応（`_locales/` にメッセージ定義）
- CSS 変数は緊急度色に使用（`styles.css` の `:root` セクション参照）

## Pull Request の流れ

1. `main` から作業ブランチを作成
2. 変更を実装・動作確認
3. コミットメッセージは変更内容を日本語で簡潔に記述
4. Pull Request を作成し、変更内容を説明

## Issue

- バグ報告・機能リクエストは [Issue テンプレート](https://github.com/Radian0523/kulms-extension/issues/new/choose) を使用してください
- フィードバックフォーム: [Google Forms](https://docs.google.com/forms/d/e/1FAIpQLSdFa9VASkP0ea8uHK9GEPS3r3VnoOcIpKO0dsIeCACElvCH-Q/viewform)
