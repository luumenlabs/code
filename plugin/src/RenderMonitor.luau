--!nonstrict
--[[
	Is this Studio window drawing?

	A minimized window suspends rendering and input while scripts keep running,
	so input silently does nothing and CaptureService never fires its callback.
	Heartbeat keeps firing throughout and is no use as a signal; RenderStepped
	stops, so frame freshness is what this reports.
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
