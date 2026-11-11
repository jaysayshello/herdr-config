#!/bin/sh
# Builds ~/Applications/Herdr Focus.app from herdr-focus.applescript and makes it macOS's handler
# for herdr-focus:// links. Run it again after a change to the .applescript; sync.sh --restore runs it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="$HOME/Applications/Herdr Focus.app"
plist="$app/Contents/Info.plist"

mkdir -p "$HOME/Applications"
rm -rf "$app"
osacompile -o "$app" "$here/herdr-focus.applescript"
plutil -replace CFBundleIdentifier -string com.jay.herdr-focus "$plist"
plutil -replace LSUIElement -bool true "$plist" # no Dock icon
plutil -replace CFBundleURLTypes -json '[{"CFBundleURLName":"Herdr focus","CFBundleURLSchemes":["herdr-focus"]}]' "$plist"
codesign --force --sign - "$app" # the plist change breaks osacompile's signature
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "Installed $app for herdr-focus:// links."
