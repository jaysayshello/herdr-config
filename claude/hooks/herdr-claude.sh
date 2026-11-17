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
# Reports app=claude-code, the same word Claude Code sends natively.
# A claude nested in another claude or omp writes nothing: it inherits the
# outer HC_TERMINAL_ID.
#
# Tests: HERDR_CLAUDE_HOOK_TTY=<file> writes the report there and skips the
# Claude process checks.
# Tests: HERDR_CLAUDE_HOOK_ANCESTORS="zsh login" replaces the ancestor comm walk.

exec >/dev/null 2>&1

set -f
[ -n "$HC_TERMINAL_ID" ] || exit 0
# The system jq first: a version-manager shim on PATH can take seconds to start, and the hook has 5 s.
jq() { if [ -x /usr/bin/jq ]; then /usr/bin/jq "$@"; else command jq "$@"; fi; }
[ -x /usr/bin/jq ] || command -v jq >/dev/null || exit 0

if [ -n "$HERDR_CLAUDE_HOOK_TTY" ]; then
	out=$HERDR_CLAUDE_HOOK_TTY
	for c in $HERDR_CLAUDE_HOOK_ANCESTORS; do
		case "$(basename "$c")" in claude | omp) exit 0 ;; esac
	done
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
	# A claude inside another claude or omp must not change the outer terminal.
	if [ -n "$HERDR_CLAUDE_HOOK_ANCESTORS" ]; then
		for c in $HERDR_CLAUDE_HOOK_ANCESTORS; do
			case "$(basename "$c")" in claude | omp) exit 0 ;; esac
		done
	else
		pid=$ppid
		n=0
		while [ "$n" -lt 12 ] && [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
			line=$(ps -o ppid=,comm= -p "$pid") || break
			set -- $line
			[ $# -ge 2 ] || break
			ppid=$1
			shift
			case "$(basename "$*")" in claude | omp) exit 0 ;; esac
			pid=$ppid
			n=$((n + 1))
		done
	fi
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
	printf '\033]7501;state=%s:app=claude-code\007' "$1" >>"$out"
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
