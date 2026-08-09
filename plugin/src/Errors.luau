--!nonstrict
--[[
	Structured failures.

	Every command handler raises through Errors.throw so the dispatcher can send
	a typed error back to the agent instead of a Luau traceback. The codes match
	packages/protocol/src/errors.ts.
]]

local Errors = {}

local MARKER = "__luucode_error"

export type WireError = {
	code: string,
	message: string,
	details: { [string]: any }?,
	hint: string?,
}

function Errors.new(code: string, message: string, details: { [string]: any }?, hint: string?): WireError
	return {
		[MARKER] = true,
		code = code,
		message = message,
		details = details,
		hint = hint,
	}
end

function Errors.throw(code: string, message: string, details: { [string]: any }?, hint: string?): never
	error(Errors.new(code, message, details, hint), 0)
end

function Errors.is(value: any): boolean
	return type(value) == "table" and value[MARKER] == true
end

--[[
	Normalises anything thrown inside a handler into a wire error. Raw Luau
	errors become INTERNAL so the agent still gets a usable message.
]]
function Errors.coerce(value: any): WireError
	if Errors.is(value) then
		return {
			code = value.code,
			message = value.message,
			details = value.details,
			hint = value.hint,
		}
	end

	return {
		code = "INTERNAL",
		message = tostring(value),
	}
end

--[[
	Roblox refuses a lot of writes for reasons the agent can act on: locked
	properties, security levels, and instances that cannot be parented. Those
	all arrive as plain strings, so classify them here rather than at the call
	site.
]]
function Errors.fromRobloxError(message: string, details: { [string]: any }?): WireError
	local lowered = string.lower(message)

	-- These three all mean the agent asked for something that does not exist or
	-- does not fit, which is a different fix from "Roblox will not allow this".
	local looksLikeBadInput = string.find(lowered, "is not a valid member", 1, true) ~= nil
		or string.find(lowered, "unable to cast", 1, true) ~= nil
		or string.find(lowered, "invalid argument", 1, true) ~= nil

	return Errors.new(looksLikeBadInput and "INVALID_PARAMS" or "NOT_ALLOWED_BY_ROBLOX", message, details)
end

return Errors
