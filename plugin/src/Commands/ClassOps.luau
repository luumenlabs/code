--!nonstrict
--[[
	What a class actually has, asked of the engine rather than of a table.

	Roblox exposes no property reflection to Luau, so this creates one instance
	of the class and probes it: reading each member to find out whether it
	exists and what type it holds, and writing the value it just read back to
	find out whether a write is accepted at all. Nothing is asserted that was
	not observed.

	The probe is the point. An agent that guesses `Collidable` and writes it
	loses a round trip to a rejection; the same guess passed here comes back
	named as unknown, next to `CanCollide`.
]]

local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local Path = require(script.Parent.Parent.Path)
local Props = require(script.Parent.Parent.Props)
local Value = require(script.Parent.Parent.Value)

local ClassOps = {}

local function encode(value: any): any
	return Value.encode(value, Handles.forInstance, Path.of)
end

--[[
	Base classes worth reporting, most general first. Ancestry is established by
	asking IsA rather than by holding a class tree, so this list only decides how
	much of the answer is interesting — a class it does not mention is still
	described, just without that rung named.
]]
local BASE_CLASSES = {
	"Instance",
	"PVInstance",
	"BasePart",
	"FormFactorPart",
	"Part",
	"TriangleMeshPart",
	"MeshPart",
	"Model",
	"Folder",
	"Attachment",
	"Constraint",
	"JointInstance",
	"LuaSourceContainer",
	"BaseScript",
	"Script",
	"ModuleScript",
	"GuiBase",
	"GuiBase2d",
	"LayerCollector",
	"GuiObject",
	"GuiButton",
	"GuiLabel",
	"TextLabel",
	"ImageLabel",
	"UIBase",
	"UIComponent",
	"UIConstraint",
	"UILayout",
	"ValueBase",
	"Lighting",
	"Light",
	"PostEffect",
	"Humanoid",
	"Player",
	"Players",
	"Camera",
	"Sound",
	"SoundEffect",
	"Tool",
	"BackpackItem",
	"Team",
	"Decal",
	"Texture",
	"ParticleEmitter",
	"Beam",
	"Trail",
	"Animation",
	"AnimationTrack",
	"Service",
	"ServiceProvider",
	"DataModel",
}

--[[
	Members every instance has, so a class with no curated set still comes back
	with something usable. Methods and events are here rather than inferred:
	there is nothing to enumerate them from, and the kind is decided by what the
	read hands back.
]]
local UNIVERSAL = {
	"Name",
	"Parent",
	"ClassName",
	"Archivable",
	"Destroy",
	"Clone",
	"IsA",
	"FindFirstChild",
	"WaitForChild",
	"GetChildren",
	"GetDescendants",
	"GetAttribute",
	"SetAttribute",
	"GetAttributes",
	"Changed",
	"AncestryChanged",
	"ChildAdded",
	"Destroying",
}

--[[
	Edit distance, capped: past a couple of edits the words are simply different
	and a suggestion would be noise rather than help.
]]
local function distance(left: string, right: string): number
	-- One wider than the word, and one-based, so the row holds the empty-prefix
	-- column that the algorithm needs at the front.
	local width = #right + 1
	local previous = table.create(width)

	for index = 1, width do
		previous[index] = index - 1
	end

	for i = 1, #left do
		local current = table.create(width)
		current[1] = i

		for j = 1, #right do
			local substitution = previous[j] + (string.sub(left, i, i) == string.sub(right, j, j) and 0 or 1)
			current[j + 1] = math.min(previous[j + 1] + 1, current[j] + 1, substitution)
		end

		previous = current
	end

	return previous[width]
end

local function nearest(name: string, candidates: { string }): string?
	local lowered = string.lower(name)
	local best: string? = nil
	local bestScore = math.huge
	-- A third of the word, so short names need an near-exact match and long ones
	-- can absorb a typo or two.
	local ceiling = math.max(2, math.floor(#name / 3))

	for _, candidate in ipairs(candidates) do
		local folded = string.lower(candidate)
		local score

		-- A name that is contained in a real one is a dropped prefix or suffix —
		-- Collide for CanCollide, Text for PlaceholderText — which edit distance
		-- scores as badly as an unrelated word.
		if #lowered >= 3 and string.find(folded, lowered, 1, true) ~= nil then
			score = 1
		else
			score = distance(lowered, folded)
			if score > ceiling then
				continue
			end
		end

		if score < bestScore or (score == bestScore and best ~= nil and #candidate < #best) then
			best = candidate
			bestScore = score
		end
	end

	return best
end

local function looksMissing(message: string): boolean
	return string.find(string.lower(message), "is not a valid member", 1, true) ~= nil
end

--[[
	Resolves what to probe.

	Creating an instance is the only way to get a writable subject, so that is
	tried first. A service is described from the user's live one and never
	written to; a class that is neither is described from the instance the caller
	pointed at, if they pointed at one.
]]
local function subjectFor(params: any): (Instance, string, boolean, boolean)
	local className = params.className
	local pointed: Instance? = nil

	if params.target ~= nil then
		local resolved = Handles.resolve(params.target)
		pointed = resolved
		className = className or resolved.ClassName
	end

	local created, temp = pcall(Instance.new, className)
	if created then
		return temp, className, true, false
	end

	-- FindService, not GetService: GetService inserts a service the place does
	-- not have, and describing a class is a read. A service that is genuinely
	-- absent is reported as absent rather than quietly added to the user's place.
	local found, service = pcall(function()
		return game:FindService(className)
	end)
	if found and typeof(service) == "Instance" then
		return service :: Instance, className, false, true
	end

	if pointed == nil then
		Errors.throw(
			"TARGET_NOT_FOUND",
			string.format("Roblox does not recognise a class called %q, and this place has no service by that name", tostring(className)),
			{ className = className, reason = tostring(temp) },
			"Class names are case sensitive and singular, for example ProximityPrompt or SurfaceGui. Pass a target instead to describe the class of an instance you already have."
		)
	end

	return pointed :: Instance, className, false, false
end

function ClassOps.info(params: any): any
	local subject, className, creatable, isService = subjectFor(params)

	local ancestry = {}
	for _, base in ipairs(BASE_CLASSES) do
		local ok, matches = pcall(function()
			return subject:IsA(base)
		end)
		if ok and matches and base ~= className then
			table.insert(ancestry, base)
		end
	end

	-- Curated first, then universal, then whatever the caller asked about, so
	-- the order an agent reads is general to specific to its own question.
	local names = {}
	local seen = {}

	local function want(name: string)
		if not seen[name] then
			seen[name] = true
			table.insert(names, name)
		end
	end

	for _, name in ipairs(Props.defaultsFor(subject)) do
		want(name)
	end
	for _, name in ipairs(UNIVERSAL) do
		want(name)
	end

	local asked = {}
	for _, name in ipairs(params.members or {}) do
		asked[name] = true
		want(name)
	end

	local members = {}
	local unknown = {}
	local present = {}

	for _, name in ipairs(names) do
		local ok, value = pcall(function()
			return (subject :: any)[name]
		end)

		if not ok then
			local message = tostring(value)

			-- Only what the caller asked about earns a line in unknown: the
			-- curated set spans classes, and a property this one happens not to
			-- have is not a mistake anybody made.
			if looksMissing(message) then
				if asked[name] then
					table.insert(unknown, { name = name, nearest = Value.NIL })
				end
			else
				table.insert(members, {
					name = name,
					kind = "property",
					valueType = Value.NIL,
					value = Value.NIL,
					writable = Value.NIL,
					reason = message,
				})
				table.insert(present, name)
			end
		else
			local kind = typeof(value)
			table.insert(present, name)

			if kind == "function" then
				table.insert(members, {
					name = name,
					kind = "method",
					valueType = Value.NIL,
					value = Value.NIL,
					writable = Value.NIL,
					reason = Value.NIL,
				})
			elseif kind == "RBXScriptSignal" then
				table.insert(members, {
					name = name,
					kind = "event",
					valueType = Value.NIL,
					value = Value.NIL,
					writable = Value.NIL,
					reason = Value.NIL,
				})
			else
				local writable: any = Value.NIL
				local reason: any = Value.NIL

				-- Writing the value back to itself changes nothing and is only
				-- ever done to a throwaway instance. A service belongs to the
				-- user's session, so its members are reported without a verdict
				-- rather than probed.
				if creatable then
					local accepted, err = pcall(function()
						(subject :: any)[name] = value
					end)

					writable = accepted
					if not accepted then
						reason = tostring(err)
					end
				end

				table.insert(members, {
					name = name,
					kind = "property",
					valueType = kind,
					value = encode(value),
					writable = writable,
					reason = reason,
				})
			end
		end
	end

	for _, entry in ipairs(unknown) do
		entry.nearest = nearest(entry.name, present) or Value.NIL
	end

	if creatable then
		subject:Destroy()
	end

	return {
		className = className,
		creatable = creatable,
		isService = isService,
		ancestry = ancestry,
		members = members,
		unknown = unknown,
	}
end

return ClassOps
