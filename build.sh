#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 共通除外パターン
EXCLUDE=(-x ".git/*" ".DS_Store" "*.zip" ".claude/*" "build.sh" ".gitignore" ".github/*" "hot-reload.sh" "safari/*" "docs/*" "gas/*" "*.md" "icons/icon1024.png")

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
  jq '
    .browser_specific_settings = {
      gecko: {
        id: "kulms-plus@extension",
        strict_min_version: "109.0",
        data_collection_permissions: { required: ["none"], private_browsing_allowed: false }
      }
    }
    | .background.scripts = ["background.js"]
  ' manifest.json.bak > manifest.json

  zip -r "$out" . "${EXCLUDE[@]}" -x "manifest.json.bak" -q

  # manifest.json を元に戻す
  mv manifest.json.bak manifest.json
  echo "Created $out"
}

sync_safari() {
  local dest="safari/KULMS+ Extension/Resources"
  if [ ! -d "$dest" ]; then
    echo "Error: $dest not found" >&2
    return 1
  fi

  # 拡張機能リソースを Safari プロジェクトに同期
  local resources=(manifest.json background.js popup.html popup.js styles.css src icons _locales)
  for item in "${resources[@]}"; do
    rm -rf "$dest/$item"
    cp -R "$item" "$dest/$item"
  done
  # icon1024.png は AppIcon 生成用ソースのため Safari バンドルには不要
  rm -f "$dest/icons/icon1024.png"
  echo "Synced resources to $dest"
}

case "${1:-all}" in
  chrome)  build_chrome ;;
  firefox) build_firefox ;;
  safari)  sync_safari ;;
  all)     build_chrome; build_firefox; sync_safari ;;
  *)
    echo "Usage: $0 {chrome|firefox|safari|all}" >&2
    exit 1
    ;;
esac
