# Rex keys

`rex/config/init.lua` gives Rex the same keys as the Herdr setup (`herdr-app/keys.json` and `herdr/config.toml`). It goes to `~/.config/rex/init.lua`. After a change, run `rex config check` and then `rex config reload`.

Herdr spaces are Rex sessions, Herdr tabs are Rex tabs, and Herdr panes are Rex panes. When a Herdr key and a Rex default shortcut are the same key, the Herdr key wins.

## Bindings

| Key | What it does | Herdr equivalent |
| --- | --- | --- |
| `Ctrl+Space` `h` / `j` / `k` / `l` | Focus the pane to the left, below, above, or to the right | Same (`prefix+h/j/k/l`) |
| `Ctrl+Space` `v` | Split the pane to the right | Same (`prefix+v`) |
| `Ctrl+Space` `-` | Split the pane down | Same (`prefix+minus`) |
| `Ctrl+Space` `x` | Close the pane | Same (`prefix+x`) |
| `Ctrl+Space` `z` | Zoom the pane | Same (`prefix+z`) |
| `Ctrl+Space` `Shift+N` | New session | Same (`prefix+shift+n`) |
| `Ctrl+Space` `r` | Reload the Rex config | Same (`prefix+r`, reload config) |
| `Ctrl+Space` `Shift+R` | Resize mode: arrows or `h/j/k/l` resize, `=` balances, Enter or Escape leaves | Same (`prefix+shift+r`) |
| `Ctrl+Space` `g` | Show the `Pull requests` tab of the `orchestrator` session, opening it (with `rex-prs.sh`) if it is missing | New. Herdr showed pull requests in its sidebar (t3-prs) |
| `Ctrl+A` / `Ctrl+D` | Focus the pane to the left / right | Same |
| `Ctrl+E` / `Ctrl+Q` | Split the pane right / down | Same |
| `Alt+W` | Close the pane | Same |
| `Alt+H` / `Alt+L` | Move the pane left / right | Same (swap pane) |
| `Ctrl+H` / `Ctrl+J` / `Ctrl+K` / `Ctrl+L` | Move the pane that way. When vim or nvim runs in the pane, vim gets the key instead | Same (tmux-keys `swap-*`) |
| `Ctrl+R` | Make every pane in the tab the same size | Same (tmux-keys `balance`) |
| `Ctrl+W` / `Ctrl+S` | Previous / next session | Same (`space.prev` / `space.next`) |
| `Ctrl+N` | New session with its shell in `~/Projects` | Same (tmux-keys `new-space`) |
| `Ctrl+F` | Show the session named `orchestrator`. A notification says so when there is none | Same (tmux-keys `orchestrator`) |
| `Alt+1` … `Alt+9`, `Ctrl+1` … `Ctrl+9` | Show the session at that place in the session list | Same (`space.select:N`) |
| `Cmd+1` … `Cmd+9` | Show the tab at that place | Same (`tab.select:N`) |
| `Cmd+T` / `Cmd+W` | New tab / close the tab | Same |
| `Ctrl+Tab`, `Cmd+Shift+]` | Next tab | Same |
| `Ctrl+Shift+Tab`, `Cmd+Shift+[` | Previous tab | Same |
| `Cmd+Alt+]` / `Cmd+Alt+[` | Next / previous session | Same |
| `Cmd+]` / `Cmd+[` | Next / previous pane | Same (`agent.next` / `agent.prev`) |
| `Cmd+N` | New session | Same (`space.new`) |
| `Cmd+P` | Session picker | Same (`mod.open:picker`) |
| `Cmd+Shift+P` | Command palette | Same |
| `Cmd+D` / `Cmd+Shift+D` | Split the pane right / down | Same |
| `Cmd+Shift+W` | Close the pane | Same |
| `Cmd+Shift+Enter` | Zoom the pane | Same |
| `Cmd+Alt+Arrow` | Focus the pane that way | Same |
| `Cmd+Alt+Shift+Arrow` | Move the pane that way | Same (swap pane) |
| `F2` / `Shift+F2` | Rename the tab / the session | Same |
| `Cmd+B` | Show or hide the sidebar | Same (`layout.toggle:sidebar`) |
| `Cmd+,` | Settings | Same |
| `Cmd+=`, `Cmd+Shift+=` / `Cmd+-` / `Cmd+0` | Bigger / smaller / normal text | Same (app zoom) |
| `Alt+Left` / `Alt+Right` | Word left / right in the shell (types `ESC b` / `ESC f`) | Same |
| `Alt+Backspace` | Delete the word before the cursor (`^W`) | Same |
| `Cmd+Left` / `Cmd+Right` | Start / end of the line (`^A` / `^E`) | Same |
| `Cmd+Backspace` | Delete to the start of the line (`^U`) | Same |
| `Cmd+C` / `Cmd+V` | Copy / paste (Rex defaults) | Same |
| `Cmd+Q` / `Cmd+H` / `Cmd+Alt+H` | Quit / hide / hide others (macOS menu, not Rex keys) | Same |

### Rex defaults these keys replace

| Key | Rex default | Now |
| --- | --- | --- |
| `Cmd+N` | New app window | New session. New Window stays in the command palette |
| `Cmd+W` | Close the pane, else the tab | Close the tab |
| `Cmd+Shift+W` | Close the app window | Close the pane |
| `Cmd+P` | Go to Anything (newer Rex builds) | Session picker |
| `Ctrl+Space` | Sent to the terminal | Starts the prefix keys, so programs no longer get it |
| `Ctrl+A/D/E/Q/R/W/S/N/F/H/J/K/L` | Sent to the terminal (shell keys such as `^A` line start, `^R` history search) | Herdr's keys, as in Herdr |

## Keyboard gaps

| Herdr key or feature | Why Rex has no equivalent |
| --- | --- |
| `Ctrl+Space` `p`: pin or unpin a space | Rex has no pinned sessions. |
| `Ctrl+Space` `o`: move a space into the Operational section | The Rex sidebar has no sections. |
| `Ctrl+W` / `Ctrl+S` past the last space, into the Pull requests list | The Rex sidebar can't hold a pull request list, so the list is a tab (`Ctrl+Space` `g`). `Ctrl+W` / `Ctrl+S` only change sessions. |
| Pull request clicks: Ready / Draft, merge, close (t3-prs) | `rex-prs.sh` is a read-only list in a terminal. Cmd+click opens a pull request on GitHub, where those buttons are. |
| `Cmd+Shift+B` (t3-chrome sidebar), `Cmd+Shift+H` (t3-chrome bars), `Cmd+Shift+A` (t3-tabs view), `Cmd+Shift+S` (t3-inbox settle) | These are Herdr t3 mods (custom panels). Rex has no mods, so these keys keep their Rex defaults (`Cmd+Shift+S` toggles the toolbar layout). |
| `Cmd+Shift+L`: switch layout | Rex has one window layout, with no layouts to switch between. |
| `Cmd+/`, `Cmd+Shift+/`: help | Rex has no help screen. `Cmd+/` keeps its Rex default (show or hide the sidebar). |
| `Ctrl+V`: paste an image | Rex has no image paste action. The key goes to the program in the pane. |
| The green border pulse on a `herdr-focus://` link | Rex can't flash a pane border for the app: a terminal's `set_theme` only applies for the client that owns the block. `rex-focus://` links only focus the terminal. |
| `rex-focus://` links and `Ctrl+F`-style jumps from outside Rex | The app takes actions from the CLI only with Settings > Server > Client Info > Remote Control on. Without it, `rex-focus.sh` focuses the terminal in its session, brings Rex to the front, and shows a notification asking to turn Remote Control on. Keys inside Rex work either way. |

## Scripts

- `scripts/rex-prs.sh`: the live Pull requests list (one `gh api graphql` call every 60 seconds). `r` refreshes now and `q` quits. Install it as `~/.config/rex/scripts/rex-prs.sh`.
- `scripts/rex-focus.sh`: opens `rex-focus://<session uuid>/<block uuid>` links. Install it as `~/.config/rex/scripts/rex-focus.sh`.
- `scripts/rex-focus-install.sh`: builds `~/Applications/Rex Focus.app` from `rex-focus.applescript` and registers it for `rex-focus://` links.
