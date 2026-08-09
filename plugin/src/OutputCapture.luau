--!nonstrict
--[[
	Studio output capture. Spec section 14.

	The point of this module is that the user should never have to copy an error
	out of the Output window and paste it into the agent. Entries are buffered
	locally and shipped up on the next sync, with the realm attached so the
	agent knows whether it is reading a server or client failure.
]]

local LogService = game:GetService("LogService")
local ScriptContext = game:GetService("ScriptContext")

local Constants = require(script.Parent.Constants)

local OutputCapture = {}

local buffer: { any } = {}
local capturing = false
local connections: { RBXScriptConnection } = {}
local flushListener: (() -> ())? = nil
local realmProvider: (() -> string)? = nil

-- Bounded so a runaway loop in the game cannot exhaust Studio's memory.
local MAX_BUFFER = 2000

local TYPE_BY_MESSAGE_TYPE = {
	[Enum.MessageType.MessageOutput] = "output",
	[Enum.MessageType.MessageInfo] = "info",
	[Enum.MessageType.MessageWarning] = "warning",
	[Enum.MessageType.MessageError] = "error",
}

--[[
	Studio prefixes runtime failures with the script path and line, for example:
		ServerScriptService.Shop.Handler:42: attempt to index nil with 'Price'
	Splitting that out lets the harness link straight to the instance and saves
	the agent from re-parsing it.
]]
local function extractSource(message: string): (string?, string)
	local source, rest = string.match(message, "^([%w_%.%[%]\"' ]+:%d+):%s(.*)$")
	if source ~= nil then
		return source, rest
	end
	return nil, message
end

local function push(messageType: string, message: string, stack: string?)
	if #buffer >= MAX_BUFFER then
		table.remove(buffer, 1)
	end

	local source, text = extractSource(message)

	table.insert(buffer, {
		timestamp = os.time() * 1000,
		type = messageType,
		message = text,
		source = source,
		stack = stack,
		realm = realmProvider and realmProvider() or "unknown",
	})

	if flushListener ~= nil and #buffer >= Constants.OUTPUT_FLUSH_THRESHOLD then
		flushListener()
	end
end

function OutputCapture.start(getRealm: () -> string, onFlushNeeded: () -> ())
	if capturing then
		return
	end

	capturing = true
	realmProvider = getRealm
	flushListener = onFlushNeeded

	table.insert(
		connections,
		LogService.MessageOut:Connect(function(message: string, messageType: Enum.MessageType)
			push(TYPE_BY_MESSAGE_TYPE[messageType] or "output", message)
		end)
	)

	-- ScriptContext.Error carries the stack trace that MessageOut drops, which
	-- is usually the difference between an agent guessing and an agent knowing.
	local ok = pcall(function()
		table.insert(
			connections,
			ScriptContext.Error:Connect(function(message: string, stackTrace: string, _source: Instance?)
				push("error", message, stackTrace)
			end)
		)
	end)

	if not ok then
		-- Not fatal: MessageOut still reports the error text itself.
		push("info", "Luu Code: stack traces are unavailable in this Studio context")
	end
end

function OutputCapture.stop()
	for _, connection in ipairs(connections) do
		connection:Disconnect()
	end
	table.clear(connections)
	capturing = false
end

--[[
	Takes everything buffered so far. The server owns cursors and ordering, so
	the plugin only has to hand over what it has seen.
]]
function OutputCapture.drain(max: number?): { any }
	if #buffer == 0 then
		return {}
	end

	local limit = math.min(max or #buffer, #buffer)
	local drained = table.move(buffer, 1, limit, 1, {})

	if limit == #buffer then
		table.clear(buffer)
	else
		local remaining = table.move(buffer, limit + 1, #buffer, 1, {})
		buffer = remaining
	end

	return drained
end

function OutputCapture.pending(): number
	return #buffer
end

--[[
	Captures everything printed while `body` runs. Used by runtime.exec so the
	agent gets the prints its own code produced without trawling the whole log.
]]
function OutputCapture.record(body: () -> ()): { string }
	local captured = {}
	local connection = LogService.MessageOut:Connect(function(message: string)
		table.insert(captured, message)
	end)

	local ok, err = pcall(body)

	-- MessageOut is deferred by a frame, so give it one before disconnecting.
	task.wait()
	connection:Disconnect()

	if not ok then
		error(err, 0)
	end

	return captured
end

return OutputCapture
