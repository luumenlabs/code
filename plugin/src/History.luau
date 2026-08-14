--!nonstrict
--[[
	Undo integration. Spec section 27.

	Every mutation runs inside a ChangeHistoryService recording so the user can
	undo the agent's work with Ctrl+Z like any other Studio edit. Recording is
	best-effort: it is unavailable during a playtest and while another recording
	is open, and neither case should block the edit.
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")

local History = {}

--[[
	Runs `body` inside a named recording and returns its result plus the undo
	label that was actually registered (nil when Studio declined).
]]
function History.record(label: string, body: () -> any): (any, string?)
	local ok, recordingId = pcall(function()
		return ChangeHistoryService:TryBeginRecording("LuuCode." .. label, label)
	end)

	if not ok or recordingId == nil then
		-- No undo waypoint available: still perform the edit, but say so.
		return body(), nil
	end

	local success, result = pcall(body)

	if success then
		pcall(function()
			ChangeHistoryService:FinishRecording(recordingId, Enum.FinishRecordingOperation.Commit)
		end)
		return result, label
	end

	-- Roll the failed edit back rather than leaving a partial change behind.
	pcall(function()
		ChangeHistoryService:FinishRecording(recordingId, Enum.FinishRecordingOperation.Cancel)
	end)
	error(result, 0)
end

--[[
	Whether Studio will give us an undo waypoint.

	Answered once and remembered, because asking is not free: the only way to
	find out is to open a recording and cancel it, and cancelling one rolls
	Studio back to where the recording began — which includes putting the
	selection back. Asked on every sync, as it was, that quietly cleared
	whatever the user had selected every few seconds and made Studio unusable
	while the plugin was installed.

	The answer is a property of the Studio build and the DataModel, so one probe
	per DataModel is all it was ever worth. `History.forget` drops it when the
	DataModel is replaced.
]]
local available: boolean? = nil

function History.isAvailable(): boolean
	if available ~= nil then
		return available :: boolean
	end

	local ok, recordingId = pcall(function()
		return ChangeHistoryService:TryBeginRecording("LuuCode.Probe", "Luu Code capability probe")
	end)

	if ok and recordingId ~= nil then
		pcall(function()
			ChangeHistoryService:FinishRecording(recordingId, Enum.FinishRecordingOperation.Cancel)
		end)
		available = true
		return true
	end

	-- Not cached as false: a recording that is open right now is a reason to
	-- decline this instant, not evidence that Studio never allows one.
	return false
end

function History.forget()
	available = nil
end

return History
