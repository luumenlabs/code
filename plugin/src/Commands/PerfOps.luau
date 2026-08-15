--!nonstrict
--[[
	Frame time, draw calls, and memory, from Stats.

	Every reading carries its worst frame as well as its mean, because a game
	that hitches once a second still has a good average. Anything Studio declines
	to report is named in `unavailable` rather than returned as zero.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Stats = game:GetService("Stats")

local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local RunState = require(script.Parent.Parent.RunState)
local Value = require(script.Parent.Parent.Value)

local PerfOps = {}

--[[
	One property of Stats, or nil. The set Stats exposes varies by Studio version
	and by peer — a server DataModel has no renderer to report draw calls for.
]]
local function readNumber(name: string): number?
	local ok, value = pcall(function()
		return (Stats :: any)[name]
	end)

	if ok and type(value) == "number" then
		return value
	end

	return nil
end

local function newSeries(): any
	return { total = 0, worst = 0, count = 0 }
end

local function observe(series: any, value: number?)
	if value == nil then
		return
	end

	series.total += value
	series.count += 1
	if value > series.worst then
		series.worst = value
	end
end

local function summarise(series: any): any
	if series.count == 0 then
		return { mean = 0, worst = 0 }
	end
	return { mean = series.total / series.count, worst = series.worst }
end

local TRACKED = {
	frameTime = "FrameTime",
	renderCpuMs = "RenderCPUFrameTime",
	renderGpuMs = "RenderGPUFrameTime",
	physicsStepMs = "PhysicsStepTime",
	drawCalls = "SceneDrawcallCount",
	triangles = "SceneTriangleCount",
}

function PerfOps.sample(params: any): any
	local durationSeconds = (params.durationMs or 3000) / 1000

	local series = {}
	local missing = {}

	for key, property in pairs(TRACKED) do
		series[key] = newSeries()
		if readNumber(property) == nil then
			table.insert(missing, property)
		end
	end

	local frames = 0
	local deadline = os.clock() + durationSeconds

	-- Sampled on Heartbeat rather than RenderStepped so this works in a server
	-- DataModel too, where there is no render loop but the physics and memory
	-- readings are exactly what someone is asking about.
	while os.clock() < deadline do
		for key, property in pairs(TRACKED) do
			observe(series[key], readNumber(property))
		end
		frames += 1
		RunService.Heartbeat:Wait()
	end

	local frameTime = summarise(series.frameTime)

	local memoryMb = 0
	local byCategory = {}

	if params.includeMemory ~= false then
		local totalOk, total = pcall(function()
			return Stats:GetTotalMemoryUsageMb()
		end)
		memoryMb = totalOk and total or 0

		local namesOk, names = pcall(function()
			return Stats:GetMemoryUsageMbAllCategories()
		end)

		if namesOk and type(names) == "table" then
			for category, megabytes in pairs(names) do
				if type(megabytes) == "number" and megabytes > 0 then
					table.insert(byCategory, { category = tostring(category), megabytes = megabytes })
				end
			end

			table.sort(byCategory, function(left, right)
				return left.megabytes > right.megabytes
			end)

			-- The long tail is a hundred categories holding a few kilobytes
			-- each, which costs an agent's context and tells it nothing.
			while #byCategory > 12 do
				table.remove(byCategory)
			end
		else
			table.insert(missing, "GetMemoryUsageMbAllCategories")
		end
	end

	local state = RunState.current()

	return {
		durationMs = math.floor(durationSeconds * 1000),
		frames = frames,
		realm = state.realm,
		running = state.running,
		frameTime = frameTime,
		-- Reported alongside the millisecond figure because frames per second is
		-- the number people actually hold an opinion about.
		fps = frameTime.mean > 0 and 1 / frameTime.mean or 0,
		renderCpuMs = summarise(series.renderCpuMs),
		renderGpuMs = summarise(series.renderGpuMs),
		physicsStepMs = summarise(series.physicsStepMs),
		drawCalls = summarise(series.drawCalls),
		triangles = summarise(series.triangles),
		instanceCount = readNumber("InstanceCount") or 0,
		movingParts = readNumber("MovingPrimitivesCount") or 0,
		memoryMb = memoryMb,
		memoryByCategory = byCategory,
		unavailable = missing,
	}
end

--[[
	Where the Luau time went, from ScriptProfilerService. `perf.sample` says
	whether the place is slow; this says which function. It needs running code,
	so it is a playtest operation.

	Flags are a bitfield on each function: 1 is a native engine frame, 2 a
	plugin one. Neither is code the place can change, so both are dropped unless
	asked for — otherwise the profile is led by Luu Code's own capture.
]]
local NATIVE_FLAG = 1
local PLUGIN_FLAG = 2

local function profiler(): any
	local ok, service = pcall(function()
		return game:GetService("ScriptProfilerService")
	end)

	if not ok or service == nil then
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			"This Studio build does not expose ScriptProfilerService",
			{ reason = ok and "nil service" or tostring(service) },
			"Use perf.sample for frame time and memory, which every build reports."
		)
	end

	return service
end

local function displayName(entry: any): string
	if type(entry.Name) == "string" and entry.Name ~= "" then
		return entry.Name
	end

	if type(entry.Source) == "string" and entry.Source ~= "" then
		if type(entry.Line) == "number" and entry.Line > 0 then
			return string.format("%s:%d", entry.Source, entry.Line)
		end
		return entry.Source
	end

	return "<anonymous>"
end

function PerfOps.script(params: any): any
	local state = RunState.current()

	if not state.running then
		Errors.throw(
			"PLAYTEST_NOT_RUNNING",
			"There is no running code to profile in edit mode",
			{ realm = state.realm },
			"Start a playtest first, then profile the peer running the code you care about."
		)
	end

	local service = profiler()
	local durationMs = params.durationMs or 1000
	local frequency = params.frequency or 1000
	local isServer = RunService:IsServer()
	local player = Players.LocalPlayer

	if not isServer and player == nil then
		Errors.throw(
			"RUNTIME_CONTEXT_UNAVAILABLE",
			"This client DataModel has no LocalPlayer to profile",
			{ realm = state.realm },
			'Wait for the playtest to be ready with studio_wait_ready, or profile the server with realm "server".'
		)
	end

	local raw: string? = nil
	local connection = service.OnNewData:Connect(function(_player: any, json: string)
		if raw == nil then
			raw = json
		end
	end)

	local started, startError = pcall(function()
		if isServer then
			service:ServerStart(frequency)
		else
			service:ClientStart(player, frequency)
		end
	end)

	if not started then
		connection:Disconnect()
		error(Errors.fromRobloxError(tostring(startError), { realm = state.realm }), 0)
	end

	task.wait(durationMs / 1000)

	local stopped, stopError = pcall(function()
		if isServer then
			service:ServerStop()
			service:ServerRequestData()
		else
			service:ClientStop(player)
			service:ClientRequestData(player)
		end
	end)

	if not stopped then
		connection:Disconnect()
		error(Errors.fromRobloxError(tostring(stopError), { realm = state.realm }), 0)
	end

	-- The data arrives on an event rather than from the call, so there is a wait
	-- here that is not the sample.
	local deadline = os.clock() + 5
	while raw == nil and os.clock() < deadline do
		task.wait(0.05)
	end

	connection:Disconnect()

	if raw == nil then
		Errors.throw(
			"STUDIO_TIMEOUT",
			"The profiler stopped but never handed back its data",
			{ durationMs = durationMs, realm = state.realm },
			"Try a shorter durationMs, or profile the other peer."
		)
	end

	local captured = raw :: string
	local decoded, profile = pcall(function()
		return HttpService:JSONDecode(captured)
	end)

	if not decoded then
		Errors.throw("INTERNAL", string.format("Could not read the profiler's output: %s", tostring(profile)), {
			bytes = #captured,
		})
	end

	local window = durationMs * 1000
	if type(profile.SessionStartTime) == "number" and type(profile.SessionEndTime) == "number" then
		local measured = profile.SessionEndTime - profile.SessionStartTime
		if measured > 0 then
			window = measured
		end
	end

	local rows = {}
	local filtered = 0

	for _, entry in ipairs(profile.Functions or {}) do
		local flags = type(entry.Flags) == "number" and entry.Flags or 0
		local engine = bit32.band(flags, NATIVE_FLAG) ~= 0 or bit32.band(flags, PLUGIN_FLAG) ~= 0
		local total = type(entry.TotalDuration) == "number" and entry.TotalDuration or 0
		local name = displayName(entry)
		local source = type(entry.Source) == "string" and entry.Source or nil

		local keep = total >= (params.minMicroseconds or 0)

		if keep and engine and params.includeEngine ~= true then
			keep = false
		end

		if keep and params.contains ~= nil then
			local needle = string.lower(params.contains)
			local haystack = string.lower(name .. " " .. (source or ""))
			keep = string.find(haystack, needle, 1, true) ~= nil
		end

		if keep then
			table.insert(rows, {
				name = name,
				source = source or Value.NIL,
				line = type(entry.Line) == "number" and entry.Line or Value.NIL,
				totalMicroseconds = total,
				share = window > 0 and total / window or 0,
				engine = engine,
			})
		else
			filtered += 1
		end
	end

	table.sort(rows, function(left, right)
		return left.totalMicroseconds > right.totalMicroseconds
	end)

	local limit = params.limit or 20
	local truncated = #rows > limit

	while #rows > limit do
		table.remove(rows)
	end

	return {
		realm = state.realm,
		durationMs = durationMs,
		frequency = frequency,
		functions = rows,
		totalMicroseconds = window,
		filtered = filtered,
		truncated = truncated,
	}
end

--[[
	Probed by asking for the service and for the entry point that matches this
	peer. There is nothing to probe by doing: starting a capture is the operation
	itself, and it takes a second.
]]
function PerfOps.canProfileScripts(): boolean
	local ok, service = pcall(function()
		return game:GetService("ScriptProfilerService")
	end)

	if not ok or service == nil then
		return false
	end

	-- The value, not just whether the index raised: a member Roblox does not have
	-- raises on an Instance, but one it has and cannot use would still read back,
	-- and reporting a capability that fails on first call is worse than reporting
	-- none.
	local probed, usable = pcall(function()
		if RunService:IsServer() then
			return service.ServerStart ~= nil and service.ServerRequestData ~= nil
		end
		return service.ClientStart ~= nil and service.ClientRequestData ~= nil
	end)

	return probed and usable == true
end

--[[
	A census, with the heaviest containers alongside so the counts are actionable.
	"Heaviest" is descendant count: memory is not attributable to a subtree here.
]]
function PerfOps.count(params: any): any
	local scope = params.scope and Handles.resolve(params.scope) or game
	local topClasses = params.topClasses or 12
	local topSubtrees = params.topSubtrees or 8

	local descendants = scope:GetDescendants()
	local counts = {}
	local parts = 0
	local scripts = 0

	for _, instance in ipairs(descendants) do
		local className = instance.ClassName
		counts[className] = (counts[className] or 0) + 1

		if instance:IsA("BasePart") then
			parts += 1
		elseif instance:IsA("LuaSourceContainer") then
			scripts += 1
		end
	end

	local byClass = {}
	for className, count in pairs(counts) do
		table.insert(byClass, { className = className, count = count })
	end

	table.sort(byClass, function(left, right)
		if left.count ~= right.count then
			return left.count > right.count
		end
		return left.className < right.className
	end)

	while #byClass > topClasses do
		table.remove(byClass)
	end

	-- Only direct children are weighed. Every ancestor of a heavy subtree is
	-- also heavy, so ranking every container would return the same subtree
	-- described at eight different depths.
	local heaviest = {}
	for _, child in ipairs(scope:GetChildren()) do
		local size = #child:GetDescendants()
		if size > 0 then
			table.insert(heaviest, { instance = Handles.describe(child), descendants = size })
		end
	end

	table.sort(heaviest, function(left, right)
		return left.descendants > right.descendants
	end)

	while #heaviest > topSubtrees do
		table.remove(heaviest)
	end

	return {
		total = #descendants,
		-- Always described, the DataModel included. "What did you count" is part
		-- of the answer, and an omitted field makes a whole-place census and a
		-- scoped one look identical.
		scope = Handles.describe(scope),
		byClass = byClass,
		heaviest = heaviest,
		parts = parts,
		scripts = scripts,
		truncated = #byClass >= topClasses,
	}
end

function PerfOps.isAvailable(): boolean
	local ok = pcall(function()
		return game:GetService("Stats").FrameTime
	end)
	return ok
end

return PerfOps
