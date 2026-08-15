--!nonstrict
--[[
	Edit and playtest state. Studio does not hand the plugin one stable
	DataModel: a playtest replaces it, and which realm the plugin lands in
	differs between Run and Play. Everything the agent sees is stamped with the
	realm, so a missing LocalPlayer reads as "wrong realm", not as a bug.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local Changes = require(script.Parent.Changes)
local Handles = require(script.Parent.Handles)
local RenderMonitor = require(script.Parent.RenderMonitor)

local RunState = {}

local epoch = 0
local lastRunning: boolean? = nil
local lastTestActive: boolean? = nil
local listeners: { (any) -> () } = {}

-- Set by RunOps while its start request is outstanding. Held here because the
-- whole state goes up on every sync, and RunOps already depends on this module.
local pendingStart = false

function RunState.setPendingStart(value: boolean)
	pendingStart = value
end

--[[
	Is the experience up in this DataModel?

	`RunService:IsRunning()` is believed when it says yes. It has been caught
	saying no with a playtest plainly running, which stalls every `run.start`
	until it times out, so the flag is corroborated rather than trusted alone.

	Edit says so itself, and is asked first. A published place has players in
	`Players` while it is being edited, so a player is only corroboration
	somewhere that has not already said it is edit — without that test every
	edit session on a published place reported a playtest in the client realm.

	Being a server but not a client is not corroboration either: edit reports
	exactly that.
]]
local function detectRunning(): boolean
	if RunService:IsRunning() then
		return true
	end

	if RunService:IsEdit() then
		return false
	end

	return Players.LocalPlayer ~= nil or #Players:GetPlayers() > 0
end

function RunState.isRunning(): boolean
	return detectRunning()
end

-- Probed once. Services do not come and go, and this is asked four times a
-- second.
local studioTest: any = nil
local studioTestProbed = false

local function studioTestService(): any
	if not studioTestProbed then
		studioTestProbed = true
		local ok, service = pcall(function()
			return game:GetService("StudioTestService")
		end)
		studioTest = ok and service or nil
	end

	return studioTest
end

--[[
	Is a playtest up in this Studio window?

	Studio does not load the plugin into the DataModel a playtest creates, so on
	a Play the edit peer is the only peer there is and its own `running` stays
	false for the whole session. `EditModeActive` is the edit DataModel's answer
	to the same question, and the only one it has.

	Nil where the build has no StudioTestService. That is "cannot tell", and a
	caller that reads it as "no playtest" reports edit through a running game.
]]
local function detectTestActive(running: boolean): boolean?
	if running then
		return true
	end

	local service = studioTestService()
	if service == nil then
		return nil
	end

	local ok, active = pcall(function()
		return service.EditModeActive
	end)

	if not ok or type(active) ~= "boolean" then
		return nil
	end

	return not active
end

function RunState.isTestActive(): boolean?
	return detectTestActive(detectRunning())
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
		-- No player of this peer's own: Run mode, or the server DataModel of a
		-- Play. The place is up as soon as it is running, and where players have
		-- joined, once one of them has a character to act on. Waiting for a
		-- LocalPlayer that a server peer never gets would never end.
		local players = Players:GetPlayers()
		if #players == 0 or not requireCharacter then
			return true
		end

		for _, player in ipairs(players) do
			local character = player.Character
			if character ~= nil and character:FindFirstChildOfClass("Humanoid") ~= nil then
				return true
			end
		end

		return false
	end

	if requireCharacter == false then
		return true
	end

	local character = localPlayer.Character
	return character ~= nil and character:FindFirstChildOfClass("Humanoid") ~= nil
end

--[[
	True when this peer is one DataModel of several. Play Solo puts server and
	client in a single DataModel, so a peer that is both is the only one there
	is. One but not the other means Studio split the session across processes.
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
		-- The edit peer's only sight of a playtest it is not in.
		testActive = detectTestActive(running),
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
	Polls for edit/run transitions. RunService exposes no reliable "mode changed"
	signal to plugins across all Studio versions, and a plugin is often torn
	down and recreated across the transition anyway.
]]
function RunState.start()
	-- Started here because every consumer of the run state reads `rendering`
	-- from it, and the monitor needs a few frames of history before it can
	-- answer. Safe in a server peer, where it simply never connects.
	RenderMonitor.start()

	local running = detectRunning()
	lastRunning = running
	lastTestActive = detectTestActive(running)
	-- The epoch is derived from the run state at load: a plugin that starts up
	-- inside a playtest must not hand out handles that look edit-time.
	epoch = running and 1 or 0
	Handles.setEpoch(epoch)

	task.spawn(function()
		while true do
			task.wait(0.25)
			local running = detectRunning()
			local testActive = detectTestActive(running)

			-- A playtest starting or ending elsewhere in this window. Nothing
			-- here was replaced, so handles, marks and the frame clock all stay
			-- good; only what this peer reports has changed.
			if running == lastRunning and testActive ~= lastTestActive then
				lastTestActive = testActive
				emit()
			end

			if running ~= lastRunning then
				lastRunning = running
				lastTestActive = testActive
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
		local function watch(player: Player)
			player.CharacterAdded:Connect(function()
				task.wait(0.1)
				emit()
			end)
		end

		local localPlayer = Players.LocalPlayer
		if localPlayer ~= nil then
			watch(localPlayer)
			return
		end

		-- A server peer has no player of its own, and readiness there is about
		-- whoever joins.
		for _, player in ipairs(Players:GetPlayers()) do
			watch(player)
		end

		Players.PlayerAdded:Connect(function(player)
			watch(player)
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
