--!nonstrict
--[[
	Session lifecycle and the sync loop. Spec sections 8, 26, and 29.

	Connection is explicit: the plugin asks to connect, the server issues a
	six-digit code, and the user approves it in Luu Code before any token is
	handed out. A local process that merely discovers the port cannot take
	control of Studio.

	Two threads share the session once paired:

	  * the poller holds a long request open so the server can push a command
	    down the moment an agent issues one;
	  * the pusher wakes on results and output and delivers them immediately.

	Splitting them matters. With a single loop, a result produced while a poll
	was parked would sit unsent until the poll expired, and every agent call
	would inherit that delay.
]]

local HttpService = game:GetService("HttpService")

local Commands = require(script.Parent.Commands)
local Constants = require(script.Parent.Constants)
local Net = require(script.Parent.Net)
local OutputCapture = require(script.Parent.OutputCapture)
local RunState = require(script.Parent.RunState)

local Client = {}

local pluginRef: Plugin = nil

local state = {
	status = "disconnected",
	message = "Not connected",
	pairingCode = nil :: string?,
	sessionId = nil :: string?,
	endpointId = nil :: string?,
	token = nil :: string?,
	port = Constants.DEFAULT_PORT,
	place = nil :: any,
}

local listeners: { (any) -> () } = {}
local wake = Instance.new("BindableEvent")
local pendingResults: { any } = {}

local started = false
local shouldStop = false
-- Set when the run state changes. Without it the pusher would only wake for
-- results and output, and the server would not learn a playtest had started
-- until the parked poll expired.
local statePending = false
-- Bumped whenever the session is torn down, so threads from a previous
-- connection exit instead of racing the new one.
local generation = 0

local function notify()
	local snapshot = Client.state()
	for _, listener in ipairs(listeners) do
		task.spawn(listener, snapshot)
	end
end

local function setStatus(status: string, message: string)
	state.status = status
	state.message = message
	notify()
end

function Client.onChanged(listener: (any) -> ())
	table.insert(listeners, listener)
end

function Client.state(): any
	return {
		status = state.status,
		message = state.message,
		pairingCode = state.pairingCode,
		sessionId = state.sessionId,
		port = state.port,
		place = state.place,
		run = RunState.current(),
	}
end

local function baseUrl(): string
	return string.format("%s:%d", Constants.DEFAULT_HOST, state.port)
end

--[[
	A stable id for the game, so Luu Code never files two places as one.

	The place id is the real identity when there is one. An unpublished place
	that still belongs to a universe has a game id, which is the next best
	thing. A place with neither has nothing durable to key on — Studio does not
	expose the file it was opened from — and returning the name instead would
	merge every "Baseplate" on the machine into a single history. Saying nothing
	is the honest answer; the harness files those under Unknown.
]]
local function placeIdentity(): string?
	if game.PlaceId > 0 then
		return string.format("place:%d", game.PlaceId)
	end

	if game.GameId > 0 then
		return string.format("game:%d", game.GameId)
	end

	return nil
end

local function placeInfo(): any
	local name = game.Name
	if name == nil or name == "" then
		name = "Untitled Place"
	end

	return {
		placeId = game.PlaceId,
		gameId = game.GameId,
		name = name,
		unsaved = game.PlaceId == 0,
		identity = placeIdentity(),
	}
end

local function readStudioVersion(): string
	local ok, result = pcall(function()
		return version()
	end)
	return ok and tostring(result) or "unknown"
end

--[[
	Persisted so reconnecting after a Studio restart does not ask the user to
	approve the same window again. Spec section 29.
]]
local function installId(): string
	local stored = pluginRef:GetSetting(Constants.SETTING_INSTALL_ID)
	if type(stored) == "string" and #stored > 0 then
		return stored
	end

	local generated = HttpService:GenerateGUID(false)
	pluginRef:SetSetting(Constants.SETTING_INSTALL_ID, generated)
	return generated
end

local function storedToken(): string?
	local stored = pluginRef:GetSetting(Constants.SETTING_TOKEN)
	if type(stored) == "string" and #stored > 0 then
		return stored
	end
	return nil
end

local function saveToken(token: string)
	state.token = token
	pluginRef:SetSetting(Constants.SETTING_TOKEN, token)
end

function Client.forgetToken()
	state.token = nil
	state.sessionId = nil
	state.endpointId = nil
	pluginRef:SetSetting(Constants.SETTING_TOKEN, "")
end

function Client.port(): number
	return state.port
end

function Client.setPort(port: number)
	state.port = port
	pluginRef:SetSetting(Constants.SETTING_PORT, port)
end

local function waitForApproval(): boolean
	while not shouldStop do
		local response = Net.post(baseUrl() .. Constants.ROUTES.pair, {
			sessionId = state.sessionId,
			installId = installId(),
		})

		if not response.ok then
			setStatus("disconnected", response.error or "Lost contact with Luu Code while pairing")
			return false
		end

		local body = response.body

		if body.status == "connected" then
			saveToken(body.token)
			state.endpointId = body.endpointId
			return true
		elseif body.status == "rejected" then
			state.pairingCode = nil
			setStatus("disconnected", body.error and body.error.message or "Pairing was declined")
			return false
		end

		task.wait(Constants.PAIR_POLL_SECONDS)
	end

	return false
end

local function handshake(): boolean
	state.place = placeInfo()

	local response = Net.post(baseUrl() .. Constants.ROUTES.hello, {
		protocolVersion = Constants.PROTOCOL_VERSION,
		installId = installId(),
		pluginVersion = Constants.PLUGIN_VERSION,
		studioVersion = readStudioVersion(),
		place = state.place,
		capabilities = Commands.capabilities(),
		run = RunState.current(),
		token = storedToken(),
	})

	if not response.ok then
		setStatus("disconnected", string.format("Luu Code is not reachable on port %d. Open the app, or run `luu-code serve`.", state.port))
		return false
	end

	local body = response.body

	if body == nil then
		setStatus("disconnected", "Luu Code sent something this plugin could not read")
		return false
	end

	if body.status == "connected" then
		state.sessionId = body.sessionId
		state.endpointId = body.endpointId
		state.pairingCode = nil
		saveToken(body.token)
		setStatus("connected", "Luu Code can work in this place now")
		return true
	end

	if body.status == "pairing" then
		state.sessionId = body.sessionId
		state.pairingCode = body.pairingCode
		setStatus("pairing", "Approve this code in Luu Code to connect")

		if waitForApproval() then
			state.pairingCode = nil
			setStatus("connected", "Luu Code can work in this place now")
			return true
		end

		return false
	end

	setStatus("disconnected", body.error and body.error.message or "Luu Code turned down the connection")
	return false
end

local function takePending(): { any }
	-- Swapped without yielding in between, so the pusher and poller cannot
	-- both claim the same results.
	local results = pendingResults
	pendingResults = {}
	return results
end

local function dispatchAll(commands: { any })
	for _, command in ipairs(commands) do
		task.spawn(function()
			local result = Commands.dispatch(command.op, command.params)
			result.id = command.id
			table.insert(pendingResults, result)
			wake:Fire()
		end)
	end
end

--[[
	One sync. `wait` decides whether the server may hold the request open
	waiting for a command, or should answer immediately.

	Returns false when the session is over and the caller should re-handshake.
]]
local function sync(wait: boolean): boolean
	local events = {}
	local drained = OutputCapture.drain(Constants.OUTPUT_BATCH_SIZE)

	if #drained > 0 then
		table.insert(events, { type = "output", entries = drained })
	end

	local response = Net.post(baseUrl() .. Constants.ROUTES.sync, {
		sessionId = state.sessionId,
		endpointId = state.endpointId,
		token = state.token,
		wait = wait,
		results = takePending(),
		events = events,
		run = RunState.current(),
		capabilities = Commands.capabilities(),
	})

	if not response.ok then
		if response.status == 401 or response.status == 404 then
			-- The server no longer knows this session. Pair again rather than
			-- retrying forever against something that will never answer.
			Client.forgetToken()
			setStatus("disconnected", "Luu Code lost this session. Reconnect to pair again.")
		else
			setStatus("disconnected", response.error or "Lost contact with Luu Code")
		end
		return false
	end

	local body = response.body
	if body == nil then
		return true
	end

	if body.reconnect then
		return false
	end

	if body.commands ~= nil and #body.commands > 0 then
		dispatchAll(body.commands)
	end

	return true
end

local function startPusher(myGeneration: number)
	task.spawn(function()
		while not shouldStop and generation == myGeneration do
			wake.Event:Wait()

			if shouldStop or generation ~= myGeneration then
				break
			end

			-- Coalesce a burst of results into one request.
			task.wait(0.03)

			if #pendingResults > 0 or OutputCapture.pending() > 0 or statePending then
				statePending = false
				if not sync(false) then
					break
				end
			end
		end
	end)
end

local function runSession(myGeneration: number)
	startPusher(myGeneration)

	while not shouldStop and generation == myGeneration do
		if not sync(true) then
			return
		end
	end
end

local function loop()
	local backoff = Constants.RETRY_MIN_SECONDS

	while not shouldStop do
		generation += 1
		local myGeneration = generation

		if handshake() then
			backoff = Constants.RETRY_MIN_SECONDS
			runSession(myGeneration)
			-- Wake the pusher so it observes the generation change and exits.
			wake:Fire()
		end

		if shouldStop then
			break
		end

		task.wait(backoff)
		backoff = math.min(backoff * 2, Constants.RETRY_MAX_SECONDS)
	end

	started = false
end

function Client.start(hostPlugin: Plugin)
	if started then
		return
	end

	pluginRef = hostPlugin
	started = true
	shouldStop = false

	local storedPort = pluginRef:GetSetting(Constants.SETTING_PORT)
	if type(storedPort) == "number" then
		state.port = storedPort
	end

	OutputCapture.start(function()
		return RunState.current().realm
	end, function()
		wake:Fire()
	end)

	RunState.onChanged(function()
		-- A playtest transition changes what the agent can observe, so push it
		-- up instead of waiting out the current poll.
		statePending = true
		wake:Fire()
		notify()
	end)

	task.spawn(loop)

	task.spawn(function()
		while not shouldStop do
			task.wait(30)
			Commands.prune()
		end
	end)
end

function Client.reconnect()
	-- Ends the current session; the loop handshakes again on the next pass.
	generation += 1
	wake:Fire()
end

function Client.stop()
	shouldStop = true
	generation += 1
	wake:Fire()
	OutputCapture.stop()
	setStatus("disconnected", "Disconnected")
end

function Client.isRunning(): boolean
	return started
end

return Client
