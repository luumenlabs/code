--!nonstrict
--[[
	Synthetic input into the running experience. Spec sections 18 and 51.

	`UserInputService:CreateVirtualInput()` is the path that works. The object it
	returns feeds the engine's real input pipeline, so a key reaches
	UserInputService.InputBegan and the default control modules — W walks the
	character at its actual WalkSpeed, with the controls intact and no Humanoid
	hijack — and a mouse button hit-tests against the GUI exactly as a user's
	click would. It is confined to the experience: the user's own mouse and
	keyboard are never touched, and Studio does not have to be the frontmost
	window.

	This module used to use VirtualInputManager, which looks like the obvious
	choice and cannot work. Every one of its Send* methods is RobloxScriptSecurity
	and a plugin does not have that capability, so each call raised — and
	`isAvailable` only checked that the *service* could be fetched, which it
	always can. The result was a session that advertised input.virtual, accepted
	every key and click, and delivered none of them. Availability here is
	therefore probed by constructing the object, not by naming the API.
]]

local GuiService = game:GetService("GuiService")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Errors = require(script.Parent.Errors)
local RenderMonitor = require(script.Parent.RenderMonitor)

local InputBridge = {}

local MOUSE_BUTTONS = {
	left = Enum.UserInputType.MouseButton1,
	right = Enum.UserInputType.MouseButton2,
	middle = Enum.UserInputType.MouseButton3,
}

--[[
	One VirtualInput for the life of this plugin VM.

	It has to be reused: `press` and `release` arrive as separate calls, and a
	key held down by one input source cannot be released by another, so a fresh
	object per call would leave W stuck down forever.
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
	if not RunService:IsRunning() then
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
	Types into whatever currently has focus.

	SendTextInput hands the engine the characters directly, so this no longer has
	to map each one onto a key and a shift state — which meant anything outside a
	US keyboard layout came back as "could not be typed". The one thing it cannot
	do is type where nothing is focused, and that is worth saying plainly rather
	than reporting a successful delivery into nowhere.
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
	Positions the pointer before pressing.

	SendMouseButton takes the position with it, so the press would land correctly
	either way — but the engine's hover state, and every UI that reacts to it,
	follows the pointer rather than the click. Moving first is what makes a
	button that only responds when hovered behave the way it does for a user.
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
	Probed once, by building the thing.

	The old version asked whether a service existed, which is a question with the
	same answer whether or not input works. Constructing the VirtualInput is the
	only check that distinguishes them, and the object is kept because it is the
	one this session will go on using.
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
