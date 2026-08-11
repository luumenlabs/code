--!nonstrict
--[[
	Simulated network conditions, through NetworkSettings.

	A Studio playtest runs its client and server in one process on a link with no
	latency, which is the one link the finished game never has. Replication
	bugs — prediction that never reconciles, a remote fired before the instance
	it names has replicated, two clients disagreeing about who got there first —
	do not reproduce until there is a delay to reproduce them in.

	Every field is read back after the write. A build that does not have one is
	named in `unavailable` rather than reported as a zero the caller would read
	as "no latency".
]]

local Errors = require(script.Parent.Parent.Errors)
local RunState = require(script.Parent.Parent.RunState)

local NetworkOps = {}

local INBOUND_DELAY = "InboundNetworkMinDelayMs"
local OUTBOUND_DELAY = "OutboundNetworkMinDelayMs"
local INBOUND_JITTER = "InboundNetworkJitterMs"
local OUTBOUND_JITTER = "OutboundNetworkJitterMs"
local INBOUND_LOSS = "InboundNetworkLossPercent"
local OUTBOUND_LOSS = "OutboundNetworkLossPercent"

local FIELDS = {
	INBOUND_DELAY,
	OUTBOUND_DELAY,
	INBOUND_JITTER,
	OUTBOUND_JITTER,
	INBOUND_LOSS,
	OUTBOUND_LOSS,
}

-- Round trips, split evenly between the two directions. Loss is what Roblox
-- allows at most, which is half a percent.
local PRESETS = {
	great = { latency = 30, jitter = 0, loss = 0 },
	good = { latency = 100, jitter = 10, loss = 0 },
	poor = { latency = 300, jitter = 100, loss = 0.5 },
	reset = { latency = 0, jitter = 0, loss = 0 },
}

local function networkSettings(): any
	local ok, service = pcall(function()
		return settings():GetService("NetworkSettings")
	end)

	if not ok or service == nil then
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			"This Studio build does not expose NetworkSettings",
			{ reason = ok and "nil service" or tostring(service) },
			"Nothing else about the playtest is affected; the link is simply the local one."
		)
	end

	return service
end

--[[
	Reads all six, and reports the ones that are not there rather than filling
	them in. The summary numbers on top are what an agent reasons about: a round
	trip, and the worse of the two directions for the rest.
]]
local function read(service: any): any
	local fields = {}
	local unavailable = {}

	for _, name in ipairs(FIELDS) do
		local ok, value = pcall(function()
			return service[name]
		end)

		if ok and type(value) == "number" then
			fields[name] = value
		else
			table.insert(unavailable, name)
		end
	end

	local function at(name: string): number
		return fields[name] or 0
	end

	return {
		latencyMs = at(INBOUND_DELAY) + at(OUTBOUND_DELAY),
		jitterMs = math.max(at(INBOUND_JITTER), at(OUTBOUND_JITTER)),
		lossPercent = math.max(at(INBOUND_LOSS), at(OUTBOUND_LOSS)),
		fields = fields,
		unavailable = unavailable,
	}
end

--[[
	What the request asks for, as property values. A preset sets all six; a
	custom profile sets only the halves the caller named, so latency can be
	changed without disturbing jitter that was set earlier.
]]
local function desired(params: any): { [string]: number }
	local preset = PRESETS[params.profile]
	local values = {}

	if preset ~= nil then
		values[INBOUND_DELAY] = preset.latency / 2
		values[OUTBOUND_DELAY] = preset.latency / 2
		values[INBOUND_JITTER] = preset.jitter
		values[OUTBOUND_JITTER] = preset.jitter
		values[INBOUND_LOSS] = preset.loss
		values[OUTBOUND_LOSS] = preset.loss
		return values
	end

	if params.latencyMs ~= nil then
		values[INBOUND_DELAY] = params.latencyMs / 2
		values[OUTBOUND_DELAY] = params.latencyMs / 2
	end

	if params.jitterMs ~= nil then
		values[INBOUND_JITTER] = params.jitterMs
		values[OUTBOUND_JITTER] = params.jitterMs
	end

	if params.lossPercent ~= nil then
		values[INBOUND_LOSS] = params.lossPercent
		values[OUTBOUND_LOSS] = params.lossPercent
	end

	return values
end

function NetworkOps.apply(params: any): any
	local service = networkSettings()
	local before = read(service)
	local values = desired(params)

	for name, value in pairs(values) do
		-- A field this build does not have was already named in `before`, and
		-- writing it would raise about something the caller did not ask for.
		if before.fields[name] ~= nil then
			local ok, err = pcall(function()
				service[name] = value
			end)

			if not ok then
				error(
					Errors.fromRobloxError(
						string.format("Could not set %s to %s: %s", name, tostring(value), tostring(err)),
						{ field = name, value = value }
					),
					0
				)
			end
		end
	end

	return {
		profile = params.profile,
		realm = RunState.current().realm,
		before = before,
		after = read(service),
	}
end

function NetworkOps.isAvailable(): boolean
	local ok, service = pcall(function()
		return settings():GetService("NetworkSettings")
	end)

	if not ok or service == nil then
		return false
	end

	-- One of the six, read for its value: the service is present in every build
	-- and the simulation fields are not.
	local readable, value = pcall(function()
		return service[INBOUND_DELAY]
	end)

	return readable and type(value) == "number"
end

return NetworkOps
