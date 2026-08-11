--!nonstrict
--[[
	Viewport capture, from inside the engine. Spec sections 17 and 36.

	CaptureService renders what the experience is showing and nothing else — no
	ribbon, no Explorer, no window that happens to be in front — and it keeps
	working during a playtest, which is when a screenshot is worth taking at all.
	Both were impossible from the desktop capture this replaces.

	Two conditions have to hold, and both are reported by name rather than as a
	timeout:

	  * The window has to be drawing. CaptureScreenshot takes a callback and
	    simply never calls it when the window is minimized, so without the render
	    check this would spend its whole budget waiting for a frame that is not
	    coming.
	  * Reading the pixels back needs the place's Mesh/Image API permission,
	    because it goes through EditableImage. That is a Game Settings switch the
	    user has to throw, so the error says which one.

	Pixels leave here as raw RGBA. Encoding a PNG needs deflate, which Luau has
	no access to, and the server has zlib — so the split is where the tools are,
	not where the data starts.
]]

local AssetService = game:GetService("AssetService")
local CaptureService = game:GetService("CaptureService")

local Errors = require(script.Parent.Errors)
local RenderMonitor = require(script.Parent.RenderMonitor)
local RunState = require(script.Parent.RunState)

local Capture = {}

local CAPTURE_TIMEOUT_SECONDS = 10
-- ReadPixelsBuffer refuses a region beyond this on some backends, so a large
-- viewport is read as tiles and reassembled.
local MAX_TILE = 1024
local BYTES_PER_PIXEL = 4

local function requestScreenshot(): string
	local stalled = RenderMonitor.stallReason()
	if stalled ~= nil then
		Errors.throw(
			"SCREENSHOT_FAILED",
			stalled,
			{ rendering = false },
			'Restore the Studio window, or capture the desktop instead with source "window".'
		)
	end

	local contentId: string? = nil

	local ok, err = pcall(function()
		CaptureService:CaptureScreenshot(function(id: string)
			contentId = id
		end)
	end)

	if not ok then
		Errors.throw("SCREENSHOT_FAILED", string.format("CaptureService refused the capture: %s", tostring(err)))
	end

	local deadline = os.clock() + CAPTURE_TIMEOUT_SECONDS
	while contentId == nil do
		if os.clock() > deadline then
			Errors.throw(
				"SCREENSHOT_FAILED",
				string.format("CaptureService did not produce an image within %ds", CAPTURE_TIMEOUT_SECONDS),
				{ realm = RunState.current().realm },
				'The window may have been covered mid-capture. Try again, or use source "window".'
			)
		end
		task.wait(0.05)
	end

	return contentId :: string
end

--[[
	Promotes the capture into an EditableImage and reads it back.

	The scale is applied by drawing the source into a smaller image rather than
	by sending every pixel and shrinking on the far side: a 1440p viewport is
	over 8MB of RGBA, and it travels as base64 inside a JSON body.
]]
local function readPixels(contentId: string, maxWidth: number): (buffer, number, number)
	local ok, source = pcall(function()
		return AssetService:CreateEditableImageAsync(Content.fromUri(contentId))
	end)

	if not ok then
		Errors.throw(
			"SCREENSHOT_FAILED",
			string.format("The captured image could not be opened for reading: %s", tostring(source)),
			{ contentId = contentId },
			"This place has the Mesh/Image API turned off. Enable it under Game Settings → Security → Allow Mesh / Image APIs, "
				.. 'or capture the desktop instead with source "window".'
		)
	end

	local image = source :: any
	local width = math.floor(image.Size.X)
	local height = math.floor(image.Size.Y)
	local target = image
	local scaled = nil

	if maxWidth > 0 and width > maxWidth then
		local scale = maxWidth / width
		local targetWidth = math.max(1, math.floor(width * scale))
		local targetHeight = math.max(1, math.floor(height * scale))

		local resizeOk, resized = pcall(function()
			local canvas = AssetService:CreateEditableImage({ Size = Vector2.new(targetWidth, targetHeight) })
			canvas:DrawImageTransformed(
				Vector2.new(targetWidth / 2, targetHeight / 2),
				Vector2.new(scale, scale),
				0,
				image,
				{ CombineType = Enum.ImageCombineType.Overwrite }
			)
			return canvas
		end)

		-- A failed downscale is not a failed capture. The full-size image is
		-- still correct, only larger, so it is sent rather than discarded.
		if resizeOk and resized ~= nil then
			scaled = resized
			target = resized
			width = targetWidth
			height = targetHeight
		end
	end

	local readOk, pixels = pcall(function()
		local full = buffer.create(width * height * BYTES_PER_PIXEL)
		local rowBytes = width * BYTES_PER_PIXEL

		for tileY = 0, height - 1, MAX_TILE do
			local tileHeight = math.min(MAX_TILE, height - tileY)

			for tileX = 0, width - 1, MAX_TILE do
				local tileWidth = math.min(MAX_TILE, width - tileX)
				local tile = target:ReadPixelsBuffer(Vector2.new(tileX, tileY), Vector2.new(tileWidth, tileHeight))
				local tileRowBytes = tileWidth * BYTES_PER_PIXEL

				for row = 0, tileHeight - 1 do
					buffer.copy(full, (tileY + row) * rowBytes + tileX * BYTES_PER_PIXEL, tile, row * tileRowBytes, tileRowBytes)
				end
			end
		end

		return full
	end)

	pcall(function()
		image:Destroy()
	end)
	if scaled ~= nil then
		pcall(function()
			scaled:Destroy()
		end)
	end

	if not readOk then
		Errors.throw("SCREENSHOT_FAILED", string.format("The captured image could not be read: %s", tostring(pixels)))
	end

	return pixels, width, height
end

local BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local ALPHABET = table.create(64)
for index = 1, 64 do
	ALPHABET[index - 1] = string.byte(BASE64, index)
end
local PAD = string.byte("=")

--[[
	Base64 straight out of one buffer into another.

	The obvious version concatenates strings four characters at a time, which for
	a megapixel image is four million intermediate strings; this is the same
	transform with one allocation.
]]
local function encodeBase64(input: buffer): string
	local length = buffer.len(input)
	local triples = length // 3
	local remainder = length - triples * 3
	local output = buffer.create((triples + (remainder > 0 and 1 or 0)) * 4)

	local read = 0
	local write = 0

	for _ = 1, triples do
		local b0 = buffer.readu8(input, read)
		local b1 = buffer.readu8(input, read + 1)
		local b2 = buffer.readu8(input, read + 2)

		buffer.writeu8(output, write, ALPHABET[bit32.rshift(b0, 2)])
		buffer.writeu8(output, write + 1, ALPHABET[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))])
		buffer.writeu8(output, write + 2, ALPHABET[bit32.bor(bit32.lshift(bit32.band(b1, 15), 2), bit32.rshift(b2, 6))])
		buffer.writeu8(output, write + 3, ALPHABET[bit32.band(b2, 63)])

		read += 3
		write += 4
	end

	if remainder == 2 then
		local b0 = buffer.readu8(input, read)
		local b1 = buffer.readu8(input, read + 1)
		buffer.writeu8(output, write, ALPHABET[bit32.rshift(b0, 2)])
		buffer.writeu8(output, write + 1, ALPHABET[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))])
		buffer.writeu8(output, write + 2, ALPHABET[bit32.lshift(bit32.band(b1, 15), 2)])
		buffer.writeu8(output, write + 3, PAD)
	elseif remainder == 1 then
		local b0 = buffer.readu8(input, read)
		buffer.writeu8(output, write, ALPHABET[bit32.rshift(b0, 2)])
		buffer.writeu8(output, write + 1, ALPHABET[bit32.lshift(bit32.band(b0, 3), 4)])
		buffer.writeu8(output, write + 2, PAD)
		buffer.writeu8(output, write + 3, PAD)
	end

	return buffer.tostring(output)
end

function Capture.screenshot(params: any): any
	local contentId = requestScreenshot()
	local pixels, width, height = readPixels(contentId, params.maxWidth or 1280)

	return {
		pixels = encodeBase64(pixels),
		width = width,
		height = height,
		realm = RunState.current().realm,
	}
end

--[[
	Whether a capture could succeed here, without taking one.

	Only the cheap half is probed: whether this peer has a render loop at all.
	The Mesh/Image permission cannot be tested without actually capturing, so it
	is left to fail with its own message, which names the setting to change.
]]
function Capture.isAvailable(): boolean
	local ok, service = pcall(function()
		return game:GetService("CaptureService")
	end)

	return ok and service ~= nil and RenderMonitor.isWatching()
end

return Capture
