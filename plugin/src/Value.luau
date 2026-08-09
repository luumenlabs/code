--!nonstrict
--[[
	Conversion between Roblox values and the JSON shape defined in
	packages/protocol/src/value.ts.

	Primitives pass straight through. Everything else is tagged with "$t" and
	carries the arguments needed to rebuild it, so a value read by an agent can
	be written back without extra context.
]]

local Errors = require(script.Parent.Errors)

local Value = {}

local NIL = { ["$t"] = "Nil" }

Value.NIL = NIL

local function round(n: number): number
	-- Keeps JSON small and stable without meaningfully changing a Roblox value.
	if n ~= n or n == math.huge or n == -math.huge then
		return 0
	end
	return math.floor(n * 10000 + 0.5) / 10000
end

local function color3ToHex(color: Color3): string
	return string.format("#%02X%02X%02X", math.floor(color.R * 255 + 0.5), math.floor(color.G * 255 + 0.5), math.floor(color.B * 255 + 0.5))
end

--[[
	Encodes a Roblox value. `pathOf` resolves an Instance to a stable path and
	`refOf` to a handle; both are injected so this module stays independent of
	the handle registry.
]]
function Value.encode(value: any, refOf: ((Instance) -> string)?, pathOf: ((Instance) -> string)?): any
	local kind = typeof(value)

	if value == nil then
		return NIL
	elseif kind == "boolean" or kind == "string" then
		return value
	elseif kind == "number" then
		-- JSON has no NaN or Infinity; report them as text rather than corrupting the payload.
		if value ~= value or value == math.huge or value == -math.huge then
			return { ["$t"] = "Opaque", typeName = "number", text = tostring(value) }
		end
		return value
	elseif kind == "Vector3" then
		return { ["$t"] = "Vector3", x = round(value.X), y = round(value.Y), z = round(value.Z) }
	elseif kind == "Vector2" then
		return { ["$t"] = "Vector2", x = round(value.X), y = round(value.Y) }
	elseif kind == "Vector3int16" then
		return { ["$t"] = "Vector3int16", x = value.X, y = value.Y, z = value.Z }
	elseif kind == "Vector2int16" then
		return { ["$t"] = "Vector2int16", x = value.X, y = value.Y }
	elseif kind == "CFrame" then
		local rx, ry, rz = value:ToOrientation()
		return {
			["$t"] = "CFrame",
			position = { round(value.Position.X), round(value.Position.Y), round(value.Position.Z) },
			orientation = { round(math.deg(rx)), round(math.deg(ry)), round(math.deg(rz)) },
		}
	elseif kind == "UDim" then
		return { ["$t"] = "UDim", scale = round(value.Scale), offset = value.Offset }
	elseif kind == "UDim2" then
		return {
			["$t"] = "UDim2",
			x = { scale = round(value.X.Scale), offset = value.X.Offset },
			y = { scale = round(value.Y.Scale), offset = value.Y.Offset },
		}
	elseif kind == "Color3" then
		return { ["$t"] = "Color3", r = round(value.R), g = round(value.G), b = round(value.B), hex = color3ToHex(value) }
	elseif kind == "BrickColor" then
		return { ["$t"] = "BrickColor", name = value.Name, number = value.Number }
	elseif kind == "Rect" then
		return {
			["$t"] = "Rect",
			min = { round(value.Min.X), round(value.Min.Y) },
			max = { round(value.Max.X), round(value.Max.Y) },
		}
	elseif kind == "NumberRange" then
		return { ["$t"] = "NumberRange", min = round(value.Min), max = round(value.Max) }
	elseif kind == "NumberSequence" then
		local keypoints = {}
		for _, keypoint in ipairs(value.Keypoints) do
			table.insert(keypoints, { time = round(keypoint.Time), value = round(keypoint.Value), envelope = round(keypoint.Envelope) })
		end
		return { ["$t"] = "NumberSequence", keypoints = keypoints }
	elseif kind == "ColorSequence" then
		local keypoints = {}
		for _, keypoint in ipairs(value.Keypoints) do
			table.insert(keypoints, {
				time = round(keypoint.Time),
				color = { r = round(keypoint.Value.R), g = round(keypoint.Value.G), b = round(keypoint.Value.B) },
			})
		end
		return { ["$t"] = "ColorSequence", keypoints = keypoints }
	elseif kind == "Font" then
		return { ["$t"] = "Font", family = value.Family, weight = value.Weight.Name, style = value.Style.Name }
	elseif kind == "EnumItem" then
		return { ["$t"] = "Enum", enum = tostring(value.EnumType), name = value.Name, value = value.Value }
	elseif kind == "Enum" then
		return { ["$t"] = "Opaque", typeName = "Enum", text = tostring(value) }
	elseif kind == "Instance" then
		return {
			["$t"] = "Instance",
			ref = refOf and refOf(value) or nil,
			path = pathOf and pathOf(value) or value:GetFullName(),
			className = value.ClassName,
		}
	elseif kind == "PhysicalProperties" then
		return {
			["$t"] = "PhysicalProperties",
			density = round(value.Density),
			friction = round(value.Friction),
			elasticity = round(value.Elasticity),
			frictionWeight = round(value.FrictionWeight),
			elasticityWeight = round(value.ElasticityWeight),
		}
	elseif kind == "Axes" then
		return { ["$t"] = "Axes", x = value.X, y = value.Y, z = value.Z }
	elseif kind == "Faces" then
		return {
			["$t"] = "Faces",
			top = value.Top,
			bottom = value.Bottom,
			left = value.Left,
			right = value.Right,
			back = value.Back,
			front = value.Front,
		}
	elseif kind == "Ray" then
		return {
			["$t"] = "Ray",
			origin = { round(value.Origin.X), round(value.Origin.Y), round(value.Origin.Z) },
			direction = { round(value.Direction.X), round(value.Direction.Y), round(value.Direction.Z) },
		}
	elseif kind == "Region3" then
		local min = value.CFrame.Position - value.Size / 2
		local max = value.CFrame.Position + value.Size / 2
		return {
			["$t"] = "Region3",
			min = { round(min.X), round(min.Y), round(min.Z) },
			max = { round(max.X), round(max.Y), round(max.Z) },
		}
	elseif kind == "table" then
		-- Arrays stay arrays; anything else becomes an object with string keys.
		local isArray = true
		local count = 0
		for key in pairs(value) do
			count += 1
			if type(key) ~= "number" then
				isArray = false
			end
		end

		if isArray and count == #value then
			local encoded = {}
			for index, entry in ipairs(value) do
				encoded[index] = Value.encode(entry, refOf, pathOf)
			end
			return encoded
		end

		local encoded = {}
		for key, entry in pairs(value) do
			encoded[tostring(key)] = Value.encode(entry, refOf, pathOf)
		end
		return encoded
	end

	return { ["$t"] = "Opaque", typeName = kind, text = tostring(value) }
end

local function expectNumber(container: any, key: string, context: string): number
	local raw = container[key]
	if type(raw) ~= "number" then
		Errors.throw("INVALID_PARAMS", string.format("%s expects a number for %q", context, key))
	end
	return raw
end

local function toVector3(container: any, key: string, context: string): Vector3
	local raw = container[key]
	if type(raw) ~= "table" or #raw < 3 then
		Errors.throw("INVALID_PARAMS", string.format("%s expects %q to be [x, y, z]", context, key))
	end
	return Vector3.new(raw[1], raw[2], raw[3])
end

--[[
	Decodes a JSON value into a Roblox value.

	`resolve` turns an instance reference (handle or path) back into an
	Instance; it is injected by the command layer so decoding stays usable in
	tests without a live DataModel.
]]
function Value.decode(value: any, resolve: ((string) -> Instance)?): any
	local kind = type(value)

	if value == nil then
		return nil
	elseif kind == "boolean" or kind == "string" or kind == "number" then
		return value
	elseif kind ~= "table" then
		Errors.throw("INVALID_PARAMS", "Unsupported value of type " .. kind)
	end

	local tag = value["$t"]

	if tag == nil then
		local decoded = {}
		if #value > 0 then
			for index, entry in ipairs(value) do
				decoded[index] = Value.decode(entry, resolve)
			end
		else
			for key, entry in pairs(value) do
				decoded[key] = Value.decode(entry, resolve)
			end
		end
		return decoded
	end

	if tag == "Nil" then
		return nil
	elseif tag == "Vector3" then
		return Vector3.new(expectNumber(value, "x", "Vector3"), expectNumber(value, "y", "Vector3"), expectNumber(value, "z", "Vector3"))
	elseif tag == "Vector2" then
		return Vector2.new(expectNumber(value, "x", "Vector2"), expectNumber(value, "y", "Vector2"))
	elseif tag == "Vector3int16" then
		return Vector3int16.new(value.x, value.y, value.z)
	elseif tag == "Vector2int16" then
		return Vector2int16.new(value.x, value.y)
	elseif tag == "CFrame" then
		local position = toVector3(value, "position", "CFrame")
		local orientation = value.orientation
		if type(orientation) == "table" and #orientation >= 3 then
			return CFrame.new(position)
				* CFrame.fromOrientation(math.rad(orientation[1]), math.rad(orientation[2]), math.rad(orientation[3]))
		end
		return CFrame.new(position)
	elseif tag == "UDim" then
		return UDim.new(expectNumber(value, "scale", "UDim"), expectNumber(value, "offset", "UDim"))
	elseif tag == "UDim2" then
		local x, y = value.x, value.y
		if type(x) ~= "table" or type(y) ~= "table" then
			Errors.throw("INVALID_PARAMS", "UDim2 expects x and y objects with scale and offset")
		end
		return UDim2.new(x.scale, x.offset, y.scale, y.offset)
	elseif tag == "Color3" then
		if type(value.hex) == "string" and value.r == nil then
			return Color3.fromHex(value.hex)
		end
		return Color3.new(expectNumber(value, "r", "Color3"), expectNumber(value, "g", "Color3"), expectNumber(value, "b", "Color3"))
	elseif tag == "BrickColor" then
		return BrickColor.new(value.name)
	elseif tag == "Rect" then
		local min, max = value.min, value.max
		return Rect.new(min[1], min[2], max[1], max[2])
	elseif tag == "NumberRange" then
		return NumberRange.new(expectNumber(value, "min", "NumberRange"), expectNumber(value, "max", "NumberRange"))
	elseif tag == "NumberSequence" then
		local keypoints = {}
		for _, keypoint in ipairs(value.keypoints or {}) do
			table.insert(keypoints, NumberSequenceKeypoint.new(keypoint.time, keypoint.value, keypoint.envelope or 0))
		end
		return NumberSequence.new(keypoints)
	elseif tag == "ColorSequence" then
		local keypoints = {}
		for _, keypoint in ipairs(value.keypoints or {}) do
			local color = keypoint.color
			table.insert(keypoints, ColorSequenceKeypoint.new(keypoint.time, Color3.new(color.r, color.g, color.b)))
		end
		return ColorSequence.new(keypoints)
	elseif tag == "Font" then
		local weight = Enum.FontWeight[value.weight] or Enum.FontWeight.Regular
		local style = Enum.FontStyle[value.style] or Enum.FontStyle.Normal
		return Font.new(value.family, weight, style)
	elseif tag == "Enum" then
		local enumType = (Enum :: any)[value.enum]
		if enumType == nil then
			Errors.throw("INVALID_PARAMS", string.format("Unknown enum %q", tostring(value.enum)))
		end
		local ok, item = pcall(function()
			return enumType[value.name]
		end)
		if not ok or item == nil then
			Errors.throw("INVALID_PARAMS", string.format("Unknown value %q on Enum.%s", tostring(value.name), tostring(value.enum)))
		end
		return item
	elseif tag == "Instance" then
		local reference = value.ref or value.path
		if reference == nil then
			return nil
		end
		if resolve == nil then
			Errors.throw("INTERNAL", "Instance values cannot be decoded without a resolver")
			return nil
		end
		return resolve(reference)
	elseif tag == "PhysicalProperties" then
		return PhysicalProperties.new(
			value.density,
			value.friction,
			value.elasticity,
			value.frictionWeight or 1,
			value.elasticityWeight or 1
		)
	elseif tag == "Axes" then
		local axes = {}
		if value.x then
			table.insert(axes, Enum.Axis.X)
		end
		if value.y then
			table.insert(axes, Enum.Axis.Y)
		end
		if value.z then
			table.insert(axes, Enum.Axis.Z)
		end
		return Axes.new(table.unpack(axes))
	elseif tag == "Faces" then
		local faces = {}
		local mapping = {
			top = Enum.NormalId.Top,
			bottom = Enum.NormalId.Bottom,
			left = Enum.NormalId.Left,
			right = Enum.NormalId.Right,
			back = Enum.NormalId.Back,
			front = Enum.NormalId.Front,
		}
		for key, normal in pairs(mapping) do
			if value[key] then
				table.insert(faces, normal)
			end
		end
		return Faces.new(table.unpack(faces))
	elseif tag == "Ray" then
		return Ray.new(toVector3(value, "origin", "Ray"), toVector3(value, "direction", "Ray"))
	elseif tag == "Region3" then
		return Region3.new(toVector3(value, "min", "Region3"), toVector3(value, "max", "Region3"))
	elseif tag == "Opaque" then
		Errors.throw(
			"INVALID_PARAMS",
			string.format("Values of type %s are read-only and cannot be written back", tostring(value.typeName))
		)
	end

	Errors.throw("INVALID_PARAMS", string.format("Unknown value tag %q", tostring(tag)))
	return nil
end

return Value
