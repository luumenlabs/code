--!nonstrict
--[[
	Synthetic input into the running experience. Spec sections 18 and 51.

	VirtualInputManager is the structured path: it delivers events straight into
	the game rather than driving the desktop, so it works without stealing the
	user's mouse and is deterministic enough to test with. Desktop-level input
	stays in the native layer for the cases Studio cannot cover.
]]

local GuiService = game:GetService("GuiService")
local RunService = game:GetService("RunService")

local Errors = require(script.Parent.Errors)

local InputBridge = {}

local function manager(): any
	local ok, service = pcall(function()
		return game:GetService("VirtualInputManager")
	end)

	if not ok or service == nil then
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			"VirtualInputManager is unavailable in this Studio session",
			nil,
			"Enable native input in Luu Code to drive the game through desktop events instead."
		)
	end

	return service
end

local BUTTON_NUMBERS = {
	left = 0,
	right = 1,
	middle = 2,
}

-- Characters that need Shift, mapped to the unshifted key they live on.
local SHIFTED = {
	["!"] = "One",
	["@"] = "Two",
	["#"] = "Three",
	["$"] = "Four",
	["%"] = "Five",
	["^"] = "Six",
	["&"] = "Seven",
	["*"] = "Eight",
	["("] = "Nine",
	[")"] = "Zero",
	["_"] = "Minus",
	["+"] = "Equals",
	["{"] = "LeftBracket",
	["}"] = "RightBracket",
	["|"] = "BackSlash",
	[":"] = "Semicolon",
	['"'] = "Quote",
	["<"] = "Comma",
	[">"] = "Period",
	["?"] = "Slash",
	["~"] = "Backquote",
}

local UNSHIFTED = {
	["-"] = "Minus",
	["="] = "Equals",
	["["] = "LeftBracket",
	["]"] = "RightBracket",
	["\\"] = "BackSlash",
	[";"] = "Semicolon",
	["'"] = "Quote",
	[","] = "Comma",
	["."] = "Period",
	["/"] = "Slash",
	["`"] = "Backquote",
	[" "] = "Space",
	["\n"] = "Return",
	["\t"] = "Tab",
}

local DIGITS = { "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine" }

function InputBridge.keyCode(name: string): EnumItem
	local keyCode = (Enum.KeyCode :: any)[name]
	if keyCode == nil then
		Errors.throw(
			"INVALID_PARAMS",
			string.format("%q is not an Enum.KeyCode name", name),
			nil,
			'Use Roblox key names such as "W", "Space", "E", "LeftShift", or "Return".'
		)
	end
	return keyCode
end

local function requireRunning()
	if not RunService:IsRunning() then
		Errors.throw("PLAYTEST_NOT_RUNNING", "Input can only be delivered while the experience is running", nil, "Start a playtest first.")
	end
end

function InputBridge.sendKey(keyCode: EnumItem, isPressed: boolean)
	manager():SendKeyEvent(isPressed, keyCode, false, game)
end

function InputBridge.key(name: string, action: string, durationMs: number): any
	requireRunning()
	local keyCode = InputBridge.keyCode(name)

	if action == "press" then
		InputBridge.sendKey(keyCode, true)
	elseif action == "release" then
		InputBridge.sendKey(keyCode, false)
	else
		InputBridge.sendKey(keyCode, true)
		task.wait(math.max(durationMs, 0) / 1000)
		InputBridge.sendKey(keyCode, false)
	end

	return { delivered = true, key = name, action = action }
end

--[[
	Types text as key events.

	Roblox's character-level input entry point is not stable across Studio
	versions, and guessing at it would fail silently. Key events are well
	defined, so unsupported characters are reported back rather than dropped.
]]
function InputBridge.text(text: string): any
	requireRunning()

	local shift = InputBridge.keyCode("LeftShift")
	local skipped = {}

	for index = 1, #text do
		local char = string.sub(text, index, index)
		local keyName: string? = nil
		local needsShift = false

		if string.match(char, "^%l$") then
			keyName = string.upper(char)
		elseif string.match(char, "^%u$") then
			keyName = char
			needsShift = true
		elseif string.match(char, "^%d$") then
			local digit = tonumber(char)
			keyName = digit ~= nil and DIGITS[digit + 1] or nil
		elseif SHIFTED[char] ~= nil then
			keyName = SHIFTED[char]
			needsShift = true
		elseif UNSHIFTED[char] ~= nil then
			keyName = UNSHIFTED[char]
		end

		if keyName == nil then
			table.insert(skipped, char)
		else
			local keyCode = InputBridge.keyCode(keyName)
			if needsShift then
				InputBridge.sendKey(shift, true)
			end
			InputBridge.sendKey(keyCode, true)
			task.wait(0.012)
			InputBridge.sendKey(keyCode, false)
			if needsShift then
				InputBridge.sendKey(shift, false)
			end
			task.wait(0.012)
		end
	end

	if #skipped > 0 then
		Errors.throw(
			"INPUT_FAILED",
			string.format("%d character(s) could not be typed as key events", #skipped),
			{ skipped = skipped },
			"Set the TextBox's Text property directly instead."
		)
	end

	return { delivered = true, length = #text }
end

function InputBridge.moveMouse(x: number, y: number)
	manager():SendMouseMoveEvent(x, y, game)
end

function InputBridge.clickAt(x: number, y: number, button: string)
	local number = BUTTON_NUMBERS[button]
	if number == nil then
		Errors.throw("INVALID_PARAMS", string.format("Unknown mouse button %q", button))
	end

	local vim = manager()
	vim:SendMouseMoveEvent(x, y, game)
	task.wait(0.02)
	vim:SendMouseButtonEvent(x, y, number, true, game, 0)
	task.wait(0.04)
	vim:SendMouseButtonEvent(x, y, number, false, game, 0)
end

function InputBridge.mouse(params: any): any
	requireRunning()

	local viewport = InputBridge.viewportSize()
	local function toPixels(x: number?, y: number?): (number, number)
		local px = x or viewport.X / 2
		local py = y or viewport.Y / 2
		if params.normalized then
			px = px * viewport.X
			py = py * viewport.Y
		end
		return px, py
	end

	local x, y = toPixels(params.x, params.y)
	local vim = manager()
	local button = BUTTON_NUMBERS[params.button or "left"]

	if button == nil then
		Errors.throw("INVALID_PARAMS", string.format("Unknown mouse button %q", tostring(params.button)))
	end

	if params.action == "move" then
		vim:SendMouseMoveEvent(x, y, game)
	elseif params.action == "click" then
		InputBridge.clickAt(x, y, params.button or "left")
	elseif params.action == "down" then
		vim:SendMouseButtonEvent(x, y, button, true, game, 0)
	elseif params.action == "up" then
		vim:SendMouseButtonEvent(x, y, button, false, game, 0)
	elseif params.action == "scroll" then
		vim:SendMouseWheelEvent(x, y, (params.scrollDelta or 1) > 0, game)
	elseif params.action == "drag" then
		local toX, toY = toPixels(params.toX, params.toY)
		vim:SendMouseMoveEvent(x, y, game)
		task.wait(0.02)
		vim:SendMouseButtonEvent(x, y, button, true, game, 0)

		-- Interpolated so the game sees movement rather than a teleport, which
		-- most drag handlers depend on.
		local steps = math.max(4, math.floor((params.durationMs or 80) / 16))
		for step = 1, steps do
			local alpha = step / steps
			vim:SendMouseMoveEvent(x + (toX - x) * alpha, y + (toY - y) * alpha, game)
			task.wait(0.016)
		end

		vim:SendMouseButtonEvent(toX, toY, button, false, game, 0)
		x, y = toX, toY
	else
		Errors.throw("INVALID_PARAMS", string.format("Unknown mouse action %q", tostring(params.action)))
	end

	return { delivered = true, position = { x = x, y = y } }
end

function InputBridge.viewportSize(): Vector2
	local camera = workspace.CurrentCamera
	if camera ~= nil then
		return camera.ViewportSize
	end
	return Vector2.new(1280, 720)
end

function InputBridge.guiInset(): Vector2
	local ok, inset = pcall(function()
		return GuiService:GetGuiInset()
	end)
	return ok and inset or Vector2.new(0, 0)
end

function InputBridge.isAvailable(): boolean
	local ok = pcall(function()
		return game:GetService("VirtualInputManager")
	end)
	return ok
end

return InputBridge
