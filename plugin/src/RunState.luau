--!nonstrict
--[[
	Edit and playtest state. Spec sections 13 and 15.

	Studio does not hand the plugin one stable DataModel. Starting a playtest
	replaces it, and which realm the plugin lands in differs between Run and
	Play. Everything the agent sees is stamped with the realm so a missing
	LocalPlayer reads as "wrong realm", not as a bug in the game.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local Changes = require(script.Parent.Changes)
local Handles = require(script.Parent.Handles)

local RunState = {}

local epoch = 0
local lastRunning: boolean? = nil
local listeners: { (any) -> () } = {}

local function detectRealm(running: boolean): string
	if not running then
		return "edit"
	end

	local isClient = RunService:IsClient()
	local isServer = RunService:IsServer()

	if isClient and not isServer then
		return "client"
	elseif isServer and not isClient then
		return "server"
	elseif isClient and isServer then
		-- Play Solo runs both roles in one DataModel; LocalPlayer decides which
		-- view the agent actually gets.
		return Players.LocalPlayer ~= nil and "client" or "server"
	end

	return "unknown"
end

local function detectMode(running: boolean): string?
	if not running then
		return nil
	end
	-- Run mode has no player at all; Play always produces one.
	if RunService:IsRunMode() and Players.LocalPlayer == nil and #Players:GetPlayers() == 0 then
		return "run"
	end
	return "play"
end

--[[
	True once there is something meaningful to observe: a player with a
	character in Play, or simply a running server in Run.
]]
function RunState.isReady(requireCharacter: boolean?): boolean
	if not RunService:IsRunning() then
		return false
	end

	local localPlayer = Players.LocalPlayer
	if localPlayer == nil then
		-- Run mode: the place is up as soon as it is running.
		return #Players:GetPlayers() == 0 or not requireCharacter
	end

	if requireCharacter == false then
		return true
	end

	local character = localPlayer.Character
	return character ~= nil and character:FindFirstChildOfClass("Humanoid") ~= nil
end

function RunState.current(): any
	local running = RunService:IsRunning()

	return {
		running = running,
		edit = not running,
		mode = detectMode(running),
		realm = detectRealm(running),
		epoch = epoch,
		ready = RunState.isReady(true),
	}
end

function RunState.onChanged(listener: (any) -> ())
	table.insert(listeners, listener)
end

local function emit()
	local state = RunState.current()
	for _, listener in ipairs(listeners) do
		task.spawn(listener, state)
	end
end

--[[
	Polls for edit/run transitions.

	RunService exposes no reliable "mode changed" signal to plugins across all
	Studio versions, and a plugin is often torn down and recreated across the
	transition anyway. A cheap poll is both simpler and more robust than
	chasing version-specific signals.
]]
function RunState.start()
	lastRunning = RunService:IsRunning()
	-- The epoch is derived from the run state at load: a plugin that starts up
	-- inside a playtest must not hand out handles that look edit-time.
	epoch = lastRunning and 1 or 0
	Handles.setEpoch(epoch)

	task.spawn(function()
		while true do
			task.wait(0.25)
			local running = RunService:IsRunning()
			if running ~= lastRunning then
				lastRunning = running
				epoch += 1
				Handles.setEpoch(epoch)
				-- Held copies of deleted instances belong to the DataModel they
				-- were taken from. Carrying one across the transition would
				-- restore an edit-time instance into a running world, or the
				-- reverse.
				Changes.release()
				emit()
			end
		end
	end)

	-- Character spawn flips `ready` without changing the run state, and agents
	-- wait on that far more often than on the transition itself.
	task.spawn(function()
		local localPlayer = Players.LocalPlayer
		if localPlayer == nil then
			return
		end
		localPlayer.CharacterAdded:Connect(function()
			task.wait(0.1)
			emit()
		end)
	end)
end

function RunState.epoch(): number
	return epoch
end

--[[
	Waits until the experience is observable, or until the deadline passes.
	Returns the final state either way so the caller can report honestly.
]]
function RunState.waitReady(timeoutSeconds: number, requireCharacter: boolean): any
	local deadline = os.clock() + timeoutSeconds

	while os.clock() < deadline do
		if RunState.isReady(requireCharacter) then
			break
		end
		task.wait(0.1)
	end

	local state = RunState.current()
	state.ready = RunState.isReady(requireCharacter)
	return state
end

return RunState
