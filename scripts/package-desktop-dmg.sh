#!/bin/zsh
set -eu
project_dir="${0:A:h:h}"
app_path="$project_dir/dist/Cove.app"
if [[ ! -d "$app_path" ]]; then
  echo '먼저 npm run desktop:build를 실행해 주세요.' >&2
  exit 1
fi
app_version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app_path/Contents/Info.plist")"
app_arch="$(uname -m)"
if [[ "$app_arch" = "x86_64" ]]; then app_arch="x64"; fi
installer_dir="$(mktemp -d "${TMPDIR:-/tmp/}cove-installer.XXXXXX")"
trap 'rm -rf "$installer_dir"' EXIT
/usr/bin/ditto "$app_path" "$installer_dir/Cove.app"
ln -s /Applications "$installer_dir/Applications"
/usr/bin/hdiutil create -volname Cove -srcfolder "$installer_dir" -ov -format UDZO "$project_dir/dist/Cove-$app_version-mac-$app_arch.dmg"
