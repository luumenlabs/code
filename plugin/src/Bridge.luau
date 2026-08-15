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
local ServerScriptService = game:GetService("ServerScriptService")
local StarterPlayer = game:GetService("StarterPlayer")

local Bridge = {}

local BRIDGE_NAME = "__LuuCodeBridge"

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

	Sweeping still covers StarterPlayerScripts: an older build put one there.
]]
local function containers(): { Instance }
	local found: { Instance } = { ServerScriptService }

	local starterPlayerScripts = StarterPlayer:FindFirstChild("StarterPlayerScripts")
	if starterPlayerScripts ~= nil then
		table.insert(found, starterPlayerScripts)
	end

	return found
end

local function installTargets(): { Instance }
	return { ServerScriptService }
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
	local source = string.format(BOOTSTRAP, port, installId)

	local ok, err = pcall(function()
		for _, container in ipairs(installTargets()) do
			build("Script", container, source, root)
		end
	end)

	if not ok then
		Bridge.sweep()
		return { installed = false, reason = string.format("The bridge could not be built: %s", tostring(err)) }
	end

	return { installed = true }
end

return Bridge
