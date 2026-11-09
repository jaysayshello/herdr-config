# Herdr in WSL: each terminal keeps its own omp session. Sourced from ~/.bashrc;
# saved in herdr-config (windows/wsl/omp-resume.bash).

# Herdr: each terminal keeps its own omp session (breadcrumb written by
# ~/.omp/agent/extensions/herdr-resume.ts). Sets _herdr_omp=(session state) when this
# terminal has one; created_ms must match, so a reused address never does.
_herdr_omp_crumb() {
  local crumb=~/.local/state/omp-herdr-resume/$HC_TERMINAL_ID created session state
  [[ -n $HC_TERMINAL_ID && -r $crumb ]] || return 1
  { read -r created; read -r session; read -r state; } < "$crumb"
  [[ -f $session && $(hc get "$HC_TERMINAL_ID" --json 2>/dev/null) =~ \"created_ms\":([0-9]+) && ${BASH_REMATCH[1]} == "$created" ]] || return 1
  _herdr_omp=("$session" "$state")
}

# Bare `omp` resumes this terminal's session; a new terminal starts a new one.
omp() {
  if (( $# == 0 )) && _herdr_omp_crumb; then command omp --resume "${_herdr_omp[0]}"
  else command omp "$@"; fi
}

# After a reboot or core crash, hc gives each lost terminal a fresh shell. Reopen
# omp if it was running (no `quit` mark). Runs once, at the first prompt.
_herdr_omp_resume() {
  [[ -n $_herdr_omp_done ]] && return
  _herdr_omp_done=1
  _herdr_omp_crumb && [[ ${_herdr_omp[1]} != quit ]] && command omp --resume "${_herdr_omp[0]}"
}
[[ -n $HC_TERMINAL_ID && -z $OMPCODE && $- == *i* ]] && PROMPT_COMMAND="_herdr_omp_resume${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
