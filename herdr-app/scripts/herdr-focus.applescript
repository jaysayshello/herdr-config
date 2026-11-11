-- Herdr Focus.app: macOS opens herdr-focus:// links with this applet (herdr-focus-install.sh builds it).
-- It hands the link to herdr-focus.sh in the background and quits, so the pulse does not hold it.
on open location theURL
	do shell script "\"$HOME/.config/herdr-app/scripts/herdr-focus.sh\" " & quoted form of theURL & " >/dev/null 2>&1 &"
end open location
