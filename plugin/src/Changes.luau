--!nonstrict
--[[
	The change journal, Studio side.

	Every mutating command builds a draft here describing what it did: the
	instance, and the values on both sides of the write. The server keeps the
	drafts; this module keeps only the one thing that cannot be written down in
	JSON — a copy of a subtree that was destroyed, so a delete can be taken back.

	Two rules shape the whole thing.

	The "after" side is recorded as carefully as the "before" side. Nothing here
	can stop the user editing the same instance a second later, and a revert that
	assumed otherwise would quietly throw their work away. So a revert compares
	what is in the place now against what the change left behind, and refuses
	anything that has moved on since. That refusal is the feature.

	And a change is only ever reported as revertible when it genuinely is. A
	property Roblox would not read, an instance with Archivable off, a script too
	large to keep a copy of — each one is recorded with the reason, and the panel
	says so rather than offering a button that fails.
]]

local CollectionService = game:GetService("CollectionService")

local Errors = require(script.Parent.Errors)
local Handles = require(script.Parent.Handles)
local History = require(script.Parent.History)
local Path = require(script.Parent.Path)
local Props = require(script.Parent.Props)
local ScriptSource = require(script.Parent.ScriptSource)
local Value = require(script.Parent.Value)

local Changes = {}

--[[
	Copies of destroyed subtrees, held so a delete can be undone.

	Bounded on the way in rather than evicted later: a record that says it can be
	put back has to stay true. Dropping a copy afterwards to save memory would
	turn a button the user is looking at into a lie.
]]
local stowed: { [string]: { copy: Instance, descendants: number } } = {}
local stowedCount = 0
local nextStowId = 0

local MAX_STOWED = 200
local MAX_STOW_DESCENDANTS = 5000
-- A megabyte of Luau is not a script anyone is reviewing a diff of, and two
-- copies of it travel over the wire for every edit.
local MAX_SOURCE_BYTES = 512 * 1024

-- What a create or delete puts in the diff. The subtree is walked in full up to
-- these, and says how much it left out — a review that silently showed the
-- first ten children of forty would be worse than one that showed none.
local MAX_SNAPSHOT_NODES = 120
local MAX_SNAPSHOT_DEPTH = 6
local MAX_SNAPSHOT_SOURCE_BYTES = 256 * 1024

local function encode(value: any): any
	return Value.encode(value, Handles.forInstance, Path.of)
end

local function decode(value: any): any
	return Value.decode(value, Handles.resolve)
end

--[[
	A string field, or nil.

	Records make the round trip through the server, which rewrites JSON nulls as
	the Nil tag on the way back in — so an absent string arrives as a table, and
	a bare truthiness test on it would pass. Everything read out of an incoming
	record goes through here.
]]
local function text(value: any): string?
	if type(value) == "string" then
		return value
	end
	return nil
end

--[[
	An encoded value, defaulting to Nil when the read produced nothing.

	Written out rather than `value or Value.NIL`, because `false` is a perfectly
	good property value and Luau's `or` cannot tell it from absent.
]]
local function encoded(value: any): any
	if value == nil then
		return Value.NIL
	end
	return value
end

local function list(value: any): { any }
	if type(value) == "table" then
		return value
	end
	return {}
end

--[[
	Source with carriage returns removed, for comparison only.

	Never written back: what goes into the script is what was recorded. This is
	just so a CRLF source and the LF the script editor hands back are not read as
	the user having edited the file.
]]
local function bare(source: string): string
	local stripped = string.gsub(source, "\r", "")
	return stripped
end

local function descendantCount(instance: Instance): number
	local ok, descendants = pcall(function()
		return instance:GetDescendants()
	end)
	return ok and #descendants or 0
end

-- ---------------------------------------------------------------------------
-- Capture
-- ---------------------------------------------------------------------------

--[[
	Reads the current values of named properties, keeping the ones Roblox
	refused separately. Callers take this before a write and hand it back after.
]]
function Changes.readValues(instance: Instance, names: { string }): ({ [string]: any }, { [string]: string })
	local values = {}
	local unreadable = {}

	for _, name in ipairs(names) do
		local ok, value = pcall(function()
			return (instance :: any)[name]
		end)

		if ok then
			local kind = typeof(value)
			if kind == "function" or kind == "RBXScriptSignal" then
				unreadable[name] = "Not a property"
			else
				values[name] = encode(value)
			end
		else
			unreadable[name] = tostring(value)
		end
	end

	return values, unreadable
end

function Changes.readAttributes(instance: Instance, names: { string }): { [string]: any }
	local values = {}

	for _, name in ipairs(names) do
		local ok, value = pcall(function()
			return instance:GetAttribute(name)
		end)

		-- An attribute that does not exist reads as nil, which encodes to the
		-- Nil tag — and putting it back means removing it again. That is the
		-- same operation, so absence needs no separate case.
		if ok then
			values[name] = encode(value)
		else
			values[name] = Value.NIL
		end
	end

	return values
end

--[[
	The whole of an instance, for a change that has only one side.

	Walked breadth-of-tree in order with a shared node budget, so a wide subtree
	spends it on the first children rather than on the deepest branch, and every
	level reports what it left out. The source budget is shared too: one enormous
	script inside a folder should not push out the twenty small ones next to it.
]]
local function snapshot(instance: Instance, budget: { nodes: number, sourceBytes: number }, depth: number): any
	local names = Props.defaultsFor(instance)
	local properties = Changes.readValues(instance, names)

	local attributes = {}
	local ok, all = pcall(function()
		return instance:GetAttributes()
	end)
	if ok then
		for name, value in pairs(all) do
			attributes[name] = encode(value)
		end
	end

	local tags = {}
	local tagsOk, found = pcall(function()
		return CollectionService:GetTags(instance)
	end)
	if tagsOk then
		tags = found
	end

	local node = {
		name = instance.Name,
		className = instance.ClassName,
		properties = properties,
		attributes = attributes,
		tags = tags,
		source = nil,
		children = {},
		omitted = 0,
	}

	if instance:IsA("LuaSourceContainer") then
		local source = ScriptSource.tryRead(instance)
		if source ~= nil then
			if #source > budget.sourceBytes then
				node.sourceOmitted = true
			else
				node.source = source
				budget.sourceBytes -= #source
			end
		end
	end

	local children = instance:GetChildren()

	if depth >= MAX_SNAPSHOT_DEPTH then
		node.omitted = #children
		return node
	end

	for _, child in ipairs(children) do
		if budget.nodes <= 0 then
			node.omitted += 1
		else
			budget.nodes -= 1
			table.insert(node.children, snapshot(child, budget, depth + 1))
		end
	end

	return node
end

local function draft(kind: string, instance: Instance, summary: string): any
	local parent = instance.Parent

	return {
		kind = kind,
		target = Handles.describe(instance),
		parentPath = parent and Path.of(parent) or nil,
		summary = summary,
		revertable = true,
		reason = nil,
	}
end

local function formatList(names: { string }): string
	if #names == 0 then
		return "nothing"
	end
	if #names <= 3 then
		return table.concat(names, ", ")
	end
	return string.format("%s and %d more", table.concat({ names[1], names[2], names[3] }, ", "), #names - 3)
end

--[[
	A property write. `before` and `unreadable` come from readValues taken
	before the write; `applied` names the ones that actually landed.
]]
function Changes.properties(instance: Instance, before: any, unreadable: any, applied: { string }): any?
	if #applied == 0 then
		return nil
	end

	local after = Changes.readValues(instance, applied)
	local entries = {}
	local blind = {}

	for _, name in ipairs(applied) do
		local entry = { name = name, after = encoded(after[name]) }

		if unreadable[name] ~= nil then
			entry.unreadable = unreadable[name]
			table.insert(blind, name)
		else
			entry.before = before[name]
		end

		table.insert(entries, entry)
	end

	local record = draft("properties", instance, string.format("Set %s", formatList(applied)))
	record.properties = entries

	if #blind > 0 then
		record.revertable = false
		record.reason = string.format("Roblox would not read the previous value of %s", formatList(blind))
	end

	return record
end

function Changes.attributes(instance: Instance, before: any, names: { string }): any?
	if #names == 0 then
		return nil
	end

	local after = Changes.readAttributes(instance, names)
	local entries = {}

	for _, name in ipairs(names) do
		table.insert(entries, { name = name, before = before[name], after = after[name] })
	end

	local record = draft("attributes", instance, string.format("Set attribute %s", formatList(names)))
	record.attributes = entries
	return record
end

function Changes.tags(instance: Instance, added: { string }, removed: { string }): any?
	if #added == 0 and #removed == 0 then
		return nil
	end

	local parts = {}
	if #added > 0 then
		table.insert(parts, string.format("Added tag %s", formatList(added)))
	end
	if #removed > 0 then
		table.insert(parts, string.format("Removed tag %s", formatList(removed)))
	end

	local record = draft("tags", instance, table.concat(parts, "; "))
	record.tags = { added = added, removed = removed }
	return record
end

function Changes.rename(instance: Instance, previous: string): any?
	if previous == instance.Name then
		return nil
	end

	local record = draft("rename", instance, string.format("Renamed %s to %s", previous, instance.Name))
	record.renamed = { before = previous, after = instance.Name }
	return record
end

function Changes.reparent(instance: Instance, previousParentPath: string): any?
	local parent = instance.Parent
	local current = parent and Path.of(parent) or nil

	if current == nil or current == previousParentPath then
		return nil
	end

	local record = draft("reparent", instance, string.format("Moved out of %s", previousParentPath))
	record.moved = { before = previousParentPath, after = current }
	return record
end

--[[
	An instance that now exists and did not before. Reverting one destroys it,
	so there is nothing to hold on to.
]]
function Changes.create(instance: Instance): any
	local record = draft("create", instance, string.format("Created %s %s", instance.ClassName, instance.Name))
	record.subtree = { className = instance.ClassName, descendants = descendantCount(instance) }
	record.snapshot = snapshot(instance, { nodes = MAX_SNAPSHOT_NODES, sourceBytes = MAX_SNAPSHOT_SOURCE_BYTES }, 0)
	return record
end

--[[
	An instance about to be destroyed. Must be called before Destroy: the path,
	the parent, and the copy all stop being available the moment it runs.

	The copy is checked rather than trusted. Clone silently drops descendants
	with Archivable off, so a subtree that comes back smaller than it went in is
	not a restore — it is data loss wearing a success message.
]]
function Changes.delete(instance: Instance): any
	local descendants = descendantCount(instance)
	local record = draft("delete", instance, string.format("Deleted %s %s", instance.ClassName, instance.Name))
	record.subtree = { className = instance.ClassName, descendants = descendants }
	-- Taken before the destroy, like everything else here. Whether the copy for
	-- the restore succeeds or not, the user is entitled to see what was in it.
	record.snapshot = snapshot(instance, { nodes = MAX_SNAPSHOT_NODES, sourceBytes = MAX_SNAPSHOT_SOURCE_BYTES }, 0)

	local function refuse(reason: string): any
		record.revertable = false
		record.reason = reason
		return record
	end

	if not instance.Archivable then
		return refuse("Archivable is off on this instance, so Studio cannot make the copy a restore would need.")
	end

	if descendants > MAX_STOW_DESCENDANTS then
		return refuse(string.format("The subtree has %d descendants, more than Luu Code holds a copy of.", descendants))
	end

	if stowedCount >= MAX_STOWED then
		return refuse(string.format("Luu Code is already holding %d deleted instances in this session.", MAX_STOWED))
	end

	local ok, copy = pcall(function()
		return instance:Clone()
	end)

	if not ok or copy == nil then
		return refuse("Studio refused to copy this instance, so the delete cannot be taken back.")
	end

	local copied = descendantCount(copy)
	if copied ~= descendants then
		copy:Destroy()
		return refuse(
			string.format(
				"The copy came back with %d of %d descendants, so restoring it would lose the rest. Archivable is off somewhere inside.",
				copied,
				descendants
			)
		)
	end

	nextStowId += 1
	local id = string.format("s%d", nextStowId)
	stowed[id] = { copy = copy, descendants = descendants }
	stowedCount += 1
	record.stow = id

	return record
end

--[[
	A script edit. `before` is nil when the source could not be read, which is
	recorded rather than guessed at — writing an empty string back over a script
	we never saw is the worst possible revert.
]]
function Changes.source(instance: Instance, before: string?, reason: string?, after: string): any
	local record = draft("source", instance, string.format("Changed the source of %s", instance.Name))

	record.source = {
		before = before,
		after = after,
		beforeLines = before and ScriptSource.countLines(before) or 0,
		afterLines = ScriptSource.countLines(after),
	}

	if before == nil then
		record.revertable = false
		record.reason = reason or "The previous source could not be read."
	elseif #before > MAX_SOURCE_BYTES then
		record.source.before = nil
		record.revertable = false
		record.reason = string.format("The script was %d KB before the edit, too large to keep a copy of.", #before // 1024)
	end

	return record
end

-- ---------------------------------------------------------------------------
-- Revert
-- ---------------------------------------------------------------------------

local function outcome(id: string, status: string, reason: string?, current: string?): any
	return { id = id, status = status, reason = reason, current = current }
end

--[[
	Finds the instance a record is about.

	The handle first, because it survives a rename and a move — which are
	precisely the things the user is likely to have done in between. The path is
	the fallback for a handle invalidated by an edit/run transition.
]]
local function locate(record: any): (Instance?, string?)
	local handle = text(record.target and record.target.handle)
	if handle ~= nil then
		local ok, instance = pcall(Handles.resolveHandle, handle)
		if ok then
			return instance, nil
		end
	end

	local path = text(record.target and record.target.path)
	if path == nil then
		return nil, "The record does not say which instance it was about."
	end

	local ok, instance = pcall(Path.resolve, path, Handles.describe)
	if ok then
		return instance, nil
	end

	return nil, string.format("%s is no longer in the DataModel.", path)
end

--[[
	Compares an encoded value against a live one.

	JSON round-tripping through the server means both sides are already the
	rounded, tagged form, so encoding the live value again puts them in the same
	shape. A deep compare of that is exactly "has this moved since".
]]
local function sameValue(left: any, right: any): boolean
	if type(left) ~= "table" or type(right) ~= "table" then
		return left == right
	end

	for key, value in pairs(left) do
		if not sameValue(value, right[key]) then
			return false
		end
	end

	for key in pairs(right) do
		if left[key] == nil then
			return false
		end
	end

	return true
end

local function revertProperties(instance: Instance, record: any, force: boolean): any
	local entries = list(record.properties)
	local live = {}

	for _, entry in ipairs(entries) do
		table.insert(live, entry.name)
	end

	local current = Changes.readValues(instance, live)

	if not force then
		for _, entry in ipairs(entries) do
			if not sameValue(entry.after, encoded(current[entry.name])) then
				return outcome(
					record.id,
					"conflict",
					string.format("%s has been changed since, so putting it back would overwrite that.", entry.name),
					string.format("%s is now a different value", entry.name)
				)
			end
		end
	end

	for _, entry in ipairs(entries) do
		local decoded
		local decodeOk, decodeErr = pcall(function()
			decoded = decode(entry.before)
		end)

		if not decodeOk then
			return outcome(record.id, "failed", string.format("%s: %s", entry.name, Errors.coerce(decodeErr).message))
		end

		local ok, err = pcall(function()
			(instance :: any)[entry.name] = decoded
		end)

		if not ok then
			return outcome(record.id, "failed", string.format("Roblox refused to set %s back: %s", entry.name, tostring(err)))
		end
	end

	return outcome(record.id, "reverted", nil)
end

local function revertAttributes(instance: Instance, record: any, force: boolean): any
	local entries = list(record.attributes)

	if not force then
		for _, entry in ipairs(entries) do
			local ok, value = pcall(function()
				return instance:GetAttribute(entry.name)
			end)
			if ok and not sameValue(entry.after, encode(value)) then
				return outcome(record.id, "conflict", string.format("The attribute %s has been changed since.", entry.name))
			end
		end
	end

	for _, entry in ipairs(entries) do
		local ok, err = pcall(function()
			instance:SetAttribute(entry.name, decode(entry.before))
		end)
		if not ok then
			return outcome(record.id, "failed", string.format("Could not set the attribute %s back: %s", entry.name, tostring(err)))
		end
	end

	return outcome(record.id, "reverted", nil)
end

local function revertTags(instance: Instance, record: any): any
	local tags = record.tags or {}

	for _, tag in ipairs(list(tags.added)) do
		pcall(function()
			CollectionService:RemoveTag(instance, tag)
		end)
	end

	for _, tag in ipairs(list(tags.removed)) do
		pcall(function()
			CollectionService:AddTag(instance, tag)
		end)
	end

	return outcome(record.id, "reverted", nil)
end

local function revertRename(instance: Instance, record: any, force: boolean): any
	local renamed = record.renamed or {}
	local before, after = text(renamed.before), text(renamed.after)

	if before == nil then
		return outcome(record.id, "unavailable", "The record does not carry the previous name.")
	end

	if not force and after ~= nil and instance.Name ~= after then
		return outcome(record.id, "conflict", "It has been renamed again since.", instance.Name)
	end

	local ok, err = pcall(function()
		instance.Name = before
	end)

	if not ok then
		return outcome(record.id, "failed", tostring(err))
	end

	return outcome(record.id, "reverted", nil)
end

local function revertReparent(instance: Instance, record: any, force: boolean): any
	local moved = record.moved or {}
	local before, after = text(moved.before), text(moved.after)

	if before == nil then
		return outcome(record.id, "unavailable", "The record does not carry the previous parent.")
	end

	local parent = instance.Parent
	local currentPath = parent and Path.of(parent) or "<detached>"

	if not force and after ~= nil and currentPath ~= after then
		return outcome(record.id, "conflict", "It has been moved again since.", currentPath)
	end

	local resolveOk, destination = pcall(Path.resolve, before, Handles.describe)
	if not resolveOk then
		return outcome(record.id, "unavailable", string.format("%s no longer exists to move it back into.", before))
	end

	local ok, err = pcall(function()
		instance.Parent = destination
	end)

	if not ok then
		return outcome(record.id, "failed", tostring(err))
	end

	return outcome(record.id, "reverted", nil)
end

local function revertCreate(instance: Instance, record: any, force: boolean): any
	local className = text(record.target and record.target.className)

	-- Taking back a create means destroying something, so the identity check is
	-- stricter than elsewhere: a path that now resolves to a different class is
	-- a different instance, and destroying it would be the worst kind of bug.
	if not force and className ~= nil and instance.ClassName ~= className then
		return outcome(
			record.id,
			"conflict",
			string.format("What is there now is a %s, not the %s that was created.", instance.ClassName, className),
			Path.of(instance)
		)
	end

	local ok, err = pcall(function()
		instance:Destroy()
	end)

	if not ok then
		return outcome(record.id, "failed", tostring(err))
	end

	return outcome(record.id, "reverted", nil)
end

local function revertDelete(record: any, force: boolean): any
	local stow = text(record.stow)
	local held = stow and stowed[stow] or nil

	if held == nil then
		return outcome(
			record.id,
			"unavailable",
			"The copy of this instance is gone. Luu Code holds deleted instances only until Studio moves between edit and play."
		)
	end

	local parentPath = text(record.parentPath)
	if parentPath == nil then
		return outcome(record.id, "unavailable", "The record does not say where it was.")
	end

	local resolveOk, parent = pcall(Path.resolve, parentPath, Handles.describe)
	if not resolveOk then
		return outcome(record.id, "unavailable", string.format("%s no longer exists to put it back into.", parentPath))
	end

	local name = text(record.target and record.target.name) or held.copy.Name

	if not force then
		local occupant = parent:FindFirstChild(name)
		if occupant ~= nil then
			return outcome(record.id, "conflict", string.format("%s already has something called %s.", parentPath, name), Path.of(occupant))
		end
	end

	local restored
	local ok, err = pcall(function()
		restored = held.copy:Clone()
		restored.Parent = parent
	end)

	if not ok or restored == nil then
		if restored ~= nil then
			restored:Destroy()
		end
		return outcome(record.id, "failed", string.format("Could not put it back into %s: %s", parentPath, tostring(err)))
	end

	-- The copy has done its job. Keeping it would hold the subtree in memory for
	-- the rest of the session to guard against a second revert of a record the
	-- server has already marked as done.
	held.copy:Destroy()
	stowed[stow] = nil
	stowedCount -= 1

	return outcome(record.id, "reverted", nil)
end

local function revertSource(instance: Instance, record: any, force: boolean): any
	if not instance:IsA("LuaSourceContainer") then
		return outcome(record.id, "unavailable", string.format("%s is a %s, not a script.", Path.of(instance), instance.ClassName))
	end

	local change = record.source or {}
	local before = text(change.before)

	if before == nil then
		return outcome(record.id, "unavailable", text(record.reason) or "The previous source was not kept.")
	end

	if not force then
		local current, readError = ScriptSource.tryRead(instance)
		if current == nil then
			return outcome(record.id, "failed", readError)
		end

		local after = text(change.after)
		-- Compared without carriage returns. An agent writing CRLF gets it back
		-- from the editor as LF, and a conflict on every single revert because
		-- of that would make the check look broken rather than careful.
		if after ~= nil and bare(current) ~= bare(after) then
			return outcome(
				record.id,
				"conflict",
				"The script has been edited since, so putting it back would throw those edits away.",
				string.format("%d lines now", ScriptSource.countLines(current))
			)
		end
	end

	local ok, err = pcall(ScriptSource.write, instance, before)
	if not ok then
		return outcome(record.id, "failed", Errors.coerce(err).message)
	end

	return outcome(record.id, "reverted", nil)
end

local function revertOne(record: any, force: boolean): any
	local kind = text(record.kind)

	if record.revertable == false then
		return outcome(record.id, "unavailable", text(record.reason) or "This change cannot be put back.")
	end

	-- A delete is the one case with nothing live to find: the instance is gone,
	-- which is the whole point of the record.
	if kind == "delete" then
		return revertDelete(record, force)
	end

	local instance, missing = locate(record)

	if instance == nil then
		if kind == "create" then
			-- Already gone, by whatever route. The end state the user asked for
			-- is the one that holds, and sending them looking for a conflict
			-- that is not there would be the unhelpful answer.
			return outcome(record.id, "reverted", "It had already been deleted.")
		end
		return outcome(record.id, "unavailable", missing)
	end

	if kind == "properties" then
		return revertProperties(instance, record, force)
	elseif kind == "attributes" then
		return revertAttributes(instance, record, force)
	elseif kind == "tags" then
		return revertTags(instance, record)
	elseif kind == "rename" then
		return revertRename(instance, record, force)
	elseif kind == "reparent" then
		return revertReparent(instance, record, force)
	elseif kind == "create" then
		return revertCreate(instance, record, force)
	elseif kind == "source" then
		return revertSource(instance, record, force)
	end

	return outcome(record.id, "unavailable", string.format("Luu Code does not know how to put back a %q change.", tostring(kind)))
end

--[[
	Applies the inverse of each record.

	The caller orders them newest first, which is what makes a run of changes to
	one instance compose: the last write is taken back before the one under it.
	One recording wraps the lot, so the user's own Ctrl+Z sees a revert as the
	single action it was rather than as fifteen.
]]
function Changes.apply(records: { any }, force: boolean): any
	local outcomes = {}

	History.record(string.format("Revert %d change(s)", #records), function()
		for _, record in ipairs(records) do
			local ok, result = pcall(revertOne, record, force)

			if ok then
				table.insert(outcomes, result)
			else
				table.insert(outcomes, outcome(record.id, "failed", Errors.coerce(result).message))
			end
		end
	end)

	return { outcomes = outcomes }
end

--[[
	Releases the copies held by a set of drafts.

	For the command that took them and then failed: the instances are still in
	the place, so the copies protect nothing and would spend the session's budget
	for restorable deletes on deletes that never happened.
]]
function Changes.discard(records: { any })
	for _, record in ipairs(records) do
		local id = text(record.stow)
		local held = id and stowed[id] or nil

		if held ~= nil then
			pcall(function()
				held.copy:Destroy()
			end)
			stowed[id] = nil
			stowedCount -= 1
		end
	end
end

--[[
	Drops every held copy.

	Called when Studio moves between edit and play. The copies belong to the
	DataModel they were taken from, and parenting an edit-time instance into a
	running one — or the reverse — restores something into a world it was never
	part of.
]]
function Changes.release(): number
	local released = stowedCount

	for _, entry in pairs(stowed) do
		pcall(function()
			entry.copy:Destroy()
		end)
	end

	table.clear(stowed)
	stowedCount = 0

	return released
end

function Changes.held(): number
	return stowedCount
end

return Changes
