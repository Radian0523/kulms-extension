#!/bin/bash
# ファイル変更を監視して、Chromeに拡張機能のリロードを促すスクリプト
# 使い方: ./hot-reload.sh

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== KULMS Extension Hot Reload ==="
echo "監視ディレクトリ: $DIR"
echo "ファイル変更を検知すると通知します。"
echo "Ctrl+C で停止"
echo ""

fswatch -o "$DIR" --exclude '\.git' --exclude 'hot-reload\.sh' --exclude '\.DS_Store' | while read; do
  echo "[$(date '+%H:%M:%S')] ファイル変更検知 → Chromeで拡張機能をリロードしてください (Cmd+R on chrome://extensions)"
done
