#!/bin/sh
# Builds ~/Applications/Rex Focus.app from rex-focus.applescript and makes it macOS's handler
# for rex-focus:// links. Run it again after a change to the .applescript.
# The applet runs ~/.config/rex/scripts/rex-focus.sh, so install that script there too.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="$HOME/Applications/Rex Focus.app"
plist="$app/Contents/Info.plist"

mkdir -p "$HOME/Applications"
rm -rf "$app"
osacompile -o "$app" "$here/rex-focus.applescript"
plutil -replace CFBundleIdentifier -string com.jay.rex-focus "$plist"
plutil -replace LSUIElement -bool true "$plist" # no Dock icon
plutil -replace CFBundleURLTypes -json '[{"CFBundleURLName":"Rex focus","CFBundleURLSchemes":["rex-focus"]}]' "$plist"
codesign --force --sign - "$app" # the plist change breaks osacompile's signature
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "Installed $app for rex-focus:// links."
