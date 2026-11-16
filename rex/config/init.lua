-- Rex keys that mirror the Herdr setup (herdr-app/keys.json and herdr/config.toml).
-- Installed as ~/.config/rex/init.lua. After a change: rex config check, then rex config reload.
-- rex/KEYS.md lists every binding with its Herdr equivalent, and the Herdr keys Rex can't do.
--
-- A binding the user had in Herdr wins over a Rex default shortcut on the same key.
-- Keys that need more than one call run a custom action below (rex.client.queue only works
-- from an action, not from a function bound straight to a key).

local HOME = os.getenv("HOME") or ""
local TERMINAL = "com.superlogical.terminal"
local SHELL = "com.superlogical.terminal.shell"
local ORCHESTRATOR = "orchestrator"
local PRS_TAB = "Pull requests"
local PRS_SCRIPT = HOME .. "/.config/rex/scripts/rex-prs.sh"

-- A macOS notification, for things the user must see (an action's log is easy to miss).
local function notify(title, body)
  rex.log("warn", title .. ": " .. body)
  local esc = function(s) return (s:gsub("\\", "\\\\"):gsub('"', '\\"')) end
  rex.exec({ "osascript", "-e",
    'display notification "' .. esc(body) .. '" with title "' .. esc(title) .. '"' })
end

local function sessions()
  local r, err = rex.call("session.list")
  if r == nil then error(err, 0) end
  return r.sessions or {}
end

local function session_named(label)
  for _, s in ipairs(sessions()) do
    if s.label == label then return s end
  end
end

-- Bytes typed into the focused terminal, as if the user pressed the keys.
local function write(ctx, data)
  local _, err = rex.block.call(TERMINAL, "write", { block_id = ctx.block_id, data = data })
  if err ~= nil then error(err, 0) end
end

---------------------------------------------------------------------------------------------
-- Custom actions
---------------------------------------------------------------------------------------------

-- Ctrl+h/j/k/l (tmux-keys swap-*): (n)vim gets the key, else the pane moves that way.
-- Same test as tmux's is_vim and Herdr's tmux-keys mod: /^g?(view|n?vim?x?)(diff)?$/i on the
-- foreground program's name or first argument.
local function is_vim(name)
  if type(name) ~= "string" or name == "" then return false end
  local n = name:match("([^/]+)$"):lower():gsub("^%-", ""):gsub("diff$", "")
  return n:match("^g?view$") ~= nil or n:match("^g?n?vim?x?$") ~= nil
end

-- The control byte each key sends: ctrl+h BS, ctrl+j LF, ctrl+k VT, ctrl+l FF.
local CTRL = { left = "\8", down = "\10", up = "\11", right = "\12" }

rex.action{
  name = "swap_or_vim",
  title = "Move Pane (Vim Gets the Key)",
  description = "Ctrl+h/j/k/l: sends the key to vim or nvim when it runs in the pane, else moves the pane.",
  category = "Pane",
  args = { direction = "string" },
  run = function(ctx, args)
    local dir = args.direction
    if CTRL[dir] == nil then error("direction must be left, down, up or right", 0) end
    local p = ctx.block_id and rex.block.call(TERMINAL, "process", { block_id = ctx.block_id })
    local fg = p and p.foreground
    if fg and (is_vim(fg.name) or is_vim(fg.argv0) or is_vim(fg.path)) then
      write(ctx, CTRL[dir])
    else
      rex.client.queue("pane.move", { direction = dir })
    end
  end,
}

-- Alt+1..9 / Ctrl+1..9: the session at that place in the session list.
rex.action{
  name = "session_at",
  title = "Go to Session by Position",
  category = "Session",
  args = { index = "integer" },
  run = function(ctx, args)
    local s = sessions()[args.index]
    if s then rex.client.queue("session.select", { session_id = s.session_id }) end
  end,
}

-- Ctrl+f: the session named "orchestrator" (by name: ids change when it is made again).
rex.action{
  name = "orchestrator",
  title = "Show Orchestrator",
  category = "Session",
  run = function(ctx, args)
    local s = session_named(ORCHESTRATOR)
    if s then
      rex.client.queue("session.select", { session_id = s.session_id })
    else
      notify("No orchestrator session", 'Name a session "' .. ORCHESTRATOR .. '" (Shift+F2).')
    end
  end,
}

-- Ctrl+n: a new session whose shell starts in ~/Projects.
rex.action{
  name = "new_project_session",
  title = "New Session in ~/Projects",
  category = "Session",
  run = function(ctx, args)
    local r, err = rex.call("session.create", {
      initial_windows = { {
        layout = rex.layout.block{ flavor = SHELL, options = { cwd = HOME .. "/Projects" } },
      } },
    })
    if r == nil then error(err, 0) end
    rex.client.queue("session.select", { session_id = r.session_id })
  end,
}

-- Ctrl+space g: the "Pull requests" tab of the orchestrator session, running rex-prs.sh.
-- Opens the tab when it is missing.
rex.action{
  name = "pull_requests",
  title = "Show Pull Requests",
  category = "Session",
  keywords = "pr github pull requests",
  run = function(ctx, args)
    local s = session_named(ORCHESTRATOR)
    if s == nil then
      notify("No orchestrator session", 'The Pull requests tab lives in the session named "' .. ORCHESTRATOR .. '".')
      return
    end
    -- Another session's windows need the action attached to that session first.
    local _, aerr = rex.session.attach{ session_id = s.session_id }
    if aerr ~= nil then error(aerr, 0) end
    local view, err = rex.session.view{ session_id = s.session_id }
    if view == nil then error(err, 0) end
    for _, w in ipairs(view.windows or {}) do
      if w.label == PRS_TAB then
        rex.client.queue("session.select", { session_id = s.session_id, window_id = w.window_id })
        return
      end
    end
    local w, werr = rex.session.new_window{
      session_id = s.session_id,
      window_label = PRS_TAB,
      layout = rex.layout.block{
        flavor = SHELL,
        options = { command = { PRS_SCRIPT }, cwd = HOME },
      },
    }
    if w == nil then error(werr, 0) end
    rex.client.queue("session.select", { session_id = s.session_id, window_id = w.window_id })
  end,
}

-- Herdr's terminal keys (keys.json "terminal"): readline moves, as raw bytes.
local SENDS = {
  word_left = "\27b",   -- Alt+Left: ESC b
  word_right = "\27f",  -- Alt+Right: ESC f
  delete_word = "\23",  -- Alt+Backspace: ^W
  line_start = "\1",    -- Cmd+Left: ^A
  line_end = "\5",      -- Cmd+Right: ^E
  delete_line = "\21",  -- Cmd+Backspace: ^U
}

rex.action{
  name = "send_readline",
  title = "Send Readline Key",
  description = "Types a readline control sequence into the focused terminal.",
  category = "Pane",
  args = { what = "string" },
  run = function(ctx, args)
    local data = SENDS[args.what]
    if data == nil then error("unknown readline key " .. tostring(args.what), 0) end
    write(ctx, data)
  end,
}

---------------------------------------------------------------------------------------------
-- Bindings (keys.json "global" and herdr/config.toml)
---------------------------------------------------------------------------------------------

-- Tabs (Herdr tabs = Rex tabs). cmd+t, ctrl+tab, ctrl+shift+tab, cmd+shift+[ ] match Rex defaults.
rex.bind("cmd+t", "client.tab.new")
rex.bind("cmd+w", "client.tab.close")          -- Rex default closes the pane first
rex.bind("ctrl+tab", "client.tab.next")
rex.bind("ctrl+shift+tab", "client.tab.previous")
rex.bind("cmd+shift+]", "client.tab.next")
rex.bind("cmd+shift+[", "client.tab.previous")
rex.bind("f2", "client.tab.rename")
for i = 1, 9 do
  rex.bind("cmd+[Digit" .. i .. "]", "client.tab.goto", { index = i })
end

-- Sessions (Herdr spaces = Rex sessions).
rex.bind("cmd+n", "session.new")                -- Rex default: new app window
rex.bind("cmd+alt+]", "session.next")
rex.bind("cmd+alt+[", "session.previous")
rex.bind("ctrl+s", "session.next")
rex.bind("ctrl+w", "session.previous")
rex.bind("shift+f2", "session.rename")
rex.bind("cmd+p", "session.switch")
rex.bind("ctrl+n", "new_project_session")
rex.bind("ctrl+f", "orchestrator")
for i = 1, 9 do
  rex.bind("ctrl+[Digit" .. i .. "]", "session_at", { index = i })
  rex.bind("alt+[Digit" .. i .. "]", "session_at", { index = i })
end

-- Panes (Herdr agents in cmd+[ ] = the panes of the tab).
rex.bind("cmd+]", "pane.focus_next")
rex.bind("cmd+[", "pane.focus_previous")
rex.bind("cmd+d", "pane.split", { direction = "right" })
rex.bind("cmd+shift+d", "pane.split", { direction = "down" })
rex.bind("cmd+shift+w", "pane.close")           -- Rex default: close the app window
rex.bind("cmd+shift+enter", "pane.zoom")
rex.bind("ctrl+a", "pane.focus", { direction = "left" })
rex.bind("ctrl+d", "pane.focus", { direction = "right" })
rex.bind("ctrl+e", "pane.split", { direction = "right" })
rex.bind("ctrl+q", "pane.split", { direction = "down" })
rex.bind("alt+w", "pane.close")
rex.bind("alt+h", "pane.move", { direction = "left" })
rex.bind("alt+l", "pane.move", { direction = "right" })
rex.bind("ctrl+r", "pane.balance")
for _, dir in ipairs({ "left", "right", "up", "down" }) do
  rex.bind("cmd+alt+" .. dir, "pane.focus", { direction = dir })
  rex.bind("cmd+alt+shift+" .. dir, "pane.move", { direction = dir })
end
rex.bind("ctrl+h", "swap_or_vim", { direction = "left" })
rex.bind("ctrl+j", "swap_or_vim", { direction = "down" })
rex.bind("ctrl+k", "swap_or_vim", { direction = "up" })
rex.bind("ctrl+l", "swap_or_vim", { direction = "right" })

-- App.
rex.bind("cmd+b", "client.sidebar.toggle")
rex.bind("cmd+shift+p", "client.palette.toggle")
rex.bind("cmd+,", "client.settings")
rex.bind("cmd+=", "client.font.increase")
rex.bind("cmd+shift+=", "client.font.increase")
rex.bind("cmd+-", "client.font.decrease")
rex.bind("cmd+[Digit0]", "client.font.reset")

-- The ctrl+space prefix (herdr/config.toml [keys], tmux style).
rex.bind("ctrl+space>h", "pane.focus", { direction = "left" })
rex.bind("ctrl+space>j", "pane.focus", { direction = "down" })
rex.bind("ctrl+space>k", "pane.focus", { direction = "up" })
rex.bind("ctrl+space>l", "pane.focus", { direction = "right" })
rex.bind("ctrl+space>v", "pane.split", { direction = "right" })
rex.bind("ctrl+space>-", "pane.split", { direction = "down" })
rex.bind("ctrl+space>x", "pane.close")
rex.bind("ctrl+space>z", "pane.zoom")
rex.bind("ctrl+space>shift+n", "session.new")
rex.bind("ctrl+space>r", "client.config.reload")
rex.bind("ctrl+space>shift+r", "client.mode.enter", { name = "resize" })
rex.bind("ctrl+space>g", "pull_requests")

-- Resize mode (Herdr's prefix+shift+r): arrows or h/j/k/l resize, = balances, Enter or Escape leaves.
rex.mode("resize", { exclusive = true })
for key, dir in pairs({ left = "left", right = "right", up = "up", down = "down",
                        h = "left", l = "right", k = "up", j = "down" }) do
  rex.bind("resize/" .. key, "pane.resize", { direction = dir })
end
rex.bind("resize/=", "pane.balance")
rex.bind("resize/enter", "client.mode.exit")

---------------------------------------------------------------------------------------------
-- Terminal keys (keys.json "terminal"). cmd+c / cmd+v stay Rex's own copy and paste.
---------------------------------------------------------------------------------------------
rex.bind("alt+left", "send_readline", { what = "word_left" })
rex.bind("alt+right", "send_readline", { what = "word_right" })
rex.bind("alt+backspace", "send_readline", { what = "delete_word" })
rex.bind("cmd+left", "send_readline", { what = "line_start" })
rex.bind("cmd+right", "send_readline", { what = "line_end" })
rex.bind("cmd+backspace", "send_readline", { what = "delete_line" })
