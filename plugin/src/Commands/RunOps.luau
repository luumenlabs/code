--!nonstrict
--[[
	Playtest control. Spec section 13.

	Starting and stopping a playtest replaces the DataModel the plugin lives in,
	so these handlers deliberately return as soon as the request has been
	issued. The local server is the one that waits for the new state, because it
	survives the transition and this plugin instance may not.
]]

local RunService = game:GetService("RunService")

local Errors = require(script.Parent.Parent.Errors)
local InputBridge = require(script.Parent.Parent.InputBridge)
local RunState = require(script.Parent.Parent.RunState)

local RunOps = {}

--[[
	Studio exposes no API for "Play" (the mode with a character), only for
	"Run". Sending the shortcut through VirtualInputManager is the one path that
	reaches Studio's own command, and if it does not take effect the server
	falls back to native input rather than pretending it worked.
]]
local function sendStudioShortcut(keyName: string, withShift: boolean): boolean
	local ok = pcall(function()
		local vim = game:GetService("VirtualInputManager")
		local shift = Enum.KeyCode.LeftShift

		if withShift then
			vim:SendKeyEvent(true, shift, false, game)
		end

		vim:SendKeyEvent(true, (Enum.KeyCode :: any)[keyName], false, game)
		task.wait(0.05)
		vim:SendKeyEvent(false, (Enum.KeyCode :: any)[keyName], false, game)

		if withShift then
			vim:SendKeyEvent(false, shift, false, game)
		end
	end)

	return ok
end

function RunOps.state(): any
	return RunState.current()
end

function RunOps.start(params: any): any
	if RunService:IsRunning() then
		Errors.throw(
			"PLAYTEST_ALREADY_RUNNING",
			"A playtest is already running",
			{ state = RunState.current() },
			"Use run.restart to start a fresh session, or run.stop first."
		)
	end

	local mode = params.mode or "play"

	if mode == "run" then
		local ok, err = pcall(function()
			RunService:Run()
		end)

		if not ok then
			Errors.throw("UNSUPPORTED_CAPABILITY", string.format("Studio refused to start Run mode: %s", tostring(err)))
		end

		return RunState.current()
	end

	if not sendStudioShortcut("F5", false) then
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			"Play mode could not be started from the Studio plugin",
			{ mode = mode },
			'Use mode "run" for a server-only playtest, or enable native input so Luu Code can press Play for you.'
		)
	end

	-- The state has almost certainly not changed yet; the server polls for it.
	return RunState.current()
end

function RunOps.stop(): any
	if not RunService:IsRunning() then
		return RunState.current()
	end

	local ok = pcall(function()
		RunService:Stop()
	end)

	if not ok then
		sendStudioShortcut("F5", true)
	end

	return RunState.current()
end

function RunOps.waitReady(params: any): any
	if not RunService:IsRunning() then
		Errors.throw("PLAYTEST_NOT_RUNNING", "Nothing is running to wait for", { state = RunState.current() }, "Start a playtest first.")
	end

	local timeoutSeconds = (params.timeoutMs or 30000) / 1000
	local requireCharacter = params.requireCharacter ~= false

	return RunState.waitReady(timeoutSeconds, requireCharacter)
end

function RunOps.capabilities(): (boolean, boolean)
	local canRun = pcall(function()
		return RunService.Run ~= nil
	end)
	return canRun, InputBridge.isAvailable()
end

return RunOps
