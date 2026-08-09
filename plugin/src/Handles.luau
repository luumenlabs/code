--!nonstrict
--[[
	Handle registry. Spec section 30.

	An agent that inspected an instance must be able to act on that exact
	instance later, and must be told clearly when it no longer exists. Handles
	are stamped with the realm epoch, which increments on every edit/run
	transition, so a handle captured during a playtest can never be replayed
	against the edit-time DataModel.
]]

local Errors = require(script.Parent.Errors)
local Path = require(script.Parent.Path)

local Handles = {}

local nextId = 0
local epoch = 0

-- id -> { instance, epoch }
local entries: { [string]: { instance: Instance, epoch: number } } = {}
-- Instance -> id, weak so destroyed instances do not pin memory.
local ids: { [Instance]: string } = setmetatable({}, { __mode = "k" }) :: any

--[[
	Called when Studio moves between edit and run. Existing handles stay in the
	table so we can report WRONG_REALM instead of a confusing TARGET_NOT_FOUND.
]]
function Handles.setEpoch(value: number)
	if value == epoch then
		return
	end
	epoch = value
	table.clear(ids)
end

function Handles.epoch(): number
	return epoch
end

function Handles.isHandle(target: string): boolean
	return string.sub(target, 1, 1) == "@"
end

function Handles.forInstance(instance: Instance): string
	local existing = ids[instance]
	if existing ~= nil then
		return existing
	end

	nextId += 1
	local id = "@h" .. tostring(nextId)
	entries[id] = { instance = instance, epoch = epoch }
	ids[instance] = id
	return id
end

local function isAlive(instance: Instance): boolean
	if instance == game then
		return true
	end
	-- Destroy parents to nil and locks the instance, so descendancy is the
	-- reliable liveness test. Detached-but-not-destroyed instances are treated
	-- as stale too: acting on them cannot affect the place.
	local ok, alive = pcall(function()
		return instance:IsDescendantOf(game)
	end)
	return ok and alive
end

function Handles.resolveHandle(handle: string): Instance
	local entry = entries[handle]
	if entry == nil then
		Errors.throw(
			"TARGET_NOT_FOUND",
			string.format("Unknown handle %s", handle),
			{ handle = handle },
			"Handles are only valid for the current Studio session. Re-inspect the instance to get a fresh one."
		)
	end

	if entry.epoch ~= epoch then
		Errors.throw(
			"WRONG_REALM",
			string.format("Handle %s was created before the current edit/run transition", handle),
			{ handle = handle, handleEpoch = entry.epoch, currentEpoch = epoch },
			"Re-inspect the instance now that the run state has changed."
		)
	end

	if not isAlive(entry.instance) then
		entries[handle] = nil
		Errors.throw(
			"TARGET_STALE",
			string.format("%s no longer exists in the DataModel", handle),
			{ handle = handle },
			"The instance was destroyed or moved out of the DataModel. Search for it by name or path."
		)
	end

	return entry.instance
end

--[[
	Resolves a target string: either a handle or a DataModel path.
	This is the single entry point every command handler uses.
]]
function Handles.resolve(target: string): Instance
	if type(target) ~= "string" or #target == 0 then
		Errors.throw("INVALID_PARAMS", "A target must be a handle or a DataModel path")
	end

	if Handles.isHandle(target) then
		return Handles.resolveHandle(target)
	end

	return Path.resolve(target, Handles.describe)
end

--[[
	The summary shape returned by every inspection command. Keeping it in one
	place means an agent sees the same fields everywhere.
]]
function Handles.describe(instance: Instance): any
	local childCount = 0
	local ok, children = pcall(function()
		return instance:GetChildren()
	end)
	if ok then
		childCount = #children
	end

	return {
		handle = Handles.forInstance(instance),
		path = Path.of(instance),
		name = instance.Name,
		className = instance.ClassName,
		childCount = childCount,
	}
end

function Handles.describeMany(instances: { Instance }): { any }
	local described = {}
	for index, instance in ipairs(instances) do
		described[index] = Handles.describe(instance)
	end
	return described
end

--[[
	Drops handles whose instances are gone. Called periodically so a long
	session does not accumulate dead entries.
]]
function Handles.prune(): number
	local removed = 0
	for id, entry in pairs(entries) do
		if entry.epoch ~= epoch or not isAlive(entry.instance) then
			entries[id] = nil
			removed += 1
		end
	end
	return removed
end

return Handles
