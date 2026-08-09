--!nonstrict
--[[
	DataModel path parsing and resolution.

	Paths are resolved fresh on every call. That is what makes them safe to use
	while the user is editing Studio at the same time, and it is why an
	ambiguous path is a hard failure rather than a silent pick: editing the
	wrong "Button" is exactly the accident spec section 10.3 asks us to avoid.
]]

local Errors = require(script.Parent.Errors)

local Path = {}

--[[
	Splits a path into segments. Supports both dotted names and bracket quoting
	for names containing dots or spaces:

		Workspace.Spawn.Button
		Workspace["My Model"].Handle
]]
function Path.parse(path: string): { string }
	local segments = {}
	local index = 1
	local current = ""
	local length = #path

	local function pushCurrent()
		if #current > 0 then
			table.insert(segments, current)
			current = ""
		end
	end

	while index <= length do
		local char = string.sub(path, index, index)

		if char == "." then
			pushCurrent()
			index += 1
		elseif char == "[" then
			pushCurrent()
			local quote = string.sub(path, index + 1, index + 1)
			if quote ~= '"' and quote ~= "'" then
				Errors.throw("INVALID_PARAMS", string.format("Expected a quoted name after '[' in path %q", path))
			end
			local closing = string.find(path, quote .. "]", index + 2, true)
			if closing == nil then
				Errors.throw("INVALID_PARAMS", string.format("Unterminated bracket segment in path %q", path))
			end
			table.insert(segments, string.sub(path, index + 2, closing - 1))
			index = closing + 2
		else
			current ..= char
			index += 1
		end
	end

	pushCurrent()

	if segments[1] == "game" or segments[1] == "Game" then
		table.remove(segments, 1)
	end

	return segments
end

local function needsQuoting(segment: string): boolean
	return string.match(segment, "^[A-Za-z_][A-Za-z0-9_]*$") == nil
end

function Path.format(segments: { string }): string
	local result = "game"
	for _, segment in ipairs(segments) do
		if needsQuoting(segment) then
			result ..= string.format("[%q]", segment)
		else
			result ..= "." .. segment
		end
	end
	return result
end

--[[
	Builds the canonical path for an instance.

	Instance:GetFullName is close, but it does not quote awkward names and
	returns a bare name for instances outside the DataModel, so agents cannot
	feed the result back in as a target.
]]
function Path.of(instance: Instance): string
	if instance == game then
		return "game"
	end

	local segments = {}
	local current: Instance? = instance

	while current ~= nil and current ~= game do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end

	if current ~= game then
		-- Detached from the DataModel: mark it so a stale path is obvious.
		return "<detached>." .. instance.Name
	end

	return Path.format(segments)
end

local function findService(name: string): Instance?
	local existing = game:FindFirstChild(name)
	if existing ~= nil then
		return existing
	end

	-- GetService creates the service if it is valid but not yet instantiated.
	local ok, service = pcall(function()
		return game:GetService(name :: any)
	end)
	return ok and service or nil
end

--[[
	Walks a path from the DataModel root.

	`describe` is optional and is used to attach handles to ambiguity
	candidates, so the agent can pick one without another round trip.
]]
function Path.resolve(path: string, describe: ((Instance) -> any)?): Instance
	local segments = Path.parse(path)

	if #segments == 0 then
		return game
	end

	local current: Instance = game

	for depth, segment in ipairs(segments) do
		local matches = {}

		if depth == 1 then
			local service = findService(segment)
			if service ~= nil then
				matches = { service }
			end
		end

		if #matches == 0 then
			for _, child in ipairs(current:GetChildren()) do
				if child.Name == segment then
					table.insert(matches, child)
					if #matches > 8 then
						break
					end
				end
			end
		end

		if #matches == 0 then
			Errors.throw(
				"TARGET_NOT_FOUND",
				string.format("No child named %q under %s", segment, Path.of(current)),
				{ path = path, resolvedTo = Path.of(current), missingSegment = segment },
				"Inspect the parent to see what actually exists, or use a handle from an earlier inspection."
			)
		end

		if #matches > 1 then
			local candidates = {}
			for _, match in ipairs(matches) do
				table.insert(candidates, describe and describe(match) or Path.of(match))
			end
			Errors.throw(
				"TARGET_AMBIGUOUS",
				string.format("%d instances named %q exist under %s", #matches, segment, Path.of(current)),
				{ path = path, candidates = candidates },
				"Use one of the returned handles instead of the path."
			)
		end

		current = matches[1]
	end

	return current
end

return Path
