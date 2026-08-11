--!nonstrict
--[[
	Script reading and editing. Spec sections 9.2 and 10.2.

	Source access itself lives in ScriptSource.luau, shared with the change journal so
	the editor-service rules have one home. What is here is the command surface
	on top of it: line ranges, targeted edits, and recording both sides of every
	write so the user can review and take one back.
]]

local Errors = require(script.Parent.Parent.Errors)
local Changes = require(script.Parent.Parent.Changes)
local Handles = require(script.Parent.Parent.Handles)
local History = require(script.Parent.Parent.History)
local Path = require(script.Parent.Parent.Path)
local ScriptSource = require(script.Parent.Parent.ScriptSource)
local Value = require(script.Parent.Parent.Value)

local ScriptOps = {}

local splitLines = ScriptSource.splitLines
local countLines = ScriptSource.countLines

local function requireScript(target: string): LuaSourceContainer
	local instance = Handles.resolve(target)

	if not instance:IsA("LuaSourceContainer") then
		Errors.throw(
			"INVALID_PARAMS",
			string.format("%s is a %s, not a script", Path.of(instance), instance.ClassName),
			{ className = instance.ClassName }
		)
	end

	return instance
end

local readSource = ScriptSource.read
local writeSource = ScriptSource.write

function ScriptOps.list(params: any): any
	local scope = params.scope and Handles.resolve(params.scope) or game
	local limit = params.limit or 200
	local scripts = {}
	local truncated = false

	for _, instance in ipairs(scope:GetDescendants()) do
		if #scripts >= limit then
			truncated = true
			break
		end

		if instance:IsA("LuaSourceContainer") then
			if params.className == nil or instance.ClassName == params.className then
				table.insert(scripts, Handles.describe(instance))
			end
		end
	end

	return { scripts = scripts, truncated = truncated }
end

function ScriptOps.get(params: any): any
	local instance = requireScript(params.target)
	local source = readSource(instance)
	local totalLines = countLines(source)

	local startLine = params.startLine or 1
	local endLine = params.endLine or totalLines

	if params.startLine == nil and params.endLine == nil then
		return {
			instance = Handles.describe(instance),
			source = source,
			startLine = 1,
			endLine = totalLines,
			totalLines = totalLines,
			truncated = false,
		}
	end

	local lines = splitLines(source)
	startLine = math.max(1, math.min(startLine, totalLines))
	endLine = math.max(startLine, math.min(endLine, totalLines))

	local slice = table.concat(table.move(lines, startLine, endLine, 1, {}), "\n")

	return {
		instance = Handles.describe(instance),
		source = slice,
		startLine = startLine,
		endLine = endLine,
		totalLines = totalLines,
		truncated = startLine > 1 or endLine < totalLines,
	}
end

function ScriptOps.set(params: any): any
	local instance = requireScript(params.target)
	-- Read before the write, and tolerate not being able to: a script whose
	-- source Studio will not hand over can still be written, and the honest
	-- record of that is "changed, cannot be put back".
	local before, unreadable = ScriptSource.tryRead(instance)

	local _, undoLabel = History.record(string.format("Edit %s", instance.Name), function()
		writeSource(instance, params.source)
	end)

	return {
		instances = { Handles.describe(instance) },
		undoLabel = undoLabel,
		lineCount = countLines(params.source),
		changes = { Changes.source(instance, before, unreadable, params.source) },
	}
end

--[[
	Applies edits in order against the running text.

	A find that matches more than once is rejected rather than guessed at: in a
	script, replacing the wrong occurrence is a silent bug the agent will not
	notice until much later.
]]
local function applyEdits(source: string, edits: { any }): (string, { string })
	local current = source
	local summaries = {}

	for index, edit in ipairs(edits) do
		if edit.find ~= nil then
			local occurrences = 0
			local searchFrom = 1

			while true do
				local found = string.find(current, edit.find, searchFrom, true)
				if found == nil then
					break
				end
				occurrences += 1
				searchFrom = found + 1
			end

			if occurrences == 0 then
				Errors.throw(
					"INVALID_PARAMS",
					string.format("Edit %d: the text to replace was not found", index),
					{ find = edit.find },
					"Read the script first; the source may have changed since you last saw it."
				)
			end

			if occurrences > 1 and not edit.all then
				Errors.throw(
					"TARGET_AMBIGUOUS",
					string.format("Edit %d: the text to replace appears %d times", index, occurrences),
					{ find = edit.find, occurrences = occurrences },
					"Include more surrounding context, or set all to true to replace every occurrence."
				)
			end

			-- Plain replacement: escape the pattern and the replacement so Luau
			-- pattern syntax in user code cannot corrupt the edit.
			local pattern = string.gsub(edit.find, "([%^%$%(%)%%%.%[%]%*%+%-%?])", "%%%1")
			local replacement = string.gsub(edit.replace, "%%", "%%%%")

			if edit.all then
				current = string.gsub(current, pattern, replacement)
			else
				current = string.gsub(current, pattern, replacement, 1)
			end

			table.insert(summaries, string.format("replaced %d occurrence(s)", occurrences > 1 and occurrences or 1))
		else
			local lines = splitLines(current)
			local total = #lines

			if edit.startLine > total then
				Errors.throw(
					"INVALID_PARAMS",
					string.format("Edit %d: startLine %d is past the end of the script (%d lines)", index, edit.startLine, total),
					{ totalLines = total }
				)
			end

			local endLine = math.min(edit.endLine, total)
			local before = table.move(lines, 1, edit.startLine - 1, 1, {})
			local after = table.move(lines, endLine + 1, total, 1, {})
			local replacement = splitLines(edit.replacement)

			local merged = {}
			table.move(before, 1, #before, 1, merged)
			table.move(replacement, 1, #replacement, #merged + 1, merged)
			table.move(after, 1, #after, #merged + 1, merged)

			current = table.concat(merged, "\n")
			table.insert(summaries, string.format("replaced lines %d-%d", edit.startLine, endLine))
		end
	end

	return current, summaries
end

function ScriptOps.patch(params: any): any
	local instance = requireScript(params.target)
	local original = readSource(instance)
	local updated, summaries = applyEdits(original, params.edits)

	if updated == original then
		Errors.throw(
			"INVALID_PARAMS",
			"The edits produced no change",
			{ path = Path.of(instance) },
			"Read the current source and base the edit on it."
		)
	end

	local _, undoLabel = History.record(string.format("Patch %s", instance.Name), function()
		writeSource(instance, updated)
	end)

	return {
		instances = { Handles.describe(instance) },
		undoLabel = undoLabel,
		applied = #params.edits,
		lineCount = countLines(updated),
		diff = table.concat(summaries, "; "),
		changes = { Changes.source(instance, original, nil, updated) },
	}
end

function ScriptOps.create(params: any): any
	local parent = Handles.resolve(params.parent)

	local created, undoLabel = History.record(string.format("Create %s", params.name), function()
		local instance = Instance.new(params.className)
		instance.Name = params.name

		for name, raw in pairs(params.properties or {}) do
			local ok, err = pcall(function()
				(instance :: any)[name] = Value.decode(raw, Handles.resolve)
			end)
			if not ok then
				instance:Destroy()
				error(Errors.fromRobloxError(string.format("Could not set %s: %s", name, tostring(err))), 0)
			end
		end

		instance.Parent = parent
		-- Parented first so the editor path has a real location to write to.
		writeSource(instance, params.source or "")
		return instance
	end)

	return {
		instances = { Handles.describe(created) },
		undoLabel = undoLabel,
		lineCount = countLines(params.source or ""),
		-- One record, not two. The script and its source arrived together, so
		-- taking the create back takes the source with it, and a separate source
		-- record would offer to revert a script into existing with no contents.
		changes = { Changes.create(created) },
	}
end

return ScriptOps
