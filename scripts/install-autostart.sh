#!/bin/zsh
set -eu

label="com.soriseojae.server"
uid="$(id -u)"
project_dir="${0:A:h:h}"
source_plist="$project_dir/config/$label.plist"
target_dir="$HOME/Library/LaunchAgents"
target_plist="$target_dir/$label.plist"

node_bin="$(command -v node)"
mkdir -p "$target_dir" "$project_dir/data"
"$node_bin" - "$source_plist" "$target_plist" "$node_bin" "$project_dir" <<'NODE'
const fs = require('node:fs');
const [, , source, target, node, project] = process.argv;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
fs.writeFileSync(target, fs.readFileSync(source, 'utf8').replaceAll('{{NODE}}', xml(node)).replaceAll('{{PROJECT}}', xml(project)));
NODE
plutil -lint "$target_plist"
launchctl bootout "gui/$uid/$label" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$target_plist"
launchctl enable "gui/$uid/$label"
launchctl kickstart -k "gui/$uid/$label"

echo "Cove 자동 시작을 설정했습니다: http://127.0.0.1:4317/"
