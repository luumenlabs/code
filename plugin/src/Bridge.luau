--!nonstrict
--[[
	The playtest bridge.

	Studio does not load plugins into the DataModel a playtest creates, so a
	playtest has no peer in it and everything runtime — output, exec, input,
	screenshots, `run.stop` — has nowhere to go. The only thing that runs in
	there is what was in the place when Play was pressed.

	So a copy of the plugin's own modules goes into the place, under a Script
	that starts the ordinary client loop, and comes straight back out once the
	playtest has taken its copy. What lands in the playtest is the same command
	surface the plugin has; the capability probes report the smaller set a game
	script is allowed.

	Nothing is installed unless the caller asks, and `run.start` only asks when
	the playtest permission is on.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")
local StarterPlayer = game:GetService("StarterPlayer")

local Bridge = {}

local BRIDGE_NAME = "__LuuCodeBridge"
local CLIENT_INVOKE_NAME = "__LuuCodeBridgeInvoke"
local CLIENT_READY_NAME = "__LuuCodeBridgeReady"

--[[
	Runs in the playtest, not here. Everything it needs to find the local server
	is baked in: there is no `plugin` in a game script to read settings from, and
	it has to reach the session the edit peer already holds rather than opening
	one of its own.
]]
local BOOTSTRAP = [[
-- Installed by Luu Code for the length of one playtest, because Studio does not
-- load plugins into the DataModel a playtest creates. It is removed from the
-- place as soon as the playtest has its copy. Finding this in a saved file
-- means Studio was interrupted mid-playtest; deleting it is safe.

local Modules = script:FindFirstChild("Modules")
if Modules == nil then
	return
end

local Client = require(Modules:WaitForChild("Client"))
Client.startBridge(%d, %q)
]]

--[[
	Runs on the player's machine, copied there from StarterPlayerScripts with its
	own modules. It never calls out; it waits to be called.
]]
local CLIENT_BOOTSTRAP = [[
-- Installed by Luu Code for the length of one playtest. See the copy in
-- ServerScriptService. Deleting it is safe.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Modules = script:FindFirstChild("Modules")
local invoke = ReplicatedStorage:WaitForChild("]] .. CLIENT_INVOKE_NAME .. [[", 30)
local ready = ReplicatedStorage:WaitForChild("]] .. CLIENT_READY_NAME .. [[", 30)
if Modules == nil or invoke == nil or ready == nil then
	return
end

local Commands = require(Modules:WaitForChild("Commands"))
local RunState = require(Modules:WaitForChild("RunState"))

RunState.start()

invoke.OnClientInvoke = function(op, params)
	return Commands.dispatch(op, params)
end

-- Announced rather than asked for: this script has to replicate, run, and
-- require before it can answer anything, and the server has no way to know when
-- that has happened.
ready:FireServer(Commands.capabilities())
]]

-- Set by Client once it knows both. Held here rather than read back from Client
-- because Client requires Commands, which requires the ops, which require this.
local port: number? = nil
local installId: string? = nil

function Bridge.describe(hostPort: number, hostInstallId: string)
	port = hostPort
	installId = hostInstallId
end

--[[
	Where a bridge can live.

	Server only. Roblox refuses `HttpService:RequestAsync` from a client
	DataModel whatever the identity, so a LocalScript copy could never reach the
	local server — it would sit in the player's scripts retrying forever. What a
	client peer would add (the viewport, virtual input, the player's own GUI)
	needs the server peer to broker for it, which is not built.

	The client copy is not there to reach Luu Code — Roblox refuses
	`HttpService:RequestAsync` from a client DataModel whatever the identity. It
	is there to be *reached*, over a RemoteFunction the server copy owns, so that
	the viewport, the player's GUI and virtual input have somewhere to run.

	Both go in at install time rather than being built during the playtest,
	because writing `Script.Source` needs plugin identity and a bridge already
	inside a playtest has none.
]]
local function containers(): { Instance }
	local found: { Instance } = { ServerScriptService }

	local starterPlayerScripts = StarterPlayer:FindFirstChild("StarterPlayerScripts")
	if starterPlayerScripts ~= nil then
		table.insert(found, starterPlayerScripts)
	end

	return found
end

--[[
	Removes every bridge in the place. Called before installing and after the
	playtest has its copy, and once when the plugin loads: Studio closing during
	a playtest is the one way one of these outlives the session that needed it.
]]
function Bridge.sweep(): number
	local removed = 0

	for _, container in ipairs(containers()) do
		local existing = container:FindFirstChild(BRIDGE_NAME)
		while existing ~= nil do
			existing:Destroy()
			removed += 1
			existing = container:FindFirstChild(BRIDGE_NAME)
		end
	end

	return removed
end

Bridge.uninstall = Bridge.sweep

local function build(className: string, container: Instance, source: string, root: Instance)
	local host = Instance.new(className)
	host.Name = BRIDGE_NAME;
	(host :: any).Source = source

	local modules = Instance.new("Folder")
	modules.Name = "Modules"

	-- The plugin's own modules, which reference each other as siblings and go on
	-- doing so under the folder.
	for _, child in ipairs(root:GetChildren()) do
		child:Clone().Parent = modules
	end

	modules.Parent = host
	host.Parent = container
end

--[[
	Puts the bridge in the place, ready for the next playtest to copy it.

	Returns why not rather than raising: a playtest that starts without a bridge
	is worth having, and `run.start` reports the reason alongside it.
]]
function Bridge.install(): any
	if port == nil or installId == nil then
		return { installed = false, reason = "Luu Code has not finished connecting, so the bridge has no address to call back on." }
	end

	-- A game script is not a plugin: it needs the place's own HTTP setting, and
	-- without it the bridge would install, run, and silently reach nothing.
	local httpOk, httpEnabled = pcall(function()
		return HttpService.HttpEnabled
	end)

	if httpOk and httpEnabled == false then
		return {
			installed = false,
			reason = "HTTP requests are off for this place, so nothing inside a playtest can reach Luu Code. Turn on Game Settings → Security → Allow HTTP Requests.",
		}
	end

	Bridge.sweep()

	local root = script.Parent
	local starterPlayerScripts = StarterPlayer:FindFirstChild("StarterPlayerScripts")

	local ok, err = pcall(function()
		build("Script", ServerScriptService, string.format(BOOTSTRAP, port, installId), root)

		-- Without it the playtest is observable but blind: no viewport, no
		-- player GUI, no input. Its absence is not worth refusing the playtest
		-- over, so a place with no StarterPlayerScripts simply goes without.
		if starterPlayerScripts ~= nil then
			build("LocalScript", starterPlayerScripts, CLIENT_BOOTSTRAP, root)
		end
	end)

	if not ok then
		Bridge.sweep()
		return { installed = false, reason = string.format("The bridge could not be built: %s", tostring(err)) }
	end

	return { installed = true }
end

-- ---------------------------------------------------------------------------
-- Reaching the client, from the playtest's server
-- ---------------------------------------------------------------------------

local invoker: RemoteFunction? = nil

--[[
	The player whose machine serves client-side work.

	The first to join, and it keeps meaning that: an agent asking for a
	screenshot twice must not get two different screens.
]]
local function brokerPlayer(): Player?
	local players = Players:GetPlayers()
	table.sort(players, function(left, right)
		return left.UserId < right.UserId
	end)
	return players[1]
end

--[[
	Runs an op on the client and returns the same envelope a local dispatch
	would. Failures are envelopes too: the caller is the command loop, which has
	a result to send either way.
]]
local function invokeClient(op: string, params: any): any
	local remote = invoker
	local player = brokerPlayer()

	if remote == nil or player == nil then
		return {
			ok = false,
			error = {
				code = "RUNTIME_CONTEXT_UNAVAILABLE",
				message = "No player has joined this playtest yet, so nothing can answer for the client.",
				hint = "Wait for the playtest to finish loading.",
			},
		}
	end

	local ok, result = pcall(function()
		return remote:InvokeClient(player, op, params)
	end)

	if not ok then
		return {
			ok = false,
			error = {
				code = "RUNTIME_CONTEXT_UNAVAILABLE",
				message = string.format("The playtest client did not answer %s: %s", op, tostring(result)),
				hint = "The player may be rejoining. Try again.",
			},
		}
	end

	if type(result) ~= "table" then
		return {
			ok = false,
			error = { code = "INTERNAL", message = string.format("The playtest client returned %s for %s", typeof(result), op) },
		}
	end

	return result
end

--[[
	Opens the route to the player's own DataModel.

	Roblox refuses HttpService from a client whatever the identity, so a client
	peer cannot connect to Luu Code at all — but it can be reached from here.
	What that buys is everything a playtest's server has no view of: the
	viewport, the player's GUI, and virtual input.

	The remotes are made at runtime inside the playtest and die with it; the
	script that answers on them came in with the place. `onReady` fires once the
	client has said what it can do, because that changes what this peer reports.
]]
function Bridge.serveClients(onReady: (broker: (string, any) -> any, capabilities: { string }) -> ())
	if not RunService:IsRunning() or not RunService:IsServer() then
		return
	end

	local remote = Instance.new("RemoteFunction")
	remote.Name = CLIENT_INVOKE_NAME
	remote.Parent = ReplicatedStorage
	invoker = remote

	local ready = Instance.new("RemoteEvent")
	ready.Name = CLIENT_READY_NAME
	ready.Parent = ReplicatedStorage

	local announced = false

	-- The client's own capability list, not a guess from here: it refuses a
	-- different set of things than a playtest's server does, and offering an
	-- agent the union of assumptions would offer it operations that cannot work.
	ready.OnServerEvent:Connect(function(_player, capabilities)
		if announced or type(capabilities) ~= "table" then
			return
		end

		announced = true
		onReady(invokeClient, capabilities)
	end)
end

return Bridge
