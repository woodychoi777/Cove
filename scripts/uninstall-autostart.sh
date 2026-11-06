#!/bin/zsh
set -eu

label="com.soriseojae.server"
uid="$(id -u)"
target_plist="$HOME/Library/LaunchAgents/$label.plist"

launchctl bootout "gui/$uid/$label" 2>/dev/null || true
if [[ -f "$target_plist" ]]; then
  mv "$target_plist" "$HOME/.Trash/$label.plist"
fi

echo "소리서재 자동 시작을 해제했습니다. 설정 파일은 휴지통으로 이동했습니다."
