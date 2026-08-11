--!nonstrict
--[[
	Is this Studio window actually drawing?

	A minimized or fully occluded Studio window suspends the render loop and,
	with it, input processing — while scripts keep running normally. That
	combination is the reason two whole families of operation used to fail
	silently: virtual input returned success having delivered nothing, and
	CaptureService's callback simply never fired, so a screenshot spent its
	entire timeout waiting for a frame that was not coming.

	Heartbeat is no use as a signal here, because it keeps firing at its usual
	rate throughout. RenderStepped is the one that stops, so the freshness of the
	last rendered frame is what this reports. A gap of a full second is far
	outside anything an ordinary frame hitch produces and well inside the point
	at which input stops arriving.
]]

local RunService = game:GetService("RunService")

local RenderMonitor = {}

local STALE_SECONDS = 1.0

local lastFrame = 0
local watching = false

--[[
	RenderStepped only exists where there is a render loop. Connecting it throws
	in a playtest's server DataModel, and that is not a fault: a server peer has
	no window of its own, so it has nothing to report and says so by leaving
	`watching` false. Everything below fails open on that, because a monitor that
	is not running must never be the reason an operation is refused.
]]
function RenderMonitor.start()
	if watching then
		return
	end

	local ok = pcall(function()
		RunService.RenderStepped:Connect(function()
			lastFrame = os.clock()
		end)
	end)

	if ok then
		watching = true
		lastFrame = os.clock()
	end
end

function RenderMonitor.isWatching(): boolean
	return watching
end

function RenderMonitor.secondsSinceFrame(): number
	if not watching then
		return 0
	end
	return os.clock() - lastFrame
end

function RenderMonitor.isRendering(): boolean
	return not watching or RenderMonitor.secondsSinceFrame() <= STALE_SECONDS
end

--[[
	The sentence to hand back when something needs frames and is not going to get
	any, or nil when there is no problem to report.
]]
function RenderMonitor.stallReason(): string?
	if RenderMonitor.isRendering() then
		return nil
	end

	return string.format(
		"The Roblox Studio window is not drawing (no frame for %.1fs), which usually means it is minimized. "
			.. "Input and viewport capture both need a rendering window.",
		RenderMonitor.secondsSinceFrame()
	)
end

return RenderMonitor
