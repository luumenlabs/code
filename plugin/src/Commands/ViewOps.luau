--!nonstrict
--[[
	The viewport: where the camera points, and what is marked in it.

	Neither touches the place. The camera belongs to the session, and adornments
	go in CoreGui with the target as Adornee — so nothing is saved with the place
	and nothing needs a change record.
]]

local CoreGui = game:GetService("CoreGui")
local Selection = game:GetService("Selection")

local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local Path = require(script.Parent.Parent.Path)

local ViewOps = {}

local CONTAINER_NAME = "LuuCodeViewMarks"
local DEFAULT_COLOR = Color3.fromRGB(43, 127, 255)

--[[
	Where the camera was before the agent moved it. Only the first position taken
	over is kept, so restore means "back where I had it", not "back one step".
]]
local userCamera: CFrame? = nil

local function camera(): Camera
	local current = workspace.CurrentCamera

	if current == nil then
		Errors.throw(
			"RUNTIME_CONTEXT_UNAVAILABLE",
			"This DataModel has no camera",
			nil,
			"The server DataModel of a playtest does not render. Ask the client instead."
		)
	end

	return current
end

local function cameraState(): any
	local current = camera()
	local cframe = current.CFrame

	return {
		position = { cframe.Position.X, cframe.Position.Y, cframe.Position.Z },
		lookVector = { cframe.LookVector.X, cframe.LookVector.Y, cframe.LookVector.Z },
		fieldOfView = current.FieldOfView,
	}
end

--[[
	The box an instance occupies. A Model knows its own; a part is its own;
	anything else is measured from the parts underneath it.
]]
local function boundsOf(instance: Instance): (CFrame, Vector3)
	if instance:IsA("Model") then
		local ok, cframe, size = pcall(function()
			return instance:GetBoundingBox()
		end)
		if ok and cframe ~= nil then
			return cframe, size
		end
	end

	if instance:IsA("BasePart") then
		return instance.CFrame, instance.Size
	end

	local minimum: Vector3? = nil
	local maximum: Vector3? = nil

	for _, descendant in ipairs(instance:GetDescendants()) do
		if descendant:IsA("BasePart") then
			local half = descendant.Size / 2
			local position = descendant.Position
			local low = position - half
			local high = position + half

			minimum = minimum and minimum:Min(low) or low
			maximum = maximum and maximum:Max(high) or high
		end
	end

	if minimum == nil or maximum == nil then
		Errors.throw(
			"INVALID_PARAMS",
			string.format("%s has nothing in the world to look at", Path.of(instance)),
			{ className = instance.ClassName },
			"Frame a Model or a part. GUI elements are not in the 3D world; read them with view.gui instead."
		)
	end

	-- Rebound because the analyser does not carry the nil check above through the
	-- throw, and an assertion at the point of use reads as a doubt about the
	-- check rather than about the tooling.
	local least = minimum :: Vector3
	local greatest = maximum :: Vector3

	return CFrame.new((least + greatest) / 2), greatest - least
end

--[[
	Unit directions to look *from*. "iso" is the default because a flat elevation
	shows no depth.
]]
local DIRECTIONS = {
	front = Vector3.new(0, 0, 1),
	back = Vector3.new(0, 0, -1),
	left = Vector3.new(-1, 0, 0),
	right = Vector3.new(1, 0, 0),
	top = Vector3.new(0, 1, 0.001),
	iso = Vector3.new(1, 0.8, 1),
}

function ViewOps.focus(params: any): any
	local current = camera()

	if params.restore then
		if userCamera == nil then
			return { camera = cameraState(), framed = nil, canRestore = false }
		end

		current.CFrame = userCamera
		userCamera = nil
		return { camera = cameraState(), framed = nil, canRestore = false }
	end

	local target: Instance

	if params.target ~= nil then
		target = Handles.resolve(params.target)
	else
		local selected = Selection:Get()
		if #selected == 0 then
			Errors.throw(
				"INVALID_PARAMS",
				"Nothing to frame: no target was given and nothing is selected in Studio",
				nil,
				"Pass a target, or select something in Studio first."
			)
		end
		target = selected[1]
	end

	local pivot, size = boundsOf(target)

	-- Recorded before the first move only, so restore goes back to the user's
	-- own view rather than to wherever the agent last pointed it.
	if userCamera == nil then
		userCamera = current.CFrame
	end

	local direction = (DIRECTIONS[params.angle or "iso"] or DIRECTIONS.iso).Unit
	local radius = math.max(size.Magnitude / 2, 1)

	-- Far enough back that the whole sphere around the subject fits the vertical
	-- field of view, then padded. Using the bounding sphere rather than the box
	-- means the framing does not depend on which way the subject is turned.
	local halfFov = math.rad(current.FieldOfView / 2)
	local distance = (radius / math.tan(halfFov)) * (params.padding or 1.4)

	current.CFrame = CFrame.lookAt(pivot.Position + direction * distance, pivot.Position)

	return {
		camera = cameraState(),
		framed = Handles.describe(target),
		canRestore = userCamera ~= nil,
	}
end

-- ---------------------------------------------------------------------------
-- Marks
-- ---------------------------------------------------------------------------

local function container(): Folder
	local existing = CoreGui:FindFirstChild(CONTAINER_NAME)

	if existing ~= nil then
		return existing
	end

	local folder = Instance.new("Folder")
	folder.Name = CONTAINER_NAME
	folder.Archivable = false
	folder.Parent = CoreGui
	return folder
end

local function clearMarks(): number
	local folder = CoreGui:FindFirstChild(CONTAINER_NAME)
	if folder == nil then
		return 0
	end

	local count = #folder:GetChildren()
	folder:Destroy()
	return count
end

--[[
	Marks are numbered so a later call can tell its own from an earlier one's,
	and so the auto-clear timer can decline to remove marks that have since been
	replaced by a newer set.
]]
local generation = 0

local function parseColor(value: string?): Color3
	if type(value) ~= "string" then
		return DEFAULT_COLOR
	end

	local hex = string.gsub(value, "^#", "")
	if #hex ~= 6 then
		Errors.throw("INVALID_PARAMS", string.format("%q is not a six-digit hex colour", value), nil, 'Use a value like "#2b7fff".')
	end

	local red = tonumber(string.sub(hex, 1, 2), 16)
	local green = tonumber(string.sub(hex, 3, 4), 16)
	local blue = tonumber(string.sub(hex, 5, 6), 16)

	if red == nil or green == nil or blue == nil then
		Errors.throw("INVALID_PARAMS", string.format("%q is not a six-digit hex colour", value), nil, 'Use a value like "#2b7fff".')
	end

	return Color3.fromRGB(red, green, blue)
end

function ViewOps.highlight(params: any): any
	local targets = params.targets or {}

	if #targets == 0 then
		return { marked = {}, cleared = clearMarks() }
	end

	clearMarks()
	generation += 1
	local mine = generation

	local folder = container()
	local color = parseColor(params.color)
	local marked = {}

	for index, reference in ipairs(targets) do
		local instance = Handles.resolve(reference)

		local highlight = Instance.new("Highlight")
		highlight.Adornee = instance
		highlight.FillColor = color
		highlight.OutlineColor = color
		highlight.FillTransparency = 0.75
		highlight.OutlineTransparency = 0
		-- Drawn through whatever is in front, because the thing worth pointing
		-- at is very often the thing behind something else.
		highlight.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop
		highlight.Archivable = false
		highlight.Parent = folder

		if index == 1 and type(params.label) == "string" and #params.label > 0 then
			local billboard = Instance.new("BillboardGui")
			billboard.Adornee = instance:IsA("BasePart") and instance or instance:FindFirstChildWhichIsA("BasePart", true)
			billboard.Size = UDim2.fromOffset(220, 28)
			billboard.StudsOffset = Vector3.new(0, 3, 0)
			billboard.AlwaysOnTop = true
			billboard.Archivable = false

			local text = Instance.new("TextLabel")
			text.Size = UDim2.fromScale(1, 1)
			text.BackgroundColor3 = Color3.fromRGB(10, 10, 10)
			text.BackgroundTransparency = 0.15
			text.TextColor3 = Color3.fromRGB(242, 242, 242)
			text.TextSize = 14
			text.Font = Enum.Font.GothamMedium
			text.Text = params.label
			text.Parent = billboard

			local corner = Instance.new("UICorner")
			corner.CornerRadius = UDim.new(0, 6)
			corner.Parent = text

			if billboard.Adornee ~= nil then
				billboard.Parent = folder
			else
				billboard:Destroy()
			end
		end

		table.insert(marked, Handles.describe(instance))
	end

	local after = params.clearAfterMs or 0
	if after > 0 then
		task.delay(after / 1000, function()
			-- Only clears its own marks: a later call has already replaced these,
			-- and wiping the newer set would be this timer undoing someone else's
			-- work seconds after it landed.
			if generation == mine then
				clearMarks()
			end
		end)
	end

	return { marked = marked, cleared = 0 }
end

--[[
	Called when the plugin is unloading and when a playtest ends, so marks do not
	outlive the thing they were pointing at.
]]
function ViewOps.release()
	clearMarks()
	userCamera = nil
end

function ViewOps.isAvailable(): boolean
	return workspace.CurrentCamera ~= nil
end

return ViewOps
