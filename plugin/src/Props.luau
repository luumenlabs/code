--!nonstrict
--[[
	Which properties to read when the agent does not name any.

	Roblox exposes no property reflection to Luau, so "read the relevant
	properties" has to mean a curated set. The table below is keyed by base
	class and accumulated through IsA, which keeps it small while still
	covering the instances agents actually work with. Anything missing is still
	reachable: pass explicit names to dm.properties.
]]

local Props = {}

-- Ordered so more general classes are applied first and specific ones last.
local SETS: { { className: string, properties: { string } } } = {
	{ className = "Instance", properties = { "Name", "Archivable" } },

	{
		className = "BasePart",
		properties = {
			"Position",
			"Size",
			"Orientation",
			"CFrame",
			"Anchored",
			"CanCollide",
			"CanTouch",
			"CanQuery",
			"Transparency",
			"Color",
			"Material",
			"Reflectance",
			"CastShadow",
			"Massless",
			"CollisionGroup",
			"AssemblyLinearVelocity",
		},
	},
	{ className = "Part", properties = { "Shape" } },
	{ className = "MeshPart", properties = { "MeshId", "TextureID", "DoubleSided" } },
	{ className = "SpawnLocation", properties = { "Enabled", "Neutral", "TeamColor", "Duration" } },
	{ className = "Model", properties = { "PrimaryPart", "ModelStreamingMode" } },
	{ className = "Attachment", properties = { "Position", "CFrame", "WorldPosition", "Visible" } },
	{ className = "Decal", properties = { "Texture", "Transparency", "Face", "Color3" } },
	{ className = "Constraint", properties = { "Enabled", "Attachment0", "Attachment1" } },

	{
		className = "GuiObject",
		properties = {
			"Position",
			"Size",
			"AnchorPoint",
			"Visible",
			"BackgroundColor3",
			"BackgroundTransparency",
			"BorderSizePixel",
			"ZIndex",
			"Rotation",
			"ClipsDescendants",
			"LayoutOrder",
			"AutomaticSize",
			"AbsolutePosition",
			"AbsoluteSize",
			"Active",
		},
	},
	{
		className = "TextLabel",
		properties = {
			"Text",
			"TextColor3",
			"TextSize",
			"FontFace",
			"TextScaled",
			"TextWrapped",
			"TextXAlignment",
			"TextYAlignment",
			"RichText",
			"TextTransparency",
		},
	},
	{
		className = "TextButton",
		properties = {
			"Text",
			"TextColor3",
			"TextSize",
			"FontFace",
			"TextScaled",
			"TextWrapped",
			"TextXAlignment",
			"TextYAlignment",
			"AutoButtonColor",
		},
	},
	{
		className = "TextBox",
		properties = { "Text", "PlaceholderText", "TextColor3", "TextSize", "FontFace", "ClearTextOnFocus", "MultiLine" },
	},
	{ className = "ImageLabel", properties = { "Image", "ImageColor3", "ImageTransparency", "ScaleType", "SliceCenter" } },
	{ className = "ImageButton", properties = { "Image", "ImageColor3", "ImageTransparency", "ScaleType", "AutoButtonColor" } },
	{
		className = "ScrollingFrame",
		properties = { "CanvasSize", "CanvasPosition", "AutomaticCanvasSize", "ScrollBarThickness", "ScrollingDirection" },
	},
	{ className = "ScreenGui", properties = { "Enabled", "DisplayOrder", "IgnoreGuiInset", "ResetOnSpawn", "ZIndexBehavior" } },
	{ className = "BillboardGui", properties = { "Enabled", "Adornee", "Size", "StudsOffset", "AlwaysOnTop", "MaxDistance" } },
	{ className = "SurfaceGui", properties = { "Enabled", "Adornee", "Face", "CanvasSize", "PixelsPerStud", "AlwaysOnTop" } },
	{
		className = "UIListLayout",
		properties = { "FillDirection", "Padding", "SortOrder", "HorizontalAlignment", "VerticalAlignment", "Wraps" },
	},
	{ className = "UIGridLayout", properties = { "CellSize", "CellPadding", "FillDirection", "SortOrder", "StartCorner" } },
	{ className = "UIPadding", properties = { "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight" } },
	{ className = "UICorner", properties = { "CornerRadius" } },
	{ className = "UIStroke", properties = { "Color", "Thickness", "Transparency", "ApplyStrokeMode", "Enabled" } },
	{ className = "UIScale", properties = { "Scale" } },
	{ className = "UIAspectRatioConstraint", properties = { "AspectRatio", "AspectType", "DominantAxis" } },
	{ className = "UISizeConstraint", properties = { "MinSize", "MaxSize" } },
	{ className = "UIGradient", properties = { "Color", "Transparency", "Rotation", "Offset", "Enabled" } },

	{ className = "LuaSourceContainer", properties = {} },
	{ className = "Script", properties = { "Enabled", "RunContext" } },
	{ className = "LocalScript", properties = { "Enabled" } },

	{ className = "ValueBase", properties = { "Value" } },
	{
		className = "Humanoid",
		properties = {
			"Health",
			"MaxHealth",
			"WalkSpeed",
			"JumpPower",
			"JumpHeight",
			"HipHeight",
			"RigType",
			"MoveDirection",
			"FloorMaterial",
			"PlatformStand",
			"Sit",
		},
	},
	{ className = "Player", properties = { "UserId", "DisplayName", "Team", "TeamColor", "CharacterAppearanceId", "AccountAge" } },
	{ className = "Camera", properties = { "CFrame", "FieldOfView", "CameraType", "CameraSubject", "ViewportSize" } },
	{ className = "Light", properties = { "Brightness", "Color", "Enabled", "Shadows" } },
	{ className = "PointLight", properties = { "Range" } },
	{ className = "SpotLight", properties = { "Range", "Angle", "Face" } },
	{ className = "ParticleEmitter", properties = { "Enabled", "Rate", "Lifetime", "Speed", "Texture", "Color", "Size", "LightEmission" } },
	{ className = "Sound", properties = { "SoundId", "Volume", "Playing", "Looped", "TimePosition", "PlaybackSpeed", "IsLoaded" } },
	{ className = "Tool", properties = { "RequiresHandle", "CanBeDropped", "Enabled", "ToolTip", "Grip" } },
	{
		className = "ProximityPrompt",
		properties = { "ActionText", "ObjectText", "HoldDuration", "MaxActivationDistance", "Enabled", "KeyboardKeyCode" },
	},
	{ className = "ClickDetector", properties = { "MaxActivationDistance", "CursorIcon" } },
	{ className = "Beam", properties = { "Enabled", "Attachment0", "Attachment1", "Color", "Width0", "Width1", "Texture" } },
	{ className = "Trail", properties = { "Enabled", "Attachment0", "Attachment1", "Color", "Lifetime" } },
	{ className = "Animation", properties = { "AnimationId" } },
	{ className = "Team", properties = { "TeamColor", "AutoAssignable" } },
	{ className = "Highlight", properties = { "Enabled", "Adornee", "FillColor", "OutlineColor", "DepthMode" } },
}

--[[
	Returns the curated property list for an instance, most general first, with
	duplicates removed.
]]
function Props.defaultsFor(instance: Instance): { string }
	local names = {}
	local seen = {}

	for _, set in ipairs(SETS) do
		local ok, matches = pcall(function()
			return instance:IsA(set.className)
		end)

		if ok and matches then
			for _, property in ipairs(set.properties) do
				if not seen[property] then
					seen[property] = true
					table.insert(names, property)
				end
			end
		end
	end

	return names
end

--[[
	Reads properties, separating values we could read from the ones Roblox
	refused. The agent needs both: a missing property usually means the class
	changed, not that the value is nil.
]]
function Props.read(instance: Instance, names: { string }, encode: (any) -> any): ({ [string]: any }, { [string]: string })
	local values = {}
	local unreadable = {}

	for _, name in ipairs(names) do
		local ok, value = pcall(function()
			return (instance :: any)[name]
		end)

		if ok then
			-- Methods and events are callable members, not property values.
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

return Props
