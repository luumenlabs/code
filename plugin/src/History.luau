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

function History.isAvailable(): boolean
	local ok, recordingId = pcall(function()
		return ChangeHistoryService:TryBeginRecording("LuuCode.Probe", "Luu Code capability probe")
	end)

	if ok and recordingId ~= nil then
		pcall(function()
			ChangeHistoryService:FinishRecording(recordingId, Enum.FinishRecordingOperation.Cancel)
		end)
		return true
	end

	return false
end

return History
