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
local connection: RBXScriptConnection? = nil

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
		connection = RunService.RenderStepped:Connect(function()
			lastFrame = os.clock()
		end)
	end)

	if ok then
		watching = true
		lastFrame = os.clock()
	end
end

--[[
	Starts the clock again, for a DataModel that has just been replaced.

	An edit/run transition hands the window to a different DataModel. The old
	connection may keep firing, may stop, or may have died with the world it
	belonged to — and either way the frame clock from before the transition says
	nothing about the one drawing now. Held against the new session, a stale
	clock reads as "the window is not drawing", which refuses input and
	screenshots for the whole playtest: the two things most worth having in one.

	The reconnect is what makes it honest rather than optimistic. A window that
	really is minimized produces no frames on the new connection either, and the
	monitor says so a second later.
]]
function RenderMonitor.rearm()
	if connection then
		pcall(function()
			(connection :: RBXScriptConnection):Disconnect()
		end)
		connection = nil
	end

	watching = false
	RenderMonitor.start()

	-- A fresh clock, so the transition itself is never counted as a stall.
	lastFrame = os.clock()
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
