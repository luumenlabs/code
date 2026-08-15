--!nonstrict
--[[
	Command dispatch.

	The op names here mirror packages/protocol/src/commands.ts. Handlers raise
	structured errors; the caller turns anything else into INTERNAL so a Luau
	mistake in one handler can never take the connection down.
]]

local Capture = require(script.Parent.Capture)
local Changes = require(script.Parent.Changes)
local Errors = require(script.Parent.Errors)
local Exec = require(script.Parent.Exec)
local Handles = require(script.Parent.Handles)
local History = require(script.Parent.History)
local InputBridge = require(script.Parent.InputBridge)
local Value = require(script.Parent.Value)

local AssetOps = require(script.AssetOps)
local ClassOps = require(script.ClassOps)
local DataModelOps = require(script.DataModelOps)
local DebugOps = require(script.DebugOps)
local InputOps = require(script.InputOps)
local NetworkOps = require(script.NetworkOps)
local PerfOps = require(script.PerfOps)
local RulesOps = require(script.RulesOps)
local RunOps = require(script.RunOps)
local ScreenOps = require(script.ScreenOps)
local ScriptOps = require(script.ScriptOps)
local TestOps = require(script.TestOps)
local ViewOps = require(script.ViewOps)

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
	["dm.class_info"] = ClassOps.info,
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
	["script.grep"] = ScriptOps.grep,
	["script.replace"] = ScriptOps.replace,
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
	["run.multiplayer"] = RunOps.multiplayer,
	["run.network"] = NetworkOps.apply,

	["runtime.exec"] = function(params)
		return Exec.run(params.source, params.timeoutMs or 10000)
	end,
	["debug.breakpoints"] = DebugOps.breakpoints,

	["input.key"] = InputOps.key,
	["input.text"] = InputOps.text,
	["input.mouse"] = InputOps.mouse,
	["input.gui_click"] = InputOps.guiClick,
	["view.viewport_info"] = function()
		return InputOps.viewportInfo()
	end,
	["view.gui"] = ScreenOps.tree,
	["view.screenshot"] = Capture.screenshot,
	["view.focus"] = ViewOps.focus,
	["view.highlight"] = ViewOps.highlight,

	["perf.sample"] = PerfOps.sample,
	["perf.script"] = PerfOps.script,
	["perf.count"] = PerfOps.count,

	["test.run"] = TestOps.run,

	["rules.get"] = function()
		return RulesOps.get()
	end,
	["rules.set"] = RulesOps.set,

	["assets.insert"] = AssetOps.insert,
}

--[[
	Applies a sequence of edits under one undo waypoint.

	The steps call the ordinary handlers, so a batched create is exactly a create.
	Their own recordings decline harmlessly — Studio allows one at a time and the
	outer one is open — which is what makes a hundred edits a single Ctrl+Z.
]]
local function runBatch(params: any): any
	local operations = params.operations or {}
	local stopOnError = params.stopOnError ~= false

	local steps = {}
	local instances = {}
	local drafts = {}
	local applied = 0
	local failed = 0
	local skipped = 0

	local _, undoLabel = History.record(string.format("Apply %d edit(s)", #operations), function()
		for index, entry in ipairs(operations) do
			local handler = HANDLERS[entry.op]

			if handler == nil then
				table.insert(steps, {
					index = index - 1,
					op = entry.op,
					status = "failed",
					instances = {},
					error = Errors.new("INVALID_PARAMS", string.format("Unknown operation %q", tostring(entry.op)), { op = entry.op }),
				})
				failed += 1
			else
				local ok, result = pcall(handler, entry.params or {})

				if ok then
					local produced = result.instances or {}
					table.insert(steps, { index = index - 1, op = entry.op, status = "ok", instances = produced, error = Value.NIL })
					table.move(produced, 1, #produced, #instances + 1, instances)

					for _, draft in ipairs(result.changes or {}) do
						table.insert(drafts, draft)
					end

					applied += 1
				else
					table.insert(
						steps,
						{ index = index - 1, op = entry.op, status = "failed", instances = {}, error = Errors.coerce(result) }
					)
					failed += 1
				end
			end

			-- Reported rather than dropped: the caller asked for a sequence, and
			-- where the sequence stopped is most of what they need to fix it.
			if failed > 0 and stopOnError then
				for rest = index + 1, #operations do
					table.insert(steps, {
						index = rest - 1,
						op = operations[rest].op,
						status = "skipped",
						instances = {},
						error = Value.NIL,
					})
					skipped += 1
				end
				break
			end
		end
	end)

	return {
		instances = instances,
		undoLabel = undoLabel,
		steps = steps,
		applied = applied,
		failed = failed,
		skipped = skipped,
		changes = drafts,
	}
end

HANDLERS["dm.batch"] = runBatch

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
	Capability probe, run once per DataModel, so an agent is never offered an
	operation that cannot work here.

	Cached because several of these answer by trying the thing — opening an undo
	recording, setting a breakpoint, constructing a VirtualInput — and the sync
	loop asks on every round trip. Nothing here changes while a DataModel is
	alive; `release` drops the answers when Studio hands us a new one.
]]
local cached: { string }? = nil

--[[
	Asks one probe. A probe that raises is a capability this DataModel does not
	have, not a bug worth propagating: several of them answer by using a
	plugin-only API, and the bridge inside a playtest is an ordinary game script
	where those refuse. This whole list is built on the handshake path, so one
	probe raising used to take the connection down with it and leave the playtest
	unobservable — which is the thing the bridge exists to fix.
]]
local function can(test: () -> boolean): boolean
	local ok, available = pcall(test)
	return ok and available == true
end

function Commands.capabilities(): { string }
	if cached ~= nil then
		return cached :: { string }
	end

	local available = {
		"inspect.datamodel",
		"inspect.scripts",
		"inspect.selection",
		"edit.instances",
		"edit.scripts",
		"runtime.inspect",
	}

	if can(History.isAvailable) then
		table.insert(available, "edit.undo-history")
	end

	if can(Exec.isAvailable) then
		table.insert(available, "runtime.exec")
	end

	-- Probed by setting one and taking it back: the debugger API is behind a
	-- Studio beta, and a build without it still hands over the service.
	if can(DebugOps.isAvailable) then
		table.insert(available, "debug.breakpoints")
	end

	if can(NetworkOps.isAvailable) then
		table.insert(available, "playtest.network")
	end

	-- Probed by constructing the VirtualInput, not by naming a service. The old
	-- check asked whether VirtualInputManager could be fetched — which is always
	-- true, and told us nothing about whether its methods were callable, which
	-- they were not. Every key and click this session accepted went nowhere.
	if can(InputBridge.isAvailable) then
		table.insert(available, "input.virtual")
	end

	-- Play and Run are one capability: both are StudioTestService methods, so a
	-- build with one has the other. They were reported separately back when Play
	-- went through a mechanism that could not work.
	local probedRun, canPlay, canMultiplayer = pcall(RunOps.capabilities)
	if not probedRun then
		canPlay, canMultiplayer = false, false
	end

	if canPlay then
		table.insert(available, "playtest.play")
		table.insert(available, "playtest.run")
	end

	if canMultiplayer then
		table.insert(available, "playtest.multiplayer")
	end

	if can(Capture.isAvailable) then
		table.insert(available, "view.screenshot")
	end

	if can(ViewOps.isAvailable) then
		table.insert(available, "view.camera")
	end

	if can(PerfOps.isAvailable) then
		table.insert(available, "perf.stats")
	end

	if can(PerfOps.canProfileScripts) then
		table.insert(available, "perf.script-profiler")
	end

	if can(TestOps.isAvailable) then
		table.insert(available, "test.run")
	end

	if can(AssetOps.isAvailable) then
		table.insert(available, "assets.insert")
	end

	table.insert(available, "output.capture")

	cached = available
	return available
end

function Commands.prune()
	Handles.prune()
end

--[[
	Dropped when the DataModel is replaced. A mark adorns an instance in the
	world it was made in, and a remembered camera describes one that is gone.
	The capability answers go too: a playtest peer can do different things.
]]
function Commands.release()
	ViewOps.release()
	History.forget()
	cached = nil
end

return Commands
