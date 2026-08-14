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
local RenderMonitor = require(script.Parent.RenderMonitor)

local RunState = {}

local epoch = 0
local lastRunning: boolean? = nil
local listeners: { (any) -> () } = {}

-- Set by RunOps while its start request is outstanding. Held here because the
-- whole state goes up on every sync, and RunOps already depends on this module.
local pendingStart = false

function RunState.setPendingStart(value: boolean)
	pendingStart = value
end

--[[
	Is the experience up in this DataModel?

	`RunService:IsRunning()` is the direct answer, and when it says yes it is
	believed. It has been caught saying no with a playtest plainly running —
	`{ running = false, playerCount = 1, realm = "edit" }`, reported from a
	DataModel with a player standing in it. Nothing downstream survives that:
	the server starts a playtest and then waits for a peer to say `running`,
	so every `run.start` sat there until it timed out while Studio played the
	game, and the state it reported blamed the edit realm for it.

	So the flag is corroborated with facts about this DataModel rather than
	trusted alone. A `Player` cannot exist without a session — `Players` is
	empty in edit and there is no way to put anything in it — and a DataModel
	that is a server but not a client, or the reverse, is one half of a split
	runtime, which edit never is. Either one means the simulation is up
	whatever the flag says.

	The gap left is Run mode in a Studio that also mis-reports the flag: no
	players, one combined DataModel, nothing to corroborate with. That has not
	been seen, and inventing a signal for it would mean guessing.
]]
local function detectRunning(): boolean
	if RunService:IsRunning() then
		return true
	end

	if Players.LocalPlayer ~= nil or #Players:GetPlayers() > 0 then
		return true
	end

	return RunService:IsServer() ~= RunService:IsClient()
end

function RunState.isRunning(): boolean
	return detectRunning()
end

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
	if not detectRunning() then
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

--[[
	True when this peer is one DataModel of several.

	Play Solo puts the server and the client in a single DataModel, so a peer
	that is both is the only one there is. A peer that is one but not the other
	belongs to a session Studio split across processes — a multiplayer test, or
	Start Server with players attached — which is exactly when an agent has to
	care which side it is talking to.
]]
local function isSplitSession(running: boolean): boolean
	if not running then
		return false
	end
	return RunService:IsServer() ~= RunService:IsClient()
end

function RunState.current(): any
	local running = detectRunning()

	return {
		running = running,
		edit = not running,
		mode = detectMode(running),
		realm = detectRealm(running),
		epoch = epoch,
		ready = RunState.isReady(true),
		playerCount = #Players:GetPlayers(),
		multiplayer = isSplitSession(running),
		-- Reported from every peer so the server can tell an operation that needs
		-- frames where to send it, and refuse when nowhere can take it.
		rendering = RenderMonitor.isRendering(),
		pendingStart = pendingStart,
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
	-- Started here because every consumer of the run state reads `rendering`
	-- from it, and the monitor needs a few frames of history before it can
	-- answer. Safe in a server peer, where it simply never connects.
	RenderMonitor.start()

	lastRunning = detectRunning()
	-- The epoch is derived from the run state at load: a plugin that starts up
	-- inside a playtest must not hand out handles that look edit-time.
	epoch = lastRunning and 1 or 0
	Handles.setEpoch(epoch)

	task.spawn(function()
		while true do
			task.wait(0.25)
			local running = detectRunning()
			if running ~= lastRunning then
				lastRunning = running
				epoch += 1
				Handles.setEpoch(epoch)
				-- Held copies of deleted instances belong to the DataModel they
				-- were taken from. Carrying one across the transition would
				-- restore an edit-time instance into a running world, or the
				-- reverse.
				Changes.release()
				-- The viewport the frames were coming from belongs to the
				-- DataModel that has just been replaced. Judging the new one by
				-- the old one's clock reports a window that is drawing the
				-- playtest as not drawing at all, and that reading is what
				-- refuses input and screenshots for the rest of the session.
				RenderMonitor.rearm()
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
