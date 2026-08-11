--!nonstrict
--[[
	Command dispatch.

	The op names here mirror packages/protocol/src/commands.ts. Handlers raise
	structured errors; the caller turns anything else into INTERNAL so a Luau
	mistake in one handler can never take the connection down.
]]

local Changes = require(script.Parent.Changes)
local Errors = require(script.Parent.Errors)
local Exec = require(script.Parent.Exec)
local Handles = require(script.Parent.Handles)
local History = require(script.Parent.History)
local InputBridge = require(script.Parent.InputBridge)

local DataModelOps = require(script.DataModelOps)
local InputOps = require(script.InputOps)
local RunOps = require(script.RunOps)
local ScriptOps = require(script.ScriptOps)

local Commands = {}

local HANDLERS: { [string]: (any) -> any } = {
	["dm.services"] = function()
		return DataModelOps.services()
	end,
	["dm.get"] = DataModelOps.get,
	["dm.children"] = DataModelOps.children,
	["dm.tree"] = DataModelOps.tree,
	["dm.search"] = DataModelOps.search,
	["dm.properties"] = DataModelOps.properties,
	["dm.selection.get"] = function()
		return DataModelOps.selectionGet()
	end,
	["dm.selection.set"] = DataModelOps.selectionSet,
	["dm.set_properties"] = DataModelOps.setProperties,
	["dm.create"] = DataModelOps.create,
	["dm.delete"] = DataModelOps.delete,
	["dm.rename"] = DataModelOps.rename,
	["dm.reparent"] = DataModelOps.reparent,
	["dm.clone"] = DataModelOps.clone,
	["dm.attributes.set"] = DataModelOps.setAttributes,
	["dm.tags.set"] = DataModelOps.setTags,

	-- The server owns the journal and sends the records back to be undone, so
	-- there is no list operation here: the plugin holds only the copies of
	-- destroyed subtrees, which are not describable in JSON.
	["changes.apply"] = function(params)
		return Changes.apply(params.records or {}, params.force == true)
	end,

	["script.list"] = ScriptOps.list,
	["script.get"] = ScriptOps.get,
	["script.set"] = ScriptOps.set,
	["script.patch"] = ScriptOps.patch,
	["script.create"] = ScriptOps.create,

	["run.state"] = function()
		return RunOps.state()
	end,
	["run.start"] = RunOps.start,
	["run.stop"] = function()
		return RunOps.stop()
	end,
	["run.wait_ready"] = RunOps.waitReady,

	["runtime.exec"] = function(params)
		return Exec.run(params.source, params.timeoutMs or 10000)
	end,

	["input.key"] = InputOps.key,
	["input.text"] = InputOps.text,
	["input.mouse"] = InputOps.mouse,
	["input.gui_click"] = InputOps.guiClick,
	["view.viewport_info"] = function()
		return InputOps.viewportInfo()
	end,
}

--[[
	Runs one command and always returns a result envelope, never raises.
]]
function Commands.dispatch(op: string, params: any): any
	local handler = HANDLERS[op]

	if handler == nil then
		return {
			ok = false,
			error = Errors.new("INVALID_PARAMS", string.format("Unknown operation %q", tostring(op)), { op = op }),
		}
	end

	local ok, result = pcall(handler, params or {})

	if ok then
		return { ok = true, data = result }
	end

	return { ok = false, error = Errors.coerce(result) }
end

function Commands.supports(op: string): boolean
	return HANDLERS[op] ~= nil
end

--[[
	Capability probe, run at startup and after every edit/run transition.
	Reporting these honestly is what keeps agents from calling operations that
	cannot work in the current environment. Spec section 49.
]]
function Commands.capabilities(): { string }
	local available = {
		"inspect.datamodel",
		"inspect.scripts",
		"inspect.selection",
		"edit.instances",
		"edit.scripts",
		"runtime.inspect",
	}

	if History.isAvailable() then
		table.insert(available, "edit.undo-history")
	end

	if Exec.isAvailable() then
		table.insert(available, "runtime.exec")
	end

	if InputBridge.isAvailable() then
		table.insert(available, "input.virtual")
		-- Play is driven through the same virtual input path as everything else.
		table.insert(available, "playtest.play")
	end

	local canRun = pcall(function()
		return game:GetService("RunService").Run ~= nil
	end)

	if canRun then
		table.insert(available, "playtest.run")
	end

	table.insert(available, "output.capture")

	return available
end

function Commands.prune()
	Handles.prune()
end

return Commands
