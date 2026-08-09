--!nonstrict
--[[
	HTTP transport to the local server.

	Studio plugins cannot open sockets, so everything runs over HttpService
	against 127.0.0.1. Plugin-context requests do not require the place's HTTP
	setting to be enabled, which is why this works on an untouched project.
]]

local HttpService = game:GetService("HttpService")

local Net = {}

export type Response = {
	ok: boolean,
	status: number,
	body: any,
	error: string?,
}

function Net.post(url: string, body: any): Response
	local encodeOk, encoded = pcall(function()
		return HttpService:JSONEncode(body)
	end)

	if not encodeOk then
		return { ok = false, status = 0, body = nil, error = "Could not encode request: " .. tostring(encoded) }
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = url,
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
			},
			Body = encoded,
		})
	end)

	if not ok then
		return { ok = false, status = 0, body = nil, error = tostring(response) }
	end

	local decoded: any = nil
	if type(response.Body) == "string" and #response.Body > 0 then
		local decodeOk, result = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if decodeOk then
			decoded = result
		end
	end

	if not response.Success then
		local message = decoded and decoded.error and decoded.error.message or response.StatusMessage
		return { ok = false, status = response.StatusCode, body = decoded, error = message }
	end

	return { ok = true, status = response.StatusCode, body = decoded }
end

return Net
