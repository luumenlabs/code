--!nonstrict
--[[
	Log breakpoints, through ScriptDebuggerService.

	A line of a script reports itself every time it runs, and the script is not
	edited to make that happen. The alternative an agent reaches for otherwise is
	adding a print, which is a real change to the user's place that has to be
	journalled, reviewed, and then remembered about and taken out again.

	Nothing here pauses. A stopping breakpoint needs a debugger on the other end
	to resume it, and with no such handler installed the playtest stops with both
	peers unreachable — so `ContinueExecution` is always true and the stopping
	kind is not offered at all.
]]

local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local Path = require(script.Parent.Parent.Path)
local RunState = require(script.Parent.Parent.RunState)
local Value = require(script.Parent.Parent.Value)

local DebugOps = {}

--[[
	Only what this plugin set, so `clear` cannot take away breakpoints the user
	placed by clicking in the margin. Held in memory and per DataModel, like
	every other thing here that only means something next to a live place.
]]
local registry: { [string]: any } = {}

local function debugger(): any
	local ok, service = pcall(function()
		return game:GetService("ScriptDebuggerService")
	end)

	if not ok or service == nil then
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			"This Studio build does not expose ScriptDebuggerService",
			{ reason = ok and "nil service" or tostring(service) },
			"Breakpoints need the Luau debugger API, which is a Studio beta feature. Turn it on under File → Beta Features, or add a print and read it back with studio_output."
		)
	end

	return service
end

local function requireScript(target: string): Instance
	local instance = Handles.resolve(target)

	if not instance:IsA("LuaSourceContainer") then
		Errors.throw(
			"INVALID_PARAMS",
			string.format("%s is a %s, not a script", Path.of(instance), instance.ClassName),
			{ className = instance.ClassName }
		)
	end

	return instance
end

local function keyFor(instance: Instance, line: number): string
	return string.format("%s:%d", Path.of(instance), line)
end

local function describe(entry: any): any
	return {
		instance = Handles.describe(entry.instance),
		line = entry.line,
		requestedLine = entry.requestedLine,
		log = entry.log,
		condition = entry.condition,
		verified = entry.verified,
		realm = RunState.current().realm,
	}
end

--[[
	Everything this plugin still holds, dropping anything whose script has been
	destroyed since. A breakpoint on an instance that no longer exists is not
	something the caller can act on.
]]
local function held(): { any }
	local entries = {}

	for key, entry in pairs(registry) do
		local ok, alive = pcall(function()
			return entry.instance.Parent ~= nil or entry.instance == game
		end)

		if ok and alive then
			table.insert(entries, describe(entry))
		else
			registry[key] = nil
		end
	end

	table.sort(entries, function(left, right)
		if left.instance.path == right.instance.path then
			return left.line < right.line
		end
		return left.instance.path < right.instance.path
	end)

	return entries
end

local function set(params: any): number
	local service = debugger()
	local instance = requireScript(params.target)

	local request = {
		Line = params.line,
		Enabled = true,
		ContinueExecution = true,
		-- Studio's own prefix is the script and line, so the message only has to
		-- carry what the caller wanted to see. It arrives in the output buffer
		-- like any other log line.
		LogMessage = params.log,
	}

	if params.condition ~= nil then
		request.Condition = params.condition
	end

	local ok, result = pcall(function()
		return service:AddBreakpoint(instance, request)
	end)

	if not ok then
		error(Errors.fromRobloxError(tostring(result), { path = Path.of(instance), line = params.line }), 0)
	end

	-- Studio moves a breakpoint to the next line that carries code, so the line
	-- it ends up on is not always the one asked for. Both are reported: an agent
	-- that set one on a comment needs to know where it actually landed.
	local line = tonumber(result and result.Line) or params.line
	local verified = result == nil or result.Verified ~= false

	registry[keyFor(instance, line)] = {
		instance = instance,
		line = line,
		requestedLine = params.line,
		log = params.log,
		condition = params.condition or Value.NIL,
		verified = verified,
	}

	return 0
end

local function remove(params: any): number
	local service = debugger()
	local instance = requireScript(params.target)

	-- The caller knows the line they asked for; the breakpoint may be on the one
	-- Studio moved it to. Try what we recorded first, then what they said.
	local recorded = registry[keyFor(instance, params.line)]
	local lines = { params.line }

	if recorded == nil then
		for key, entry in pairs(registry) do
			if entry.instance == instance and entry.requestedLine == params.line then
				table.insert(lines, entry.line)
				registry[key] = nil
			end
		end
	else
		registry[keyFor(instance, params.line)] = nil
	end

	local removed = 0

	for _, line in ipairs(lines) do
		local ok = pcall(function()
			service:RemoveBreakpoint(instance, line)
		end)
		if ok then
			removed += 1
		end
	end

	if removed == 0 then
		Errors.throw(
			"TARGET_NOT_FOUND",
			string.format("There is no breakpoint on line %d of %s", params.line, Path.of(instance)),
			{ path = Path.of(instance), line = params.line },
			'Call this with action "list" to see what is set.'
		)
	end

	return removed
end

--[[
	Removes only what this plugin set. ClearBreakpoints would also take away the
	ones the user placed themselves, which is not something to do on their behalf
	while they are debugging alongside the agent.
]]
local function clear(): number
	local service = debugger()
	local removed = 0

	for key, entry in pairs(registry) do
		local ok = pcall(function()
			service:RemoveBreakpoint(entry.instance, entry.line)
		end)

		if ok then
			removed += 1
		end

		registry[key] = nil
	end

	return removed
end

function DebugOps.breakpoints(params: any): any
	local removed = 0

	if params.action == "set" then
		set(params)
	elseif params.action == "remove" then
		removed = remove(params)
	elseif params.action == "clear" then
		removed = clear()
	end

	return {
		breakpoints = held(),
		removed = removed,
		realm = RunState.current().realm,
	}
end

local available: boolean? = nil

--[[
	Probed by setting a breakpoint and taking it back, not by finding the service
	or naming its methods. The debugger API is behind a Studio beta, and a build
	without it still hands over a service object.
]]
function DebugOps.isAvailable(): boolean
	if available ~= nil then
		return available :: boolean
	end

	local ok, service = pcall(function()
		return game:GetService("ScriptDebuggerService")
	end)

	if not ok or service == nil then
		available = false
		return false
	end

	local probe = Instance.new("ModuleScript")
	probe.Name = "LuuCodeDebugProbe"
	probe.Source = "return true\n"
	-- The plugin's own script: outside the DataModel, so nothing is added to the
	-- place and no breakpoint of ours can survive the probe.
	probe.Parent = script

	local accepted = pcall(function()
		service:AddBreakpoint(probe, { Line = 1, Enabled = false, ContinueExecution = true, LogMessage = '""' })
	end)

	pcall(function()
		service:RemoveBreakpoint(probe, 1)
	end)

	probe:Destroy()

	available = accepted
	return accepted
end

return DebugOps
