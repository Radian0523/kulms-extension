#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 共通除外パターン
EXCLUDE=(-x ".git/*" ".DS_Store" "*.zip" ".claude/*" "build.sh" ".gitignore" ".github/*")

build_chrome() {
  local out="kulms-extension-chrome.zip"
  rm -f "$out"
  zip -r "$out" . "${EXCLUDE[@]}" -q
  echo "Created $out"
}

build_firefox() {
  local out="kulms-extension-firefox.zip"
  rm -f "$out"

  # manifest.json をバックアップし、Firefox 用に差し替え
  cp manifest.json manifest.json.bak
  jq '. + { browser_specific_settings: { gecko: { id: "{kulms-plus@extension}", strict_min_version: "109.0" } } }' manifest.json.bak > manifest.json

  zip -r "$out" . "${EXCLUDE[@]}" -x "manifest.json.bak" -q

  # manifest.json を元に戻す
  mv manifest.json.bak manifest.json
  echo "Created $out"
}

case "${1:-all}" in
  chrome)  build_chrome ;;
  firefox) build_firefox ;;
  all)     build_chrome; build_firefox ;;
  *)
    echo "Usage: $0 {chrome|firefox|all}" >&2
    exit 1
    ;;
esac
