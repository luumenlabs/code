--!nonstrict
--[[
	Playtest control, through StudioTestService.

	Two facts about those APIs shape this module and the server's RunControl:

	  * The Execute* calls yield for the whole life of the session, so they are
	    spawned and the run state reports the outcome.
	  * Execute* only works in the edit DataModel and EndTest only in the running
	    one. Those are different peers, so the server routes each request by realm.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local Bridge = require(script.Parent.Parent.Bridge)
local Errors = require(script.Parent.Parent.Errors)
local RunState = require(script.Parent.Parent.RunState)
local Value = require(script.Parent.Parent.Value)

local RunOps = {}

local function testService(): any
	local ok, service = pcall(function()
		return game:GetService("StudioTestService")
	end)

	if not ok or service == nil then
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			"This Studio build does not expose StudioTestService, so playtests cannot be controlled from Luu Code",
			{ reason = ok and "nil service" or tostring(service) },
			"Press Play in Studio yourself; everything else Luu Code does works the same during a playtest."
		)
	end

	return service
end

--[[
	The edit peer's record of having asked. Its own DataModel never starts
	running, so `running` alone cannot answer "did the start take?" — the server
	watches the run state arriving from the other peer for that.
]]
local pending = {
	active = false,
	mode = nil :: string?,
	error = nil :: string?,
	startedAt = nil :: number?,
}

-- How long a start counts as in flight. `active` clears only when the playtest
-- ends, so without this a failed start refuses every retry.
local START_GRACE_SECONDS = 15

-- How many ExecutePlayModeAsync calls have yet to return.
local outstandingStarts = 0

-- How long to leave the bridge in the place waiting for Studio to copy it into
-- the playtest, before taking it back regardless.
local BRIDGE_RETRIEVE_TIMEOUT_SECONDS = 30

local function startInFlight(): boolean
	return pending.active and (os.clock() - (pending.startedAt or 0)) < START_GRACE_SECONDS
end

--[[
	Multiplayer bookkeeping, held by the edit peer. ExecuteMultiplayerTestAsync
	yields until the test is over and returns what EndTest was given, so only the
	calling thread ever sees it — hence recording the phase as it moves.
]]
local multiplayer = {
	phase = "idle",
	testId = nil :: string?,
	players = nil :: number?,
	startedAt = nil :: number?,
	finishedAt = nil :: number?,
	value = nil :: any,
	error = nil :: string?,
}

local function multiplayerState(): any
	local connected = {}

	-- Only the running server peer can see who actually joined; the edit peer
	-- knows how many were asked for and nothing more.
	if RunState.isRunning() and RunService:IsServer() then
		for _, player in ipairs(Players:GetPlayers()) do
			table.insert(connected, { name = player.Name, userId = player.UserId, displayName = player.DisplayName })
		end
		table.sort(connected, function(left, right)
			return left.name < right.name
		end)
	end

	return {
		phase = multiplayer.phase,
		testId = multiplayer.testId,
		players = multiplayer.players,
		startedAt = multiplayer.startedAt,
		finishedAt = multiplayer.finishedAt,
		value = Value.encode(multiplayer.value),
		error = multiplayer.error,
		connected = connected,
		run = RunState.current(),
	}
end

function RunOps.state(): any
	local state = RunState.current()
	-- Always a phase, "idle" included. An absent field would be indistinguishable
	-- from a plugin too old to have one, and those mean different things.
	state.multiplayerPhase = multiplayer.phase
	state.pendingStart = pending.active
	return state
end

--[[
	Starts a playtest from the edit DataModel, returning as soon as the request is
	issued — the call that does the work does not return until the test is over.
]]
function RunOps.start(params: any): any
	local current = RunState.current()

	-- `running` alone misses a playtest this DataModel is not in, which on a
	-- Play is every playtest there is.
	if current.running or current.testActive == true then
		Errors.throw(
			"PLAYTEST_ALREADY_RUNNING",
			"A playtest is already running",
			{ state = current },
			"Use run.restart to start a fresh session, or run.stop first."
		)
	end

	if startInFlight() then
		Errors.throw(
			"PLAYTEST_ALREADY_RUNNING",
			"A playtest is already starting",
			{ mode = pending.mode },
			"Wait for it to come up, then check run.state."
		)
	end

	local mode = params.mode or "play"
	local service = testService()

	-- Only ever when asked, and the server asks only while the playtest
	-- permission is on. A playtest without a bridge is still worth starting, so
	-- a refusal here is reported rather than raised.
	local bridge = if params.bridge == true then Bridge.install() else { installed = false }

	if bridge.installed == false and bridge.reason ~= nil then
		warn(string.format("[Luu Code] The playtest bridge was not installed: %s", bridge.reason))
	end

	pending.active = true
	pending.mode = mode
	pending.error = nil
	pending.startedAt = os.clock()
	outstandingStarts += 1
	RunState.setPendingStart(true)

	task.spawn(function()
		local ok, err = pcall(function()
			if mode == "run" then
				return service:ExecuteRunModeAsync({})
			end
			return service:ExecutePlayModeAsync({})
		end)

		-- This lands when the playtest *ends*, not when it starts, unless Studio
		-- refused it outright. Either way the record is cleared so the next start
		-- is not blocked by a session that is over.
		if not ok then
			pending.error = tostring(err)
			warn(string.format("[Luu Code] Studio refused to start %s mode: %s", mode, tostring(err)))
		end

		-- Counted, not flagged: a retry refused inside the grace window must not
		-- clear the record the live playtest still owns.
		outstandingStarts -= 1
		if outstandingStarts > 0 then
			return
		end

		pending.active = false
		pending.mode = nil
		pending.startedAt = nil
		RunState.setPendingStart(false)
	end)

	if bridge.installed then
		task.spawn(function()
			-- The playtest is copied out of this DataModel some time after the
			-- call is issued, and taking the bridge back before then leaves the
			-- playtest without one. `EditModeActive` turning over is Studio
			-- saying the copy exists; the extra second is slack on that.
			local deadline = os.clock() + BRIDGE_RETRIEVE_TIMEOUT_SECONDS
			while os.clock() < deadline and RunState.isTestActive() ~= true do
				task.wait(0.1)
			end

			task.wait(1)
			-- Removed whether or not the playtest ever came up: a bridge left in
			-- the place is worse than a playtest without one.
			Bridge.uninstall()
		end)
	end

	-- Give Studio a moment to reject the request, so an outright refusal is
	-- reported here rather than as a timeout thirty seconds later.
	task.wait(0.15)

	if pending.error ~= nil then
		local reason = pending.error
		pending.error = nil
		Bridge.uninstall()
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			string.format("Studio refused to start %s mode: %s", mode, reason),
			{ mode = mode },
			'Try mode "run" for a server-only playtest, or press Play in Studio yourself.'
		)
	end

	-- Almost certainly still "not running": the transition has not landed yet,
	-- and the server is watching for it on the peer that will report it.
	local started = RunState.current()
	started.bridge = bridge
	return started
end

--[[
	Ends the running session, from inside it. EndTest exists only in the running
	DataModel, which is why the server routes this to the running peer.
]]
function RunOps.stop(): any
	if not RunState.isRunning() then
		local state = RunState.current()

		-- Studio refuses EndTest anywhere but the running server DataModel, and
		-- does not load the plugin into one, so an edit peer watching a playtest
		-- has nothing to end it with. Saying so beats a refusal that reads as a
		-- broken build.
		if state.testActive == true or pending.active then
			Errors.throw(
				"RUNTIME_CONTEXT_UNAVAILABLE",
				"A playtest is running and Luu Code has no connection inside it, so there is nothing here that can end it",
				{ state = state },
				"Press Stop in Studio."
			)
		end

		return state
	end

	local ok, err = pcall(function()
		testService():EndTest("stopped_by_luu_code")
	end)

	if not ok then
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			string.format("StudioTestService:EndTest was refused: %s", tostring(err)),
			{ realm = RunState.current().realm },
			"Press Stop in Studio, then continue."
		)
	end

	-- The DataModel this ran in is on its way out, so the state below is the
	-- last thing this peer will say. The server watches for edit mode returning.
	return RunState.current()
end

function RunOps.waitReady(params: any): any
	if not RunState.isRunning() then
		local state = RunState.current()

		if state.testActive == true then
			Errors.throw(
				"RUNTIME_CONTEXT_UNAVAILABLE",
				"A playtest is running and Luu Code has no connection inside it, so there is nothing here that can tell when it is ready",
				{ state = state },
				"Watch it in Studio."
			)
		end

		Errors.throw("PLAYTEST_NOT_RUNNING", "Nothing is running to wait for", { state = state }, "Start a playtest first.")
	end

	local timeoutSeconds = (params.timeoutMs or 30000) / 1000
	local requireCharacter = params.requireCharacter ~= false

	return RunState.waitReady(timeoutSeconds, requireCharacter)
end

-- ---------------------------------------------------------------------------
-- Multiplayer
-- ---------------------------------------------------------------------------

local function startMultiplayer(params: any): any
	if RunState.isRunning() then
		Errors.throw(
			"PLAYTEST_ALREADY_RUNNING",
			"A multiplayer test has to be started from the edit DataModel",
			{ realm = RunState.current().realm },
			"Stop the running session first."
		)
	end

	if multiplayer.phase == "starting" or multiplayer.phase == "running" then
		Errors.throw(
			"PLAYTEST_ALREADY_RUNNING",
			"A multiplayer test is already in progress",
			{ state = multiplayerState() },
			'End it first with action "end".'
		)
	end

	local players = params.players
	local service = testService()
	local testArgs = params.testArgs ~= nil and Value.decode(params.testArgs) or {}

	multiplayer = {
		phase = "starting",
		testId = HttpService:GenerateGUID(false),
		players = players,
		startedAt = os.time(),
		finishedAt = nil,
		value = nil,
		error = nil,
	}

	task.spawn(function()
		multiplayer.phase = "running"

		local ok, result = pcall(function()
			return service:ExecuteMultiplayerTestAsync(players, testArgs)
		end)

		multiplayer.finishedAt = os.time()

		if ok then
			multiplayer.phase = "completed"
			multiplayer.value = result
			multiplayer.error = nil
		else
			multiplayer.phase = "failed"
			multiplayer.value = nil
			multiplayer.error = tostring(result)
		end
	end)

	task.wait(0.15)
	return multiplayerState()
end

local function addPlayers(params: any): any
	if not RunState.isRunning() or not RunService:IsServer() then
		Errors.throw(
			"RUNTIME_CONTEXT_UNAVAILABLE",
			"Players can only be added from the running server DataModel",
			{ realm = RunState.current().realm },
			"Start a multiplayer test first."
		)
	end

	local before = #Players:GetPlayers()
	local wanted = params.players

	local ok, err = pcall(function()
		testService():AddPlayers(wanted)
	end)

	if not ok then
		Errors.throw("UNSUPPORTED_CAPABILITY", string.format("StudioTestService:AddPlayers was refused: %s", tostring(err)))
	end

	-- AddPlayers returns immediately; the clients take a moment to connect, and
	-- reporting the count before they have is a number the agent cannot use.
	local deadline = os.clock() + math.max((params.timeoutMs or 60000) / 1000 - 5, 1)
	while #Players:GetPlayers() < before + wanted and os.clock() < deadline do
		task.wait(0.1)
	end

	local state = multiplayerState()

	if #state.connected < before + wanted then
		Errors.throw(
			"STUDIO_TIMEOUT",
			string.format("Asked for %d more player(s); %d of them joined before the deadline", wanted, #state.connected - before),
			{ state = state },
			'The clients may still be loading. Check again with action "status".'
		)
	end

	return state
end

local function leaveClient(): any
	if not RunState.isRunning() or RunService:IsServer() then
		Errors.throw("RUNTIME_CONTEXT_UNAVAILABLE", "A client can only leave from its own DataModel", { realm = RunState.current().realm })
	end

	local service = testService()
	local canLeave = false
	local probeOk, probeErr = pcall(function()
		canLeave = service:CanLeaveTest()
	end)

	if not probeOk then
		Errors.throw("UNSUPPORTED_CAPABILITY", string.format("StudioTestService:CanLeaveTest was refused: %s", tostring(probeErr)))
	end

	if not canLeave then
		Errors.throw(
			"NOT_ALLOWED_BY_ROBLOX",
			"Studio will not let this client leave the test session",
			{ state = multiplayerState() },
			"A session needs more than one client before any of them can leave."
		)
	end

	-- Deferred because leaving tears down the DataModel this handler is running
	-- in, and the result has to reach the server first.
	task.defer(function()
		pcall(function()
			service:LeaveTest()
		end)
	end)

	return multiplayerState()
end

local function endMultiplayer(params: any): any
	if not RunState.isRunning() or not RunService:IsServer() then
		Errors.throw(
			"RUNTIME_CONTEXT_UNAVAILABLE",
			"A multiplayer test can only be ended from the running server DataModel",
			{ realm = RunState.current().realm }
		)
	end

	local value = params.value ~= nil and Value.decode(params.value) or "ended_by_luu_code"

	local ok, err = pcall(function()
		testService():EndTest(value)
	end)

	if not ok then
		Errors.throw("UNSUPPORTED_CAPABILITY", string.format("StudioTestService:EndTest was refused: %s", tostring(err)))
	end

	return multiplayerState()
end

function RunOps.multiplayer(params: any): any
	local action = params.action

	if action == "start" then
		return startMultiplayer(params)
	elseif action == "status" then
		return multiplayerState()
	elseif action == "add_players" then
		return addPlayers(params)
	elseif action == "leave_client" then
		return leaveClient()
	elseif action == "end" then
		return endMultiplayer(params)
	end

	Errors.throw("INVALID_PARAMS", string.format("Unknown multiplayer action %q", tostring(action)))
	return nil
end

--[[
	Play and Run are one capability: both are StudioTestService methods, so a
	build with one has the other.
]]
function RunOps.capabilities(): (boolean, boolean)
	local ok, service = pcall(function()
		return game:GetService("StudioTestService")
	end)

	if not ok or service == nil then
		return false, false
	end

	local canPlay = (service :: any).ExecutePlayModeAsync ~= nil
	local canMultiplayer = (service :: any).ExecuteMultiplayerTestAsync ~= nil

	return canPlay, canMultiplayer
end

return RunOps
