--!nonstrict
--[[
	Studio output capture, so nobody has to copy an error out of the Output
	window by hand. Entries are buffered locally and shipped on the next sync,
	with the realm attached so the agent knows which side failed.
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

-- How much of Studio's own log to adopt at startup. The whole history can be
-- thousands of lines from previous sessions; what is wanted is the tail that
-- covers the gap before this plugin loaded.
local SEED_LIMIT = 300

--[[
	Messages taken from the log history, so the live listener does not report
	them twice. MessageOut is deferred by a frame, so one printed just before
	the connection can still arrive through it. Keyed by second and text, held
	only while a deferred message could still be in flight.
]]
local seeded: { [string]: boolean } = {}
local seedGuardUntil = 0

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

local function seedKey(seconds: number, message: string): string
	return string.format("%d\0%s", seconds, message)
end

local function push(messageType: string, message: string, stack: string?, seconds: number?)
	local at = seconds or os.time()

	-- Only while a deferred message could still be arriving; after that the same
	-- line printed again is the game printing it again, and dropping it would be
	-- a lie about what the place did.
	if seconds == nil and os.clock() < seedGuardUntil then
		if seeded[seedKey(at, message)] then
			return
		end
	end

	if #buffer >= MAX_BUFFER then
		table.remove(buffer, 1)
	end

	local source, text = extractSource(message)

	table.insert(buffer, {
		timestamp = at * 1000,
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

--[[
	Adopts what Studio already has in its log. A runtime peer's plugin loads
	after the place's own scripts have started, so everything printed up to that
	point — including a startup error — would otherwise never be seen.
]]
local function seedFromHistory()
	local ok, history = pcall(function()
		return LogService:GetLogHistory()
	end)

	if not ok or type(history) ~= "table" then
		return
	end

	local first = math.max(#history - SEED_LIMIT + 1, 1)

	for index = first, #history do
		local entry = history[index]
		local seconds = math.floor(tonumber(entry.timestamp) or os.time())

		seeded[seedKey(seconds, entry.message)] = true
		push(TYPE_BY_MESSAGE_TYPE[entry.messageType] or "output", entry.message, nil, seconds)
	end

	-- Long enough to cover the frame MessageOut defers by, short enough that a
	-- line the game repeats a moment later is still reported.
	seedGuardUntil = os.clock() + 2
end

function OutputCapture.start(getRealm: () -> string, onFlushNeeded: () -> ())
	if capturing then
		return
	end

	capturing = true
	realmProvider = getRealm
	flushListener = onFlushNeeded

	-- Before the listener, so the ordering in the buffer is the ordering Studio
	-- printed in.
	seedFromHistory()

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
	table.clear(seeded)
	seedGuardUntil = 0
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
