--!nonstrict
--[[
	Reading and writing script source.

	Its own module because two callers need it and they must not drift: the
	script commands, and the change journal that has to read a script before an
	edit and write it back when the user reverts one. The rules below are not
	obvious and getting them wrong is silent, so there is exactly one copy.

	Not called `Source`, which is what it wants to be called. Every module here
	is reached as `script.Parent.<Name>`, `script.Parent` is the plugin's root
	Script, and `Source` is a property of every Script — so the index would hand
	back that script's own text instead of this module, and `require` would fail
	on a string. Roblox resolves properties before children, and the error it
	produces names neither.

	Reads prefer ScriptEditorService so the agent sees what the user sees,
	including edits open in a tab but not yet committed to the instance. Writes
	go back through the same service for the same reason: assigning Source
	directly can be discarded without error when the script is open.
]]

local ScriptEditorService = game:GetService("ScriptEditorService")

local Errors = require(script.Parent.Errors)
local Path = require(script.Parent.Path)

local ScriptSource = {}

function ScriptSource.splitLines(source: string): { string }
	local lines = {}
	for line in string.gmatch(source .. "\n", "(.-)\n") do
		table.insert(lines, line)
	end
	-- gmatch on the padded string yields one trailing empty entry for sources
	-- that already ended in a newline; drop it so line numbers stay honest.
	if #lines > 0 and lines[#lines] == "" and string.sub(source, -1) == "\n" then
		table.remove(lines)
	end
	return lines
end

function ScriptSource.countLines(source: string): number
	if #source == 0 then
		return 0
	end
	local _, newlines = string.gsub(source, "\n", "")
	return newlines + 1
end

function ScriptSource.read(instance: LuaSourceContainer): string
	local editorOk, editorSource = pcall(function()
		return ScriptEditorService:GetEditorSource(instance)
	end)

	if editorOk and type(editorSource) == "string" then
		return editorSource
	end

	local ok, source = pcall(function()
		return (instance :: any).Source
	end)

	if not ok then
		Errors.throw(
			"NOT_ALLOWED_BY_ROBLOX",
			string.format("Source is not readable on %s: %s", Path.of(instance), tostring(source)),
			nil,
			"Studio blocks source access for some protected instances."
		)
	end

	return source
end

--[[
	Reads without raising, for callers that want the source only if it is
	available. The journal is one: a script it cannot read before an edit is a
	change it cannot put back, and that is worth recording rather than throwing.
]]
function ScriptSource.tryRead(instance: LuaSourceContainer): (string?, string?)
	local ok, result = pcall(ScriptSource.read, instance)
	if ok then
		return result, nil
	end
	return nil, Errors.coerce(result).message
end

function ScriptSource.write(instance: LuaSourceContainer, source: string)
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(instance, function()
			return source
		end)
	end)

	if ok then
		return
	end

	-- Older Studio versions, and some contexts, do not accept the editor path.
	local fallbackOk, fallbackErr = pcall(function()
		(instance :: any).Source = source
	end)

	if not fallbackOk then
		error(
			Errors.fromRobloxError(
				string.format("Could not write source to %s: %s", Path.of(instance), tostring(fallbackErr)),
				{ editorError = tostring(err) }
			),
			0
		)
	end
end

return ScriptSource
