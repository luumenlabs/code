--!nonstrict
--[[
	The on-screen interface as structure, with rectangles in the same viewport
	pixels input.mouse takes.

	Clickability comes from GetGuiObjectsAtPosition — the engine's own hit test
	in its own render order — not from comparing rectangles and ZIndex. An
	element covered by a transparent frame is otherwise indistinguishable from
	one that works.
]]

local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")

local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local InputBridge = require(script.Parent.Parent.InputBridge)
local Path = require(script.Parent.Parent.Path)
local RunState = require(script.Parent.Parent.RunState)

local ScreenOps = {}

--[[
	Where to read from when the caller does not say: PlayerGui during a playtest,
	StarterGui in edit mode. Those are not the same thing, so the result names
	which one it read.
]]
local function defaultRoot(): Instance
	local localPlayer = Players.LocalPlayer

	if localPlayer ~= nil then
		local playerGui = localPlayer:FindFirstChildOfClass("PlayerGui")
		if playerGui ~= nil then
			return playerGui
		end
	end

	if RunState.isRunning() and RunService:IsServer() and not RunService:IsClient() then
		Errors.throw(
			"RUNTIME_CONTEXT_UNAVAILABLE",
			"The server DataModel has no on-screen interface to read",
			{ realm = RunState.current().realm },
			'Read the GUI from the client instead, or start the playtest with mode "play".'
		)
	end

	return StarterGui
end

local function textOf(instance: Instance): string?
	if not instance:IsA("GuiObject") then
		return nil
	end

	local ok, text = pcall(function()
		return (instance :: any).Text
	end)

	if ok and type(text) == "string" and #text > 0 then
		return text
	end

	return nil
end

--[[
	Visible in the sense the user means: this element and every ancestor up to the
	ScreenGui agree. A hidden parent is almost always the real reason.
]]
local function effectivelyVisible(instance: GuiObject): boolean
	local current: Instance? = instance

	while current ~= nil do
		if current:IsA("GuiObject") and not current.Visible then
			return false
		end

		if current:IsA("LayerCollector") then
			return current.Enabled
		end

		current = current.Parent
	end

	-- Reached the DataModel without passing a ScreenGui: not on screen at all.
	return false
end

--[[
	Where the element is, in the coordinates a click uses. AbsolutePosition is
	measured inside the GUI inset and mouse events are not, so it is added back.
]]
local function rectOf(instance: GuiObject, inset: Vector2): any
	local position = instance.AbsolutePosition
	local size = instance.AbsoluteSize

	local layer = instance:FindFirstAncestorWhichIsA("LayerCollector")
	local ignoresInset = false

	if layer ~= nil then
		local ok, value = pcall(function()
			return (layer :: any).IgnoreGuiInset
		end)
		ignoresInset = ok and value == true
	end

	local offset = ignoresInset and Vector2.new(0, 0) or inset

	return {
		x = position.X + offset.X,
		y = position.Y + offset.Y,
		width = size.X,
		height = size.Y,
	}
end

--[[
	Asks the engine what is on top at a point. Only PlayerGui offers this, so nil
	in edit mode — a guess from rectangles would be trusted as much as the real
	answer and wrong in exactly the cases that matter.
]]
local function hitTester(): ((number, number) -> { Instance })?
	local localPlayer = Players.LocalPlayer
	if localPlayer == nil then
		return nil
	end

	local playerGui = localPlayer:FindFirstChildOfClass("PlayerGui")
	if playerGui == nil then
		return nil
	end

	return function(x: number, y: number): { Instance }
		local ok, hits = pcall(function()
			return (playerGui :: any):GetGuiObjectsAtPosition(x, y)
		end)
		return ok and hits or {}
	end
end

function ScreenOps.tree(params: any): any
	local root = params.scope and Handles.resolve(params.scope) or defaultRoot()
	local visibleOnly = params.visibleOnly ~= false
	local interactiveOnly = params.interactiveOnly == true
	local maxDepth = params.maxDepth or 12
	local maxNodes = params.maxNodes or 400

	local viewport = InputBridge.viewportSize()
	local inset = InputBridge.guiInset()
	local hitTest = hitTester()

	local nodes = {}
	local truncated = false

	local function walk(instance: Instance, depth: number)
		if truncated or depth > maxDepth then
			return
		end

		for _, child in ipairs(instance:GetChildren()) do
			if #nodes >= maxNodes then
				truncated = true
				return
			end

			if child:IsA("GuiObject") then
				local gui = child :: GuiObject
				local visible = effectivelyVisible(gui)

				if visible or not visibleOnly then
					local rect = rectOf(gui, inset)
					local clickable = false
					local obscuredBy = nil

					-- A zero-sized element cannot be hit whatever is in front of
					-- it, and asking the engine about a degenerate point wastes
					-- the call.
					if visible and rect.width > 0 and rect.height > 0 and hitTest ~= nil then
						local hits = hitTest(rect.x + rect.width / 2, rect.y + rect.height / 2)
						local front = hits[1]

						if front == gui then
							clickable = true
						elseif front ~= nil then
							-- The engine returns front to back, so the first entry
							-- is what a click would actually reach.
							obscuredBy = Path.of(front)
							clickable = false
						end
					end

					if not interactiveOnly or clickable then
						local ref = Handles.describe(gui)

						table.insert(nodes, {
							handle = ref.handle,
							path = ref.path,
							name = gui.Name,
							className = gui.ClassName,
							depth = depth,
							rect = rect,
							text = textOf(gui),
							zIndex = gui.ZIndex,
							visible = visible,
							clickable = clickable,
							obscuredBy = obscuredBy,
						})
					end
				end

				-- Descended into even when the element itself was filtered out:
				-- a container is usually not interesting and its contents always
				-- are, and an invisible parent has already excluded its children
				-- through effectivelyVisible.
				walk(child, depth + 1)
			elseif child:IsA("LayerCollector") or child:IsA("Folder") then
				walk(child, depth)
			end
		end
	end

	walk(root, 1)

	return {
		nodes = nodes,
		root = Handles.describe(root),
		viewportSize = { x = viewport.X, y = viewport.Y },
		realm = RunState.current().realm,
		truncated = truncated,
		-- Named so an empty result in edit mode is not read as "there is no UI".
		hitTested = hitTest ~= nil,
		guiInset = { x = inset.X, y = inset.Y },
	}
end

function ScreenOps.isAvailable(): boolean
	local ok = pcall(function()
		return GuiService ~= nil
	end)
	return ok
end

return ScreenOps
