--!nonstrict
--[[
	The rules the place carries for coding agents, at TestService.AGENTS.

	The long-string wrapper is applied and stripped by the server, so this reads
	and writes an ordinary ModuleScript source.
]]

local Changes = require(script.Parent.Parent.Changes)
local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local History = require(script.Parent.Parent.History)
local Path = require(script.Parent.Parent.Path)
local ScriptSource = require(script.Parent.Parent.ScriptSource)
local Value = require(script.Parent.Parent.Value)

local RulesOps = {}

local NAME = "AGENTS"

-- FindService, not GetService: reading is a read, and GetService would insert a
-- TestService into a place that does not have one.
local function findService(): Instance?
	local ok, service = pcall(function()
		return game:FindService("TestService")
	end)

	return (ok and service or nil) :: Instance?
end

function RulesOps.get(): any
	local service = findService()
	local existing = service and service:FindFirstChild(NAME) or nil

	if existing == nil then
		return { present = false, path = Value.NIL, source = Value.NIL, conflict = Value.NIL }
	end

	if not existing:IsA("ModuleScript") then
		return { present = false, path = Value.NIL, source = Value.NIL, conflict = existing.ClassName }
	end

	return {
		present = true,
		path = Path.of(existing),
		source = ScriptSource.read(existing),
		conflict = Value.NIL,
	}
end

function RulesOps.set(params: any): any
	local service = game:GetService("TestService")
	local existing = service:FindFirstChild(NAME)

	if existing ~= nil and not existing:IsA("ModuleScript") then
		Errors.throw(
			"TARGET_AMBIGUOUS",
			string.format("TestService.%s is a %s, not a ModuleScript", NAME, existing.ClassName),
			{ className = existing.ClassName },
			"Rename or remove it, then try again."
		)
	end

	if existing ~= nil then
		local before, unreadable = ScriptSource.tryRead(existing)

		local _, undoLabel = History.record("Edit the project rules", function()
			ScriptSource.write(existing, params.source)
		end)

		return {
			instances = { Handles.describe(existing) },
			undoLabel = undoLabel,
			lineCount = ScriptSource.countLines(params.source),
			created = false,
			changes = { Changes.source(existing, before, unreadable, params.source) },
		}
	end

	local created, undoLabel = History.record("Create the project rules", function()
		local instance = Instance.new("ModuleScript")
		instance.Name = NAME
		instance.Parent = service
		-- Parented first so the editor path has a real location to write to.
		ScriptSource.write(instance, params.source)
		return instance
	end)

	return {
		instances = { Handles.describe(created) },
		undoLabel = undoLabel,
		lineCount = ScriptSource.countLines(params.source),
		created = true,
		changes = { Changes.create(created) },
	}
end

return RulesOps
