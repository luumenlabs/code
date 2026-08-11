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
local Exec = require(script.Parent.Parent.Exec)
local Handles = require(script.Parent.Parent.Handles)
local History = require(script.Parent.Parent.History)
local Path = require(script.Parent.Parent.Path)
local ScriptSource = require(script.Parent.Parent.ScriptSource)
local Value = require(script.Parent.Parent.Value)

local ScriptOps = {}

local splitLines = ScriptSource.splitLines
local countLines = ScriptSource.countLines

--[[
	Does it compile? Answered on the way out of every write.

	Without this the first sign of a missing `end` is a playtest that will not
	start, three round trips later. A build where nothing can be compiled reports
	nothing rather than a compile failure it cannot substantiate.
]]
local function checkSyntax(source: string): any
	if not Exec.isAvailable() then
		return Value.NIL
	end

	return Exec.check(source)
end

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

--[[
	Every match of `pattern` on one line, left to right.

	A literal search lowercases both sides when it is case-insensitive but
	measures the column against the original, so the number points at the real
	character. A pattern search is always case-sensitive, because Luau patterns
	carry their own character classes and folding the subject would quietly
	change what %u and %l mean.
]]
local function findInLine(line: string, needle: string, isPattern: boolean, caseSensitive: boolean): { number }
	local columns = {}
	local haystack = line
	local subject = needle

	if isPattern then
		local from = 1
		while from <= #haystack do
			local ok, start, finish = pcall(string.find, haystack, subject, from)

			-- A malformed pattern is the caller's mistake, and it is the same
			-- mistake on every line; raising it once, named, beats returning no
			-- matches and letting them conclude the code is not there.
			if not ok then
				Errors.throw(
					"INVALID_PARAMS",
					string.format("%q is not a valid Luau pattern: %s", needle, tostring(start)),
					{ pattern = needle },
					"Luau patterns are not regular expressions. Escape magic characters with %, or set regex to false for a literal search."
				)
			end

			if start == nil then
				break
			end

			table.insert(columns, start)
			-- An empty match would otherwise spin here forever.
			from = math.max((finish :: number) + 1, (start :: number) + 1)
		end

		return columns
	end

	if not caseSensitive then
		haystack = string.lower(haystack)
		subject = string.lower(subject)
	end

	local from = 1
	while true do
		local start = string.find(haystack, subject, from, true)
		if start == nil then
			break
		end
		table.insert(columns, start)
		from = start + 1
	end

	return columns
end

local function contextSlice(lines: { string }, from: number, to: number): { string }
	local slice = {}
	for index = math.max(from, 1), math.min(to, #lines) do
		table.insert(slice, lines[index])
	end
	return slice
end

--[[
	Searches every script's source in one pass.

	There is no filesystem to grep: the source of truth is the DataModel, and
	finding one call site by reading scripts individually costs a round trip and
	a context window per file. Scripts whose source Studio will not hand over are
	skipped rather than failing the search — one locked module should not hide
	every other match — and the count of them comes back so a suspiciously empty
	result is explainable.
]]
function ScriptOps.grep(params: any): any
	local scope = params.scope and Handles.resolve(params.scope) or game
	local isPattern = params.regex == true
	local caseSensitive = params.caseSensitive == true
	local contextLines = params.contextLines or 0
	local maxMatches = params.maxMatches or 100
	local maxPerScript = params.maxPerScript or 20
	local pathsOnly = params.pathsOnly == true

	local files = {}
	local matchCount = 0
	local scriptsSearched = 0
	local unreadable = 0
	local truncated = false

	for _, instance in ipairs(scope:GetDescendants()) do
		if matchCount >= maxMatches then
			truncated = true
			break
		end

		if instance:IsA("LuaSourceContainer") and (params.className == nil or instance.ClassName == params.className) then
			local source = ScriptSource.tryRead(instance)

			if source == nil then
				unreadable += 1
			else
				scriptsSearched += 1
				local lines = splitLines(source)
				local matches = {}
				local inThisScript = 0

				for number, line in ipairs(lines) do
					local columns = findInLine(line, params.pattern, isPattern, caseSensitive)

					for _, column in ipairs(columns) do
						inThisScript += 1
						matchCount += 1

						if not pathsOnly and #matches < maxPerScript then
							table.insert(matches, {
								line = number,
								column = column,
								text = line,
								before = contextLines > 0 and contextSlice(lines, number - contextLines, number - 1) or {},
								after = contextLines > 0 and contextSlice(lines, number + 1, number + contextLines) or {},
							})
						end

						if matchCount >= maxMatches then
							truncated = true
							break
						end
					end

					if matchCount >= maxMatches then
						break
					end
				end

				if inThisScript > 0 then
					table.insert(files, {
						instance = Handles.describe(instance),
						matches = matches,
						matchCount = inThisScript,
					})
				end
			end
		end
	end

	return {
		files = files,
		matchCount = matchCount,
		scriptsSearched = scriptsSearched,
		unreadable = unreadable,
		truncated = truncated,
	}
end

--[[
	Replaces every match on one line, returning the new line and how many.

	The literal case splices around the columns grep already knows how to find,
	which sidesteps escaping entirely — the text being replaced is user code, and
	it is full of the characters Luau patterns treat as magic. Only the pattern
	case goes through gsub, where that syntax is what the caller asked for.
]]
local function replaceInLine(
	line: string,
	needle: string,
	replacement: string,
	isPattern: boolean,
	caseSensitive: boolean,
	budget: number
): (string, number)
	if budget <= 0 then
		return line, 0
	end

	if isPattern then
		local ok, updated, count = pcall(string.gsub, line, needle, replacement, budget)

		if not ok then
			Errors.throw(
				"INVALID_PARAMS",
				string.format("Could not apply the replacement: %s", tostring(updated)),
				{ pattern = needle, replacement = replacement },
				"Luau patterns are not regular expressions. %1 and %2 refer to captures in the pattern, and a literal % must be written %%."
			)
		end

		return updated :: string, count :: number
	end

	local columns = findInLine(line, needle, false, caseSensitive)
	if #columns == 0 then
		return line, 0
	end

	local pieces = {}
	local cursor = 1
	local made = 0

	for _, column in ipairs(columns) do
		if made >= budget then
			break
		end

		-- Overlapping matches: findInLine advances one character at a time, so a
		-- column inside the text already consumed is not a second replacement.
		if column >= cursor then
			table.insert(pieces, string.sub(line, cursor, column - 1))
			table.insert(pieces, replacement)
			cursor = column + #needle
			made += 1
		end
	end

	table.insert(pieces, string.sub(line, cursor))

	return table.concat(pieces), made
end

--[[
	One pattern across every script in scope.

	Everything is computed before anything is written, so a sweep that would go
	over either ceiling fails having touched nothing. Half a rename applied
	across a codebase is worse than none: the place still builds, and the agent
	has no way to tell which half it got.
]]
function ScriptOps.replace(params: any): any
	local scope = params.scope and Handles.resolve(params.scope) or game
	local isPattern = params.regex == true
	local caseSensitive = isPattern or params.caseSensitive == true
	local dryRun = params.dryRun == true
	local maxReplacements = params.maxReplacements or 500
	local maxPerScript = params.maxPerScript or 50
	local contextLimit = params.contextLimit or 10

	local planned = {}
	local files = {}
	local replaced = 0
	local scriptsSearched = 0
	local unreadable = 0

	for _, instance in ipairs(scope:GetDescendants()) do
		if instance:IsA("LuaSourceContainer") and (params.className == nil or instance.ClassName == params.className) then
			local source = ScriptSource.tryRead(instance)

			if source == nil then
				unreadable += 1
			else
				scriptsSearched += 1

				local lines = splitLines(source)
				local matches = {}
				local inThisScript = 0
				local changedLines = 0
				local changed = false

				for number, line in ipairs(lines) do
					local updated, count =
						replaceInLine(line, params.pattern, params.replacement, isPattern, caseSensitive, maxPerScript - inThisScript + 1)

					if count > 0 then
						inThisScript += count
						changedLines += 1
						changed = true

						if #matches < contextLimit then
							table.insert(matches, { line = number, before = line, after = updated })
						end

						lines[number] = updated
					end

					if inThisScript > maxPerScript then
						Errors.throw(
							"INVALID_PARAMS",
							string.format("%s alone has more than %d matches, so nothing was replaced", Path.of(instance), maxPerScript),
							{ path = Path.of(instance), maxPerScript = maxPerScript },
							"Narrow the pattern or the scope, or raise maxPerScript once you have seen the matches with a dryRun."
						)
					end
				end

				if changed then
					replaced += inThisScript

					if replaced > maxReplacements then
						Errors.throw(
							"INVALID_PARAMS",
							string.format("The pattern matches more than %d times, so nothing was replaced", maxReplacements),
							{ maxReplacements = maxReplacements, scriptsSearched = scriptsSearched },
							"Run it again with dryRun to see what it would touch, then narrow the pattern or raise maxReplacements."
						)
					end

					local updatedSource = table.concat(lines, "\n")

					table.insert(planned, { instance = instance, before = source, after = updatedSource })
					table.insert(files, {
						instance = Handles.describe(instance),
						replacements = inThisScript,
						matches = matches,
						matchesTruncated = #matches < changedLines,
						syntax = checkSyntax(updatedSource),
					})
				end
			end
		end
	end

	local instances = {}
	local drafts = {}
	local undoLabel: any = Value.NIL

	if not dryRun and #planned > 0 then
		local _, label = History.record(string.format("Replace in %d script(s)", #planned), function()
			for _, entry in ipairs(planned) do
				writeSource(entry.instance, entry.after)
			end
		end)

		undoLabel = label

		for _, entry in ipairs(planned) do
			table.insert(instances, Handles.describe(entry.instance))
			table.insert(drafts, Changes.source(entry.instance, entry.before, nil, entry.after))
		end
	end

	return {
		instances = instances,
		undoLabel = undoLabel,
		files = files,
		replaced = replaced,
		scriptsChanged = #planned,
		scriptsSearched = scriptsSearched,
		unreadable = unreadable,
		dryRun = dryRun,
		changes = drafts,
	}
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
		syntax = checkSyntax(params.source),
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
		syntax = checkSyntax(updated),
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
		syntax = checkSyntax(params.source or ""),
		-- One record, not two. The script and its source arrived together, so
		-- taking the create back takes the source with it, and a separate source
		-- record would offer to revert a script into existing with no contents.
		changes = { Changes.create(created) },
	}
end

return ScriptOps
