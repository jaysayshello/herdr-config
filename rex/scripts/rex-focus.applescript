-- Rex Focus.app: macOS opens rex-focus:// links with this applet (rex-focus-install.sh builds it).
-- It hands the link to rex-focus.sh in the background and quits.
on open location theURL
	do shell script "\"$HOME/.config/rex/scripts/rex-focus.sh\" " & quoted form of theURL & " >/dev/null 2>&1 &"
end open location
