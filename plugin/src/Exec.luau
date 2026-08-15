--!nonstrict
--[[
	Runtime execution. Source is compiled by creating a ModuleScript inside the
	plugin's own container and requiring it: nothing is added to the place,
	replicates, or lands in the undo history. Roblox gates `loadstring` behind a
	place setting, so it is only the fallback for a DataModel that cannot write
	Source at all — the playtest bridge, which is an ordinary game script.

	It runs at whatever the host has: plugin security in Studio's own DataModels,
	and a game script's inside a playtest.
]]

local Errors = require(script.Parent.Errors)
local OutputCapture = require(script.Parent.OutputCapture)
local RunState = require(script.Parent.RunState)
local Value = require(script.Parent.Value)

local Exec = {}

local counter = 0

--[[
	The fallback for a DataModel that cannot write Source. `loadstring` is off in
	most places and absent in some builds, so this often only turns one refusal
	into a better-worded one.
]]
local function compileWithLoadstring(source: string): (boolean, any)
	local loader = loadstring :: any

	if type(loader) ~= "function" then
		return false,
			"This DataModel cannot compile source: writing Script.Source needs plugin identity, and loadstring is unavailable here."
	end

	local ok, chunk, syntaxError = pcall(loader, source)

	if not ok then
		return false, "This DataModel cannot compile source: loadstring is turned off for this place."
	end

	if chunk == nil then
		return false, syntaxError
	end

	return pcall(chunk)
end

local function compile(source: string): (boolean, any)
	counter += 1

	local module = Instance.new("ModuleScript")
	module.Name = "LuuCodeExec_" .. tostring(counter)

	-- Writing Source needs plugin identity, and the bridge inside a playtest is
	-- an ordinary game script. Catching it matters twice over: this runs on the
	-- capability probe every handshake goes through, and there is a second way
	-- to compile worth trying before giving up.
	local wrote = pcall(function()
		module.Source = source
	end)

	if not wrote then
		module:Destroy()
		return compileWithLoadstring(source)
	end

	-- The plugin script itself: outside the DataModel, so the place is untouched.
	module.Parent = script

	local ok, result = pcall(require, module)
	module:Destroy()

	return ok, result
end

--[[
	Agents write both statements ("local p = ... ; return p.Health") and bare
	expressions ("workspace.Part.Position"). Statement form is tried first
	because it is what a script normally contains; the expression wrapper is the
	fallback so one-liners still work.
]]
local function build(source: string): (boolean, any)
	local ok, result = compile("return function()\n" .. source .. "\nend")
	if ok then
		return true, result
	end

	local expressionOk, expressionResult = compile("return function()\nreturn (" .. source .. ")\nend")
	if expressionOk then
		return true, expressionResult
	end

	-- Report the statement-form error: it is the one that matches what the
	-- agent actually wrote.
	return false, result
end

--[[
	Compiles source without running it, for the check returned by every script
	write. The body goes inside a function that is never called, so `require`
	compiles the whole chunk and executes only the `return`. The wrapper is
	vararg because a top-level `...` is legal in a Script.

	One line of wrapper means every line the compiler names is one too high.
]]
function Exec.check(source: string): any
	local ok, err = compile("return function(...)\n" .. source .. "\nend")

	if ok then
		return { ok = true, message = Value.NIL, line = Value.NIL }
	end

	local message = tostring(err)
	local line: number? = nil

	-- "LuuCodeExec_3:12: Expected 'end' ...". The chunk name is the throwaway
	-- module and means nothing to the caller; the line does, once corrected.
	local chunk, reported, rest = string.match(message, "^([%w_%.]+):(%d+):%s(.*)$")
	if chunk ~= nil then
		line = math.max((tonumber(reported) or 2) - 1, 1)
		message = rest
	end

	return {
		ok = false,
		message = message,
		line = line or Value.NIL,
	}
end

function Exec.run(source: string, timeoutMs: number): any
	local startedAt = os.clock()

	local ok, factory = build(source)
	if not ok then
		Errors.throw("EXECUTION_ERROR", "Could not compile the supplied Luau: " .. tostring(factory), { source = source })
	end

	if type(factory) ~= "function" then
		Errors.throw("EXECUTION_ERROR", "Compiled chunk did not produce a callable", { source = source })
	end

	local returned: any = nil
	local failure: any = nil
	local finished = false

	local printed = OutputCapture.record(function()
		local thread = task.spawn(function()
			local success, result = pcall(factory)
			finished = true
			if success then
				returned = result
			else
				failure = result
			end
		end)

		local deadline = os.clock() + timeoutMs / 1000
		while not finished and os.clock() < deadline do
			task.wait(0.02)
		end

		if not finished then
			-- The thread may be parked on a yield that will never resume.
			pcall(task.cancel, thread)
		end
	end)

	if not finished then
		Errors.throw(
			"STUDIO_TIMEOUT",
			string.format("Execution did not finish within %dms", timeoutMs),
			{ source = source },
			"The code probably yielded. Avoid waiting on events that need player input, or raise timeoutMs."
		)
	end

	if failure ~= nil then
		Errors.throw("EXECUTION_ERROR", tostring(failure), { source = source })
	end

	return {
		value = Value.encode(returned),
		output = printed,
		realm = RunState.current().realm,
		elapsedMs = math.floor((os.clock() - startedAt) * 1000),
	}
end

--[[
	Probes whether execution works at all in this Studio session, so the server
	can report the capability honestly instead of failing on first use.
]]
local available: boolean? = nil

function Exec.isAvailable(): boolean
	-- Whether a chunk can be compiled at all is a property of the plugin VM, not
	-- of the DataModel it is attached to, so this is asked once. It is also on
	-- the path of every script write now, through Exec.check.
	if available == nil then
		local ok, factory = compile("return function() return true end")
		available = ok and type(factory) == "function"
	end

	return available :: boolean
end

return Exec
