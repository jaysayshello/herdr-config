# shellcheck shell=sh
# Shared by install-macos.sh and install-windows.sh, which source it. Not a script of its own.
# It never deletes a live file. A live file that differs from the repo is saved under
# ~/.local/state/herdr-config/backup-<time>/ before it is replaced, so a run can be undone.
# Copies, not symlinks: Herdr writes its files atomically, which replaces a symlink with a plain
# file, and it does not load a mod's own SVGs through a symlink.

FILES_ONLY=
case "${1:-}" in
  "") ;;
  --files-only) FILES_ONLY=1 ;;
  # The calling script's header comment is its help.
  -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
  *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
esac
command -v jq >/dev/null || { echo "${0##*/} needs jq" >&2; exit 1; }

ORCHESTRATOR=${HERDR_ORCHESTRATOR:-$HOME/Projects/herdr-orchestrator-2026-11-08}
BACKUP=${XDG_STATE_HOME:-$HOME/.local/state}/herdr-config/backup-$(date +%Y%m%d-%H%M%S)
UPDATED=0

# show <words> <path>: print with ~ for the home folder.
show() { case $2 in "$HOME"/*) printf '%s ~/%s\n' "$1" "${2#"$HOME"/}" ;; *) printf '%s %s\n' "$1" "$2" ;; esac; }

# write <file> <new content file> [mode]: replace atomically, after a backup of the old file.
# A repo symlink (peon's theme script) is installed as the same symlink. A live symlink (a file
# kept in another repo) stays, and its target gets the new content.
# The temp name starts with a dot, so Herdr does not load it as a mod file.
write() {
  if [ -L "$2" ]; then
    [ "$(readlink "$1" 2>/dev/null)" != "$(readlink "$2")" ] || return 0
  else
    [ ! -L "$1" ] || set -- "$(readlink -f "$1")" "$2" "${3:-}"
    if [ -f "$1" ] && cmp -s "$2" "$1"; then return 0; fi
  fi
  dir=${1%/*}
  if [ -e "$1" ] || [ -L "$1" ]; then
    mkdir -p "$BACKUP$dir"
    cp -pR "$1" "$BACKUP$1"
  fi
  [ -d "$dir" ] || mkdir -p "$dir"
  tmp=$(mktemp "$dir/.install.XXXXXX")
  if [ -L "$2" ]; then
    rm -f "$tmp"
    ln -s "$(readlink "$2")" "$tmp"
    # mv onto a symlink to a folder would move the new link into that folder.
    [ ! -L "$1" ] || rm -f "$1"
  else
    cat "$2" > "$tmp"
    if [ -n "${3:-}" ]; then chmod "$3" "$tmp"; elif [ -x "$2" ]; then chmod 755 "$tmp"; else chmod 644 "$tmp"; fi
  fi
  mv "$tmp" "$1"
  show updated "$1"
  UPDATED=$((UPDATED + 1))
}

# put <repo dir> <live dir> <paths...>: install files or whole folders. Live files that are not
# in the repo stay (Herdr's generated *.d.ts, jsconfig.json, an extension only on this machine).
put() {
  from=$1 to=$2; shift 2
  list=$(mktemp)
  for p in "$@"; do
    if [ -d "$from/$p" ]; then
      (cd "$from" && find "$p" \( -type f -o -type l \) ! -name .DS_Store ! -name '*.d.ts' ! -name jsconfig.json ! -name '*.bak*') >> "$list"
    else
      [ -f "$from/$p" ] || { echo "missing in the repo: $from/$p" >&2; rm -f "$list"; exit 1; }
      printf '%s\n' "$p" >> "$list"
    fi
  done
  while IFS= read -r f; do write "$to/$f" "$from/$f"; done < "$list"
  rm -f "$list"
}

# put_herdr_app <repo herdr-app dir> <live herdr-app dir>: the layout, its mods, keys, settings and
# theme, laid out as a Herdr layout folder (herdr.dev/gallery). Every folder in mods/ is mine.
put_herdr_app() {
  set -- "$1" "$2" keys.json settings.json layouts/herdr-t3.json layouts/herdr-t3.svg themes/ghostty.json scripts
  for m in "$1"/mods/*/; do set -- "$@" "mods/$(basename "$m")"; done
  [ ! -d "$1/peon" ] || set -- "$@" peon
  put "$@"
}

# Claude Code reads hooks from settings.json. Add the Herdr hook to each event that lacks it and
# keep every other hook. The events are the ones listed at the top of the hook script.
register_claude_hook() {
  settings=$HOME/.claude/settings.json
  # mktemp files are private (600), so tokens in settings.json never sit in a readable file.
  old=$(mktemp)
  new=$(mktemp)
  if [ -f "$settings" ]; then cat "$settings" > "$old"; else printf '{}\n' > "$old"; fi
  if ! jq --arg cmd 'sh ~/.claude/hooks/herdr-claude.sh' '
    reduce ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
            "Stop", "StopFailure", "PreCompact", "SessionEnd") as $e (.;
      if any(.hooks[$e][]?.hooks[]?; (.command // "") | contains("herdr-claude.sh")) then .
      else .hooks[$e] += [{matcher: "", hooks: [{type: "command", command: $cmd, timeout: 5}]}] end)
  ' "$old" > "$new" 2>/dev/null; then
    echo "cannot read $settings as JSON, the Claude hook is not registered" >&2
    rm -f "$old" "$new"
    return 0
  fi
  # jq can lay the file out differently, so compare the JSON values, not the bytes.
  if jq -e --slurpfile was "$old" '. == $was[0]' "$new" >/dev/null; then rm -f "$old" "$new"; return 0; fi
  # Keep the settings file's own mode: it can hold tokens.
  mode=644
  [ ! -f "$settings" ] || mode=$(stat -L -c '%a' "$settings" 2>/dev/null || stat -L -f '%Lp' "$settings")
  write "$settings" "$new" "$mode"
  rm -f "$old" "$new"
}

# The parts that are the same on both: omp's per-terminal session resume, the orchestrator
# space's prompt, agents, herdr_* tools and extensions (herdr_watch, the spaces list, PR notices,
# PR fix agents, /reload, /claude and /omp), and the Claude Code hook.
put_shared() {
  put "$REPO/omp" "$HOME/.omp/agent" extensions/herdr-resume.ts
  put "$REPO/orchestrator/.omp" "$ORCHESTRATOR/.omp" APPEND_SYSTEM.md agents tools lib extensions
  put "$REPO/claude" "$HOME/.claude" hooks/herdr-claude.sh
  register_claude_hook
}

# Prints what the copy changed. With --files-only, the run ends here.
report_files() {
  if [ "$UPDATED" -eq 0 ]; then
    echo "All files were already up to date."
  else
    echo "$UPDATED files updated."
    [ ! -d "$BACKUP" ] || show "The old versions are in" "$BACKUP"
  fi
  [ -z "$FILES_ONLY" ] || exit 0
}

# The Herdr app reloads its files by itself. When it is open, show the herdr-t3 layout and report
# any file it could not load.
check_herdr_app() {
  if command -v herdr-app >/dev/null && status=$(herdr-app status 2>/dev/null); then
    if [ "$(printf '%s' "$status" | jq -r .layout)" != herdr-t3 ]; then
      # shellcheck disable=SC1010 # `do` is herdr-app's subcommand.
      herdr-app do layout.switch --name herdr-t3 >/dev/null && echo "Switched the Herdr app to the herdr-t3 layout."
    fi
    sleep 1
    errors=$(herdr-app status 2>/dev/null | jq -r '.errors[]? | tostring')
    if [ -n "$errors" ]; then
      printf 'The Herdr app reports errors:\n%s\n' "$errors" >&2
      exit 1
    fi
    echo "The Herdr app loaded everything with no errors."
  else
    echo "The Herdr app is not open. It loads the files when it starts."
  fi
}
