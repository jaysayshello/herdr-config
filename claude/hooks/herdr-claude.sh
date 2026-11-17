#!/bin/sh
# Claude Code hook: reports Claude's state to Herdr (OSC 7501) and keeps the
# resume breadcrumb ~/.local/state/claude-herdr-resume/<HC_TERMINAL_ID>.
# Silent on stdout (Claude reads it) and always exits 0.
#
# Add under "hooks" in ~/.claude/settings.json (append to any existing lists):
#
#   "SessionStart":      [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}],
#   "UserPromptSubmit":  [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}],
#   "PreToolUse":        [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}],
#   "PostToolUse":       [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}],
#   "PermissionRequest": [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}],
#   "Stop":              [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}],
#   "StopFailure":       [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}],
#   "PreCompact":        [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}],
#   "SessionEnd":        [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.claude/hooks/herdr-claude.sh", "timeout": 5}]}]
#
# Tests: HERDR_CLAUDE_HOOK_TTY=<file> writes the report there and skips the
# Claude process checks.

exec >/dev/null 2>&1

set -f
[ -n "$HC_TERMINAL_ID" ] || exit 0
command -v jq >/dev/null || exit 0

if [ -n "$HERDR_CLAUDE_HOOK_TTY" ]; then
	out=$HERDR_CLAUDE_HOOK_TTY
else
	# The hook may run under a sh -c, so walk up to the claude process.
	pid=$PPID
	claude=
	n=0
	while [ "$n" -lt 6 ] && [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
		line=$(ps -o ppid=,comm= -p "$pid") || break
		set -- $line
		[ $# -ge 2 ] || break
		ppid=$1
		shift
		if [ "$(basename "$*")" = claude ]; then
			claude=$pid
			break
		fi
		pid=$ppid
		n=$((n + 1))
	done
	[ -n "$claude" ] || exit 0
	# claude -p (for example started by omp) must not change this terminal. Only the args before
	# ` -- ` count: the prompt after it can contain -p.
	a=$(ps -o args= -p "$claude")
	case " ${a%% -- *} " in
	*" -p "* | *" --print "*) exit 0 ;;
	esac
	case "$(ps -o stat= -p "$claude")" in
	*+*) ;;
	*) exit 0 ;;
	esac
	# A hook can have no controlling terminal, so write to Claude's tty.
	tty=$(ps -o tty= -p "$claude" | tr -d ' ')
	case "$tty" in
	'' | '?' | '??') exit 0 ;;
	esac
	out=/dev/$tty
fi

input=$(cat)
event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')

report() {
	printf '\033]7501;state=%s:app=claude\007' "$1" >>"$out"
}

dir=$HOME/.local/state/claude-herdr-resume
crumb=$dir/$HC_TERMINAL_ID

case "$event" in
SessionStart)
	# SessionStart also fires after an auto-compaction, mid-turn: that one is not idle.
	[ "$(printf '%s' "$input" | jq -r '.source // empty')" = compact ] || report idle
	transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
	created=$(hc get "$HC_TERMINAL_ID" --json | jq -r '.created_ms // empty')
	[ -n "$transcript" ] && [ -n "$created" ] || exit 0
	mkdir -p "$dir" || exit 0
	tmp=$crumb.tmp.$$
	printf '%s\n%s\n' "$created" "$transcript" >"$tmp" && mv -f "$tmp" "$crumb"
	rm -f "$tmp"
	;;
UserPromptSubmit | PreToolUse | PostToolUse | PreCompact) report working ;;
PermissionRequest) report blocked ;;
Stop) report done ;;
StopFailure) report error ;;
SessionEnd)
	# A stop by a signal (a reboot) writes no quit, so the terminal resumes.
	reason=$(printf '%s' "$input" | jq -r '.reason // empty')
	case "$reason" in
	prompt_input_exit | logout) ;;
	*) exit 0 ;;
	esac
	[ -f "$crumb" ] || exit 0
	transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
	[ -n "$transcript" ] && [ "$(sed -n 2p "$crumb")" = "$transcript" ] || exit 0
	tmp=$crumb.tmp.$$
	{ sed -n 1,2p "$crumb"; echo quit; } >"$tmp" && mv -f "$tmp" "$crumb"
	rm -f "$tmp"
	;;
esac
exit 0
