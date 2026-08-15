--!nonstrict
--[[
	Synthetic input into the running experience.
	`UserInputService:CreateVirtualInput()` feeds the engine's real input
	pipeline and never touches the user's own mouse or keyboard.

	Not VirtualInputManager: its Send* methods are RobloxScriptSecurity and
	raise from a plugin. Availability is probed by constructing the object,
	since fetching the service always succeeds.
]]

local GuiService = game:GetService("GuiService")
local UserInputService = game:GetService("UserInputService")

local Errors = require(script.Parent.Errors)
local RenderMonitor = require(script.Parent.RenderMonitor)
local RunState = require(script.Parent.RunState)

local InputBridge = {}

local MOUSE_BUTTONS = {
	left = Enum.UserInputType.MouseButton1,
	right = Enum.UserInputType.MouseButton2,
	middle = Enum.UserInputType.MouseButton3,
}

--[[
	One VirtualInput for the life of this plugin VM. `press` and `release` arrive
	as separate calls, and a key held by one source cannot be released by another.
]]
local cached: any = nil
local probed = false
local probeFailure: string? = nil

local function create(): (any, string?)
	local ok, result = pcall(function()
		return (UserInputService :: any):CreateVirtualInput()
	end)

	if ok and result ~= nil then
		return result, nil
	end

	return nil, tostring(result)
end

local function virtualInput(): any
	if cached ~= nil then
		return cached
	end

	local created, failure = create()

	if created == nil then
		Errors.throw(
			"UNSUPPORTED_CAPABILITY",
			"This Studio build does not offer UserInputService:CreateVirtualInput(), so input cannot be delivered",
			{ reason = failure },
			"Drive the game through runtime.exec instead — set the property or fire the event the input would have caused."
		)
	end

	cached = created
	return cached
end

--[[
	Input is dropped by the engine, silently, when the window is not rendering.
	Refusing up front with the reason is the difference between an agent that
	restores the window and one that concludes the game's keybinds are broken.
]]
local function requireDeliverable()
	if not RunState.isRunning() then
		-- A playtest beside this DataModel rather than in it. Telling an agent
		-- nothing is running sends it to start a second one.
		if RunState.isTestActive() == true then
			Errors.throw(
				"RUNTIME_CONTEXT_UNAVAILABLE",
				"A playtest is running and Luu Code has no connection inside it, so input has nowhere to go",
				nil,
				"Drive the playtest by hand, or stop it and work in edit."
			)
		end

		Errors.throw(
			"PLAYTEST_NOT_RUNNING",
			"Input can only be delivered while the experience is running",
			nil,
			"Start a playtest first with run.start."
		)
	end

	local stalled = RenderMonitor.stallReason()
	if stalled ~= nil then
		Errors.throw("INPUT_FAILED", stalled, { rendering = false }, "Restore the Studio window, then send the input again.")
	end
end

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

function InputBridge.sendKey(keyCode: EnumItem, isPressed: boolean)
	local ok, err = pcall(function()
		virtualInput():SendKey(isPressed, keyCode)
	end)

	if not ok then
		Errors.throw("INPUT_FAILED", string.format("Could not send %s: %s", keyCode.Name, tostring(err)))
	end
end

function InputBridge.key(name: string, action: string, durationMs: number): any
	requireDeliverable()
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
	Types into whatever has focus. SendTextInput takes the characters directly, so
	no key-and-shift mapping and no US-layout limit. It cannot type with nothing
	focused, which is reported rather than delivered into nowhere.
]]
function InputBridge.text(text: string): any
	requireDeliverable()

	local focused = nil
	pcall(function()
		focused = UserInputService:GetFocusedTextBox()
	end)

	if focused == nil then
		Errors.throw(
			"INPUT_FAILED",
			"No TextBox has focus, so there is nothing for typed text to go into",
			nil,
			"Click the TextBox first with input.gui_click, or set its Text property directly."
		)
	end

	local ok, err = pcall(function()
		virtualInput():SendTextInput(text)
	end)

	if not ok then
		Errors.throw("INPUT_FAILED", string.format("Could not type into %s: %s", focused.Name, tostring(err)))
	end

	return { delivered = true, length = #text }
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

local function sendMousePosition(position: Vector2)
	local ok, err = pcall(function()
		virtualInput():SendMousePosition(position)
	end)

	if not ok then
		Errors.throw("INPUT_FAILED", string.format("Could not move the mouse: %s", tostring(err)))
	end
end

local function sendMouseButton(position: Vector2, button: string, isDown: boolean)
	local inputType = MOUSE_BUTTONS[button]
	if inputType == nil then
		Errors.throw("INVALID_PARAMS", string.format("Unknown mouse button %q", tostring(button)), nil, 'Use "left", "right", or "middle".')
	end

	local ok, err = pcall(function()
		virtualInput():SendMouseButton(position, inputType, isDown)
	end)

	if not ok then
		Errors.throw("INPUT_FAILED", string.format("Could not send the %s mouse button: %s", button, tostring(err)))
	end
end

--[[
	Positions the pointer before pressing. SendMouseButton carries the position,
	so the press lands either way — but hover state follows the pointer, and a
	control that only responds when hovered needs it.
]]
function InputBridge.clickAt(x: number, y: number, button: string)
	local position = Vector2.new(x, y)
	sendMousePosition(position)
	task.wait(0.02)
	sendMouseButton(position, button, true)
	task.wait(0.04)
	sendMouseButton(position, button, false)
end

function InputBridge.mouse(params: any): any
	requireDeliverable()

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
	local button = params.button or "left"
	local action = params.action

	if action == "move" then
		sendMousePosition(Vector2.new(x, y))
	elseif action == "click" then
		InputBridge.clickAt(x, y, button)
	elseif action == "down" then
		sendMousePosition(Vector2.new(x, y))
		sendMouseButton(Vector2.new(x, y), button, true)
	elseif action == "up" then
		sendMouseButton(Vector2.new(x, y), button, false)
	elseif action == "scroll" then
		-- SendPointerAction is the only wheel entry point on VirtualInput, and
		-- the shape of its action table is not documented. It is attempted
		-- rather than assumed: a build that does not take it gets an error
		-- naming a way round, not a success that scrolled nothing.
		local delta = params.scrollDelta or 1
		local ok = pcall(function()
			virtualInput():SendPointerAction(Vector2.new(x, y), { Wheel = delta })
		end)

		if not ok then
			Errors.throw(
				"UNSUPPORTED_CAPABILITY",
				"This Studio build does not accept wheel input through VirtualInput",
				{ scrollDelta = delta },
				"Set the ScrollingFrame's CanvasPosition directly with runtime.exec instead."
			)
		end
	elseif action == "drag" then
		local toX, toY = toPixels(params.toX, params.toY)

		sendMousePosition(Vector2.new(x, y))
		task.wait(0.02)
		sendMouseButton(Vector2.new(x, y), button, true)

		-- Interpolated so the game sees movement rather than a teleport, which
		-- most drag handlers depend on.
		local steps = math.max(4, math.floor((params.durationMs or 80) / 16))
		for step = 1, steps do
			local alpha = step / steps
			sendMousePosition(Vector2.new(x + (toX - x) * alpha, y + (toY - y) * alpha))
			task.wait(0.016)
		end

		sendMouseButton(Vector2.new(toX, toY), button, false)
		x, y = toX, toY
	else
		Errors.throw("INVALID_PARAMS", string.format("Unknown mouse action %q", tostring(action)))
	end

	return { delivered = true, position = { x = x, y = y } }
end

--[[
	Probed once, by constructing the object — asking whether the service exists
	has the same answer whether or not input works. The object is kept.
]]
function InputBridge.isAvailable(): boolean
	if cached ~= nil then
		return true
	end

	if probed then
		return false
	end

	probed = true
	local created, failure = create()

	if created == nil then
		probeFailure = failure
		return false
	end

	cached = created
	return true
end

function InputBridge.unavailableReason(): string?
	return probeFailure
end

return InputBridge
