--!nonstrict
--[[
	Frame time, draw calls, and memory, from Stats.

	Every reading carries its worst frame as well as its mean, because a game
	that hitches once a second still has a good average. Anything Studio declines
	to report is named in `unavailable` rather than returned as zero.
]]

local RunService = game:GetService("RunService")
local Stats = game:GetService("Stats")

local Handles = require(script.Parent.Parent.Handles)
local RunState = require(script.Parent.Parent.RunState)

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
