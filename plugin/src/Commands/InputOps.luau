--!nonstrict
--[[
	Game interaction. Spec sections 18, 37, and 51.

	Interaction is treated as a reliability problem rather than a demo. A click
	is resolved to a real, visible, on-screen element first, and the element it
	actually hit comes back in the result so the agent can verify what happened
	instead of assuming the input landed.
]]

local Players = game:GetService("Players")

local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local InputBridge = require(script.Parent.Parent.InputBridge)
local Path = require(script.Parent.Parent.Path)
local RunState = require(script.Parent.Parent.RunState)

local InputOps = {}

function InputOps.key(params: any): any
	return InputBridge.key(params.key, params.action or "tap", params.durationMs or 60)
end

function InputOps.text(params: any): any
	return InputBridge.text(params.text)
end

function InputOps.mouse(params: any): any
	return InputBridge.mouse(params)
end

local function guiRoot(): Instance
	local localPlayer = Players.LocalPlayer

	if localPlayer == nil then
		Errors.throw(
			"RUNTIME_CONTEXT_UNAVAILABLE",
			"There is no LocalPlayer in this Studio context, so player GUI cannot be reached",
			{ realm = RunState.current().realm },
			'Start the playtest with mode "play" instead of "run", which produces a client to observe.'
		)
	end

	local playerGui = localPlayer:FindFirstChildOfClass("PlayerGui")
	if playerGui == nil then
		Errors.throw("RUNTIME_CONTEXT_UNAVAILABLE", "PlayerGui has not been created yet", nil, "Wait for the playtest to become ready.")
	end

	return playerGui
end

--[[
	An element is only clickable if every ancestor up to the ScreenGui agrees.
	Reporting which ancestor hid it turns "the click did nothing" into an
	actionable finding.
]]
local function visibilityProblem(instance: Instance): string?
	local current: Instance? = instance

	while current ~= nil and not current:IsA("LayerCollector") do
		if current:IsA("GuiObject") and not current.Visible then
			return string.format("%s has Visible = false", Path.of(current))
		end
		current = current.Parent
	end

	if current ~= nil and current:IsA("LayerCollector") and not current.Enabled then
		return string.format("%s has Enabled = false", Path.of(current))
	end

	if current == nil then
		return string.format("%s is not inside a ScreenGui or SurfaceGui", Path.of(instance))
	end

	return nil
end

local function textOf(instance: Instance): string?
	if not instance:IsA("GuiObject") then
		return nil
	end

	local ok, text = pcall(function()
		return (instance :: any).Text
	end)

	return ok and type(text) == "string" and text or nil
end

local function findByText(scope: Instance, needle: string): { Instance }
	local wanted = string.lower(needle)
	local matches = {}

	for _, instance in ipairs(scope:GetDescendants()) do
		local text = textOf(instance)
		if text ~= nil and string.find(string.lower(text), wanted, 1, true) ~= nil then
			if visibilityProblem(instance) == nil then
				table.insert(matches, instance)
			end
		end
	end

	-- Buttons first: when a label and a button share text, the button is what
	-- the user would have clicked.
	table.sort(matches, function(left, right)
		local leftIsButton = left:IsA("GuiButton")
		local rightIsButton = right:IsA("GuiButton")
		if leftIsButton ~= rightIsButton then
			return leftIsButton
		end
		return left:GetFullName() < right:GetFullName()
	end)

	return matches
end

--[[
	Converts a GuiObject's layout box into viewport pixels.

	AbsolutePosition on a ScreenGui that respects the top bar is measured inside
	the inset, while mouse events are not, so the inset has to be added back or
	every click lands slightly high.
]]
local function centerOf(instance: GuiObject): (number, number)
	local position = instance.AbsolutePosition
	local size = instance.AbsoluteSize

	local x = position.X + size.X / 2
	local y = position.Y + size.Y / 2

	local layer = instance:FindFirstAncestorWhichIsA("LayerCollector")
	local ignoresInset = false

	if layer ~= nil then
		local ok, value = pcall(function()
			return (layer :: any).IgnoreGuiInset
		end)
		ignoresInset = ok and value == true
	end

	if not ignoresInset then
		local inset = InputBridge.guiInset()
		x += inset.X
		y += inset.Y
	end

	return x, y
end

function InputOps.guiClick(params: any): any
	local target: Instance
	local otherMatches = {}

	if params.target ~= nil then
		target = Handles.resolve(params.target)
	else
		local scope = params.scope and Handles.resolve(params.scope) or guiRoot()
		local matches = findByText(scope, params.text)

		if #matches == 0 then
			Errors.throw(
				"TARGET_NOT_FOUND",
				string.format("No visible GUI element contains the text %q", params.text),
				{ scope = Path.of(scope) },
				"Inspect the GUI tree to check the element exists and is visible, or click it by handle."
			)
		end

		target = matches[1]
		for index = 2, #matches do
			table.insert(otherMatches, Handles.describe(matches[index]))
		end
	end

	if not target:IsA("GuiObject") then
		Errors.throw(
			"INVALID_PARAMS",
			string.format("%s is a %s, which cannot be clicked as a GUI element", Path.of(target), target.ClassName),
			nil,
			"Use input.mouse with viewport coordinates for world objects."
		)
	end

	local gui = target :: GuiObject
	local problem = visibilityProblem(target)
	if problem ~= nil then
		Errors.throw(
			"INPUT_FAILED",
			string.format("%s is not visible on screen: %s", Path.of(target), problem),
			{ reason = problem },
			"Make the element visible first, then click it."
		)
	end

	if gui.AbsoluteSize.X <= 0 or gui.AbsoluteSize.Y <= 0 then
		Errors.throw(
			"INPUT_FAILED",
			string.format("%s has zero size on screen", Path.of(target)),
			{ absoluteSize = { x = gui.AbsoluteSize.X, y = gui.AbsoluteSize.Y } }
		)
	end

	local x, y = centerOf(gui)
	InputBridge.clickAt(x, y, params.button or "left")

	-- Give the game a frame to react before the agent inspects the result.
	task.wait(0.1)

	return {
		clicked = Handles.describe(target),
		position = { x = x, y = y },
		otherMatches = otherMatches,
	}
end

function InputOps.viewportInfo(): any
	local camera = workspace.CurrentCamera
	local viewport = InputBridge.viewportSize()
	local inset = InputBridge.guiInset()

	local cameraInfo = nil
	if camera ~= nil then
		local cframe = camera.CFrame
		cameraInfo = {
			position = { cframe.Position.X, cframe.Position.Y, cframe.Position.Z },
			lookVector = { cframe.LookVector.X, cframe.LookVector.Y, cframe.LookVector.Z },
			fieldOfView = camera.FieldOfView,
			cameraType = camera.CameraType.Name,
		}
	end

	return {
		viewportSize = { x = viewport.X, y = viewport.Y },
		guiInset = { x = inset.X, y = inset.Y },
		camera = cameraInfo,
		realm = RunState.current().realm,
	}
end

return InputOps
