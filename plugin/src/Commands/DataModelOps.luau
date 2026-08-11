--!nonstrict
--[[
	DataModel inspection and editing. Spec sections 9 and 10.

	Inspection is deliberately scoped: every listing takes a limit and reports
	whether it truncated, so an agent can walk a large place without ever
	pulling the whole thing into a prompt.
]]

local CollectionService = game:GetService("CollectionService")
local Selection = game:GetService("Selection")

local Changes = require(script.Parent.Parent.Changes)
local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local History = require(script.Parent.Parent.History)
local Path = require(script.Parent.Parent.Path)
local Props = require(script.Parent.Parent.Props)
local Value = require(script.Parent.Parent.Value)

local DataModelOps = {}

local function encode(value: any): any
	return Value.encode(value, Handles.forInstance, Path.of)
end

local function decode(value: any): any
	return Value.decode(value, Handles.resolve)
end

local function attributesOf(instance: Instance): { [string]: any }
	local encoded = {}
	local ok, attributes = pcall(function()
		return instance:GetAttributes()
	end)

	if ok then
		for name, value in pairs(attributes) do
			encoded[name] = encode(value)
		end
	end

	return encoded
end

local function tagsOf(instance: Instance): { string }
	local ok, tags = pcall(function()
		return CollectionService:GetTags(instance)
	end)
	return ok and tags or {}
end

local function scriptSummary(instance: Instance): any?
	if not instance:IsA("LuaSourceContainer") then
		return nil
	end

	local ok, source = pcall(function()
		return (instance :: any).Source
	end)

	if not ok then
		return {
			className = instance.ClassName,
			lineCount = 0,
			byteCount = 0,
			disabled = false,
			runContext = nil,
		}
	end

	local _, newlines = string.gsub(source, "\n", "")
	local disabled = false
	pcall(function()
		disabled = (instance :: any).Disabled == true
	end)

	local runContext: string? = nil
	pcall(function()
		local context = (instance :: any).RunContext
		runContext = context and context.Name or nil
	end)

	return {
		className = instance.ClassName,
		lineCount = #source > 0 and newlines + 1 or 0,
		byteCount = #source,
		disabled = disabled,
		runContext = runContext,
	}
end

--[[
	Services are the entry point for almost every inspection, so this returns
	the ones that actually exist in the place rather than every service Roblox
	defines.
]]
function DataModelOps.services(): any
	local described = {}

	for _, child in ipairs(game:GetChildren()) do
		local ok, isService = pcall(function()
			-- Services are the direct children of the DataModel; anything else
			-- there is unusual and still worth reporting.
			return child
		end)

		if ok and isService ~= nil then
			table.insert(described, Handles.describe(child))
		end
	end

	table.sort(described, function(left, right)
		return left.name < right.name
	end)

	return { services = described }
end

function DataModelOps.get(params: any): any
	local instance = Handles.resolve(params.target)
	local names = params.properties or Props.defaultsFor(instance)
	local properties, unreadable = Props.read(instance, names, encode)

	local children = instance:GetChildren()
	local childLimit = params.childLimit or 50
	local listed = {}

	for index = 1, math.min(#children, childLimit) do
		table.insert(listed, Handles.describe(children[index]))
	end

	local summary = Handles.describe(instance)
	local parent = instance.Parent

	return {
		handle = summary.handle,
		path = summary.path,
		name = summary.name,
		className = summary.className,
		childCount = summary.childCount,
		parent = parent and Handles.describe(parent) or nil,
		properties = properties,
		unreadable = unreadable,
		attributes = attributesOf(instance),
		tags = tagsOf(instance),
		script = scriptSummary(instance),
		children = listed,
		childrenTruncated = #children > #listed,
	}
end

function DataModelOps.children(params: any): any
	local instance = Handles.resolve(params.target)
	local all = instance:GetChildren()
	local filtered = all

	if params.className ~= nil then
		filtered = {}
		for _, child in ipairs(all) do
			local ok, matches = pcall(function()
				return child:IsA(params.className)
			end)
			if ok and matches then
				table.insert(filtered, child)
			end
		end
	end

	local offset = params.offset or 0
	local limit = params.limit or 100
	local page = {}

	for index = offset + 1, math.min(#filtered, offset + limit) do
		table.insert(page, Handles.describe(filtered[index]))
	end

	return { children = page, total = #filtered, offset = offset }
end

function DataModelOps.tree(params: any): any
	local root = params.target and Handles.resolve(params.target) or game
	local maxDepth = params.maxDepth or 3
	local maxNodes = params.maxNodes or 300
	local nodeCount = 0
	local truncated = false

	local function build(instance: Instance, depth: number): any
		nodeCount += 1

		local node = Handles.describe(instance)
		node.children = {}
		node.truncated = false

		if depth >= maxDepth then
			node.truncated = instance:GetChildren()[1] ~= nil
			return node
		end

		for _, child in ipairs(instance:GetChildren()) do
			if nodeCount >= maxNodes then
				node.truncated = true
				truncated = true
				break
			end

			if params.className ~= nil then
				local ok, matches = pcall(function()
					return child:IsA(params.className)
				end)
				-- Non-matching branches are still traversed so a filtered tree
				-- can find matches nested under ordinary folders.
				if ok and matches then
					table.insert(node.children, build(child, depth + 1))
				else
					-- Discarding a branch has to give back everything it counted,
					-- not just its root, or nodeCount drifts and the maxNodes
					-- budget is spent on instances the agent never sees.
					local countBefore = nodeCount
					local subtree = build(child, depth + 1)
					if #subtree.children > 0 then
						table.insert(node.children, subtree)
					else
						nodeCount = countBefore
					end
				end
			else
				table.insert(node.children, build(child, depth + 1))
			end
		end

		return node
	end

	local tree = build(root, 0)
	return { root = tree, nodeCount = nodeCount, truncated = truncated }
end

function DataModelOps.search(params: any): any
	local scope = params.scope and Handles.resolve(params.scope) or game
	local limit = params.limit or 50
	local matchMode = params.matchMode or "substring"
	local matches = {}
	local truncated = false

	local function nameMatches(name: string): boolean
		if params.name == nil then
			return true
		end
		if matchMode == "exact" then
			return name == params.name
		elseif matchMode == "pattern" then
			local ok, found = pcall(string.match, name, params.name)
			return ok and found ~= nil
		end
		return string.find(string.lower(name), string.lower(params.name), 1, true) ~= nil
	end

	local candidates: { Instance }

	if params.tag ~= nil then
		-- Tag lookup is indexed by Roblox, so start there and filter down.
		local ok, tagged = pcall(function()
			return CollectionService:GetTagged(params.tag)
		end)
		candidates = ok and tagged or {}
	else
		candidates = scope:GetDescendants()
	end

	for _, instance in ipairs(candidates) do
		if #matches >= limit then
			truncated = true
			break
		end

		local include = nameMatches(instance.Name)

		if include and params.className ~= nil then
			local ok, isA = pcall(function()
				return instance:IsA(params.className)
			end)
			include = ok and isA
		end

		if include and params.tag ~= nil and scope ~= game then
			include = instance:IsDescendantOf(scope)
		end

		if include then
			table.insert(matches, Handles.describe(instance))
		end
	end

	return { matches = matches, truncated = truncated }
end

function DataModelOps.properties(params: any): any
	local instance = Handles.resolve(params.target)
	local names = params.names or Props.defaultsFor(instance)
	local values, unreadable = Props.read(instance, names, encode)

	return {
		instance = Handles.describe(instance),
		properties = values,
		unreadable = unreadable,
	}
end

function DataModelOps.selectionGet(): any
	local ok, selected = pcall(function()
		return Selection:Get()
	end)

	if not ok then
		Errors.throw("UNSUPPORTED_CAPABILITY", "Selection is unavailable in this Studio context")
	end

	return { selection = Handles.describeMany(selected) }
end

function DataModelOps.selectionSet(params: any): any
	local instances = {}
	for _, target in ipairs(params.targets) do
		table.insert(instances, Handles.resolve(target))
	end

	local ok, err = pcall(function()
		Selection:Set(instances)
	end)

	if not ok then
		error(Errors.fromRobloxError(tostring(err)), 0)
	end

	return { selection = Handles.describeMany(instances) }
end

function DataModelOps.setProperties(params: any): any
	local instance = Handles.resolve(params.target)
	local applied = {}
	local rejected = {}

	-- Read every name the caller asked for, before any of them are written. A
	-- write ordered after another on the same instance can change what the
	-- earlier one would have read back, so "before" has to mean before the whole
	-- operation, not before each assignment.
	local requested = {}
	for name in pairs(params.properties) do
		table.insert(requested, name)
	end

	local before, unreadable = Changes.readValues(instance, requested)

	local _, undoLabel = History.record(string.format("Set properties on %s", instance.Name), function()
		for name, raw in pairs(params.properties) do
			local decodedOk, decoded = pcall(decode, raw)

			if not decodedOk then
				rejected[name] = Errors.coerce(decoded).message
			else
				local ok, err = pcall(function()
					(instance :: any)[name] = decoded
				end)

				if ok then
					table.insert(applied, name)
				else
					rejected[name] = tostring(err)
				end
			end
		end
	end)

	-- A write that rejected every property is a failure, not a partial success:
	-- reporting it as ok would let an agent believe an edit landed.
	if #applied == 0 and next(rejected) ~= nil then
		Errors.throw("NOT_ALLOWED_BY_ROBLOX", string.format("No properties could be set on %s", Path.of(instance)), { rejected = rejected })
	end

	local record = Changes.properties(instance, before, unreadable, applied)

	return {
		instances = { Handles.describe(instance) },
		undoLabel = undoLabel,
		applied = applied,
		rejected = rejected,
		changes = record and { record } or {},
	}
end

function DataModelOps.create(params: any): any
	local parent = Handles.resolve(params.parent)

	local created, undoLabel = History.record(string.format("Create %s", params.className), function()
		local ok, instance = pcall(function()
			return Instance.new(params.className)
		end)

		if not ok then
			Errors.throw(
				"INVALID_PARAMS",
				string.format("%q is not a creatable class", tostring(params.className)),
				{ className = params.className },
				"Check the class name against the Roblox API, or create a Folder and populate it instead."
			)
		end

		if params.name ~= nil then
			instance.Name = params.name
		end

		for name, raw in pairs(params.properties or {}) do
			local applyOk, err = pcall(function()
				(instance :: any)[name] = decode(raw)
			end)
			if not applyOk then
				instance:Destroy()
				error(Errors.fromRobloxError(string.format("Could not set %s: %s", name, tostring(err))), 0)
			end
		end

		for name, raw in pairs(params.attributes or {}) do
			instance:SetAttribute(name, decode(raw))
		end

		for _, tag in ipairs(params.tags or {}) do
			CollectionService:AddTag(instance, tag)
		end

		local parentOk, err = pcall(function()
			instance.Parent = parent
		end)

		if not parentOk then
			instance:Destroy()
			error(Errors.fromRobloxError(string.format("Could not parent to %s: %s", Path.of(parent), tostring(err))), 0)
		end

		return instance
	end)

	return { instances = { Handles.describe(created) }, undoLabel = undoLabel, changes = { Changes.create(created) } }
end

function DataModelOps.delete(params: any): any
	local instances = {}
	for _, target in ipairs(params.targets) do
		table.insert(instances, Handles.resolve(target))
	end

	-- Describe before destroying: afterwards the paths are gone.
	local described = Handles.describeMany(instances)

	-- And take the copies before too, for the same reason. One record per
	-- instance rather than one for the batch: the user deleting five things and
	-- wanting four of them back is the ordinary case, not an exotic one.
	local records = {}
	for _, instance in ipairs(instances) do
		table.insert(records, Changes.delete(instance))
	end

	local ok, undoLabel = pcall(function()
		local _, label = History.record(string.format("Delete %d instance(s)", #instances), function()
			for _, instance in ipairs(instances) do
				local destroyed, err = pcall(function()
					instance:Destroy()
				end)
				if not destroyed then
					error(Errors.fromRobloxError(tostring(err)), 0)
				end
			end
		end)
		return label
	end)

	if not ok then
		-- The delete was rolled back, so the copies are of instances that are
		-- still there. Holding them would spend the session's budget for
		-- restorable deletes on deletes that never happened.
		Changes.discard(records)
		error(undoLabel, 0)
	end

	return { instances = described, undoLabel = undoLabel, deleted = #instances, changes = records }
end

function DataModelOps.rename(params: any): any
	local instance = Handles.resolve(params.target)
	local previous = instance.Name

	local _, undoLabel = History.record(string.format("Rename %s", instance.Name), function()
		local ok, err = pcall(function()
			instance.Name = params.name
		end)
		if not ok then
			error(Errors.fromRobloxError(tostring(err)), 0)
		end
	end)

	local record = Changes.rename(instance, previous)

	return {
		instances = { Handles.describe(instance) },
		undoLabel = undoLabel,
		changes = record and { record } or {},
	}
end

function DataModelOps.reparent(params: any): any
	local instance = Handles.resolve(params.target)
	local parent = Handles.resolve(params.parent)

	if parent == instance or parent:IsDescendantOf(instance) then
		Errors.throw(
			"INVALID_PARAMS",
			"An instance cannot be parented to itself or to one of its descendants",
			{ target = Path.of(instance), parent = Path.of(parent) }
		)
	end

	local previousParent = instance.Parent
	local previousPath = previousParent and Path.of(previousParent) or nil

	local _, undoLabel = History.record(string.format("Move %s", instance.Name), function()
		local ok, err = pcall(function()
			instance.Parent = parent
		end)
		if not ok then
			error(Errors.fromRobloxError(tostring(err)), 0)
		end
	end)

	local record = previousPath and Changes.reparent(instance, previousPath) or nil

	return {
		instances = { Handles.describe(instance) },
		undoLabel = undoLabel,
		changes = record and { record } or {},
	}
end

function DataModelOps.clone(params: any): any
	local instance = Handles.resolve(params.target)
	local parent = params.parent and Handles.resolve(params.parent) or instance.Parent

	if parent == nil then
		Errors.throw("INVALID_PARAMS", "The source has no parent, so a destination parent is required")
	end

	local copy, undoLabel = History.record(string.format("Clone %s", instance.Name), function()
		if not instance.Archivable then
			Errors.throw(
				"NOT_ALLOWED_BY_ROBLOX",
				string.format("%s has Archivable disabled and cannot be cloned", Path.of(instance)),
				nil,
				"Set Archivable to true first if the copy is intended."
			)
		end

		local cloned = instance:Clone()
		if params.name ~= nil then
			cloned.Name = params.name
		end
		cloned.Parent = parent
		return cloned
	end)

	return { instances = { Handles.describe(copy) }, undoLabel = undoLabel, changes = { Changes.create(copy) } }
end

function DataModelOps.setAttributes(params: any): any
	local instance = Handles.resolve(params.target)
	local applied = {}

	local requested = {}
	for name in pairs(params.attributes) do
		table.insert(requested, name)
	end

	local before = Changes.readAttributes(instance, requested)

	local _, undoLabel = History.record(string.format("Set attributes on %s", instance.Name), function()
		for name, raw in pairs(params.attributes) do
			-- Removal arrives as the Nil tag rather than JSON null: Roblox's
			-- JSON decoder drops null-valued keys entirely, so a plain null
			-- would never reach this loop. The server rewrites nulls on the
			-- way in.
			local ok, err = pcall(function()
				instance:SetAttribute(name, decode(raw))
			end)

			if not ok then
				error(Errors.fromRobloxError(string.format("Could not set attribute %s: %s", name, tostring(err))), 0)
			end

			table.insert(applied, name)
		end
	end)

	local record = Changes.attributes(instance, before, applied)

	return {
		instances = { Handles.describe(instance) },
		undoLabel = undoLabel,
		applied = applied,
		changes = record and { record } or {},
	}
end

function DataModelOps.setTags(params: any): any
	local instance = Handles.resolve(params.target)

	-- Only tags the call actually moved. Adding a tag the instance already
	-- carried changed nothing, and offering to remove it on revert would take
	-- away something the agent never put there.
	local existing = {}
	for _, tag in ipairs(tagsOf(instance)) do
		existing[tag] = true
	end

	local added = {}
	local removed = {}

	local _, undoLabel = History.record(string.format("Set tags on %s", instance.Name), function()
		for _, tag in ipairs(params.add or {}) do
			CollectionService:AddTag(instance, tag)
			if not existing[tag] then
				table.insert(added, tag)
			end
		end
		for _, tag in ipairs(params.remove or {}) do
			CollectionService:RemoveTag(instance, tag)
			if existing[tag] then
				table.insert(removed, tag)
			end
		end
	end)

	local record = Changes.tags(instance, added, removed)

	return {
		instances = { Handles.describe(instance) },
		undoLabel = undoLabel,
		tags = tagsOf(instance),
		changes = record and { record } or {},
	}
end

return DataModelOps
