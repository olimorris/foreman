-- Foreman's calls into Ghostty's AppleScript dictionary, run as: osascript ghostty.applescript COMMAND ARGS...
-- Replies are plain text, one value per line, because osascript prints an AppleScript list as "a, b".
-- Variables avoid Ghostty's terms (command, name, id, tab, tty) or AppleScript reads them as properties.

on run argv
	set action to item 1 of argv
	set args to rest of argv
	if action is "new-session" then return newSession(item 1 of args, item 2 of args, item 3 of args, item 4 of args)
	-- Without this, a check from outside Ghostty such as the watcher's would launch it.
	if not (application id "com.mitchellh.ghostty" is running) then
		if action is in {"open", "split", "send"} then error "Ghostty isn't running"
		return ""
	end if
	if action is "whoami" then return terminalOnTty(item 1 of args)
	if action is "find-session" then return findSession(item 1 of args)
	if action is "open" then return openTab(item 1 of args, item 2 of args, item 3 of args, item 4 of args, item 5 of args)
	if action is "split" then return splitBeside(item 1 of args, item 2 of args, item 3 of args, item 4 of args, item 5 of args)
	if action is "tty" then return ttyOf(item 1 of args)
	if action is "send" then return sendText(item 1 of args, item 2 of args)
	if action is "close" then return closeTab(item 1 of args, item 2 of args)
	if action is "close-tty" then return closeTty(item 1 of args)
	error "ghostty.applescript: unknown command " & action
end run

on surface(cwd, pathEnv, cmdLine)
	tell application id "com.mitchellh.ghostty"
		set config to new surface configuration
		set initial working directory of config to cwd
		set command of config to cmdLine
		set environment variables of config to {pathEnv}
	end tell
	return config
end surface

on newSession(sessionName, cwd, pathEnv, cmdLine)
	tell application id "com.mitchellh.ghostty"
		set made to new window with configuration my surface(cwd, pathEnv, cmdLine)
		set opened to tab 1 of made
		set name override of opened to sessionName
		return id of terminal 1 of opened
	end tell
end newSession

on findSession(sessionName)
	tell application id "com.mitchellh.ghostty"
		repeat with w in windows
			repeat with t in tabs of w
				if name override of t is sessionName then return id of terminal 1 of t
			end repeat
		end repeat
	end tell
	return ""
end findSession

on terminalOnTty(device)
	tell application id "com.mitchellh.ghostty"
		set matches to id of every terminal whose tty is device
	end tell
	if (count of matches) is 0 then return ""
	return item 1 of matches
end terminalOnTty

on tabHolding(terminalId)
	tell application id "com.mitchellh.ghostty"
		repeat with w in windows
			repeat with t in tabs of w
				if (id of terminals of t) contains terminalId then return contents of t
			end repeat
		end repeat
	end tell
	error "Ghostty has no terminal " & terminalId & ". Run foreman from the Ghostty tab you started it in."
end tabHolding

on windowHolding(terminalId)
	tell application id "com.mitchellh.ghostty"
		repeat with w in windows
			if (id of terminals of w) contains terminalId then return contents of w
		end repeat
	end tell
	error "Ghostty has no terminal " & terminalId & ". Run foreman from the Ghostty tab you started it in."
end windowHolding

on openTab(anchorId, label, cwd, pathEnv, cmdLine)
	set w to windowHolding(anchorId)
	tell application id "com.mitchellh.ghostty"
		set previousTab to id of selected tab of w
		set made to new tab in w with configuration my surface(cwd, pathEnv, cmdLine)
		set name override of made to label
		set reply to (id of made) & linefeed & (id of terminal 1 of made)
	end tell
	-- Ghostty always selects a new tab, so put the user back on the tab they were reading.
	reselect(previousTab)
	return reply
end openTab

on reselect(tabId)
	tell application id "com.mitchellh.ghostty"
		repeat with w in windows
			repeat with t in tabs of w
				if id of t is tabId then
					select tab t
					return
				end if
			end repeat
		end repeat
	end tell
end reselect

on splitBeside(anchorId, label, cwd, pathEnv, cmdLine)
	set holder to tabHolding(anchorId)
	tell application id "com.mitchellh.ghostty"
		set made to split terminal id anchorId direction right with configuration my surface(cwd, pathEnv, cmdLine)
		set name override of made to label
		-- A split takes keyboard focus, and the focus command would also raise the window, so move focus back as a split action instead.
		perform action "goto_split:left" on made
		return (id of holder) & linefeed & (id of made)
	end tell
end splitBeside

on ttyOf(terminalId)
	tell application id "com.mitchellh.ghostty"
		try
			return tty of terminal id terminalId
		on error
			return ""
		end try
	end tell
end ttyOf

on sendText(terminalId, message)
	tell application id "com.mitchellh.ghostty"
		input text message to terminal id terminalId
		send key "enter" to terminal id terminalId
	end tell
	return ""
end sendText

on closeTab(tabId, terminalId)
	tell application id "com.mitchellh.ghostty"
		repeat with w in windows
			repeat with t in tabs of w
				if id of t is tabId then
					close tab t
					return ""
				end if
			end repeat
		end repeat
		try
			close terminal id terminalId
		end try
	end tell
	return ""
end closeTab

on closeTty(device)
	tell application id "com.mitchellh.ghostty"
		repeat with t in (every terminal whose tty is device)
			close t
		end repeat
	end tell
	return ""
end closeTty
