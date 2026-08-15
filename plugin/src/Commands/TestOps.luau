--!nonstrict
--[[
	Running the place's own TestService suite. Results come from the service's
	signals rather than the output buffer, so a failure keeps its script and
	line. The signals are service-wide, so they are connected around this run
	only.
]]

local RunService = game:GetService("RunService")
local TestService = game:GetService("TestService")

local Errors = require(script.Parent.Parent.Errors)
local Path = require(script.Parent.Parent.Path)

local TestOps = {}

local running = false

local function describeSource(source: Instance?): string?
	if source == nil then
		return nil
	end

	local ok, path = pcall(function()
		return Path.of(source)
	end)

	return ok and path or nil
end

function TestOps.run(params: any): any
	if running then
		Errors.throw("PLAYTEST_ALREADY_RUNNING", "A test run is already in progress", nil, "Wait for it to finish.")
	end

	-- An empty suite reported as a pass is the most dangerous result this could
	-- return: it says the tests are green when there are none, and an agent has
	-- no way to tell that apart from a real pass.
	local suite = TestService:GetDescendants()
	local hasTests = false
	for _, instance in ipairs(suite) do
		if instance:IsA("LuaSourceContainer") then
			hasTests = true
			break
		end
	end

	if not hasTests then
		Errors.throw(
			"TARGET_NOT_FOUND",
			"This place has no TestService tests to run",
			{ children = #TestService:GetChildren() },
			"Tests live as scripts under the TestService service. Add some, or verify behaviour with a playtest instead."
		)
	end

	local outcomes = {}
	local passed = 0
	local failed = 0
	local warned = 0

	local function record(status: string, message: string, source: Instance?, line: number?)
		table.insert(outcomes, {
			status = status,
			message = tostring(message),
			source = describeSource(source),
			line = type(line) == "number" and line or nil,
		})
	end

	local connections = {}

	--[[
		ServerCollectConditionalResult carries the verdict as its first argument.
		ServerCollectResult is everything without one — Message and Checkpoint —
		reported rather than dropped, since the last checkpoint explains a run
		that stopped halfway.
	]]
	table.insert(
		connections,
		TestService.ServerCollectConditionalResult:Connect(function(condition, message, source, line)
			if condition then
				passed += 1
				record("passed", message, source, line)
			else
				failed += 1
				record("failed", message, source, line)
			end
		end)
	)

	table.insert(
		connections,
		TestService.ServerCollectResult:Connect(function(message, source, line)
			record("message", message, source, line)
		end)
	)

	running = true
	local startedAt = os.clock()
	local timeoutSeconds = (params.timeoutMs or 120000) / 1000

	local finished = false
	local runError: string? = nil

	task.spawn(function()
		local ok, err = pcall(function()
			TestService:RunAsync()
		end)

		if not ok then
			runError = tostring(err)
		end

		finished = true
	end)

	while not finished and os.clock() - startedAt < timeoutSeconds do
		RunService.Heartbeat:Wait()
	end

	for _, connection in ipairs(connections) do
		connection:Disconnect()
	end

	running = false

	if runError ~= nil then
		Errors.throw("EXECUTION_ERROR", string.format("TestService:RunAsync failed: %s", runError), { outcomes = outcomes })
	end

	-- TestService keeps its own tallies, and they count things the signals do
	-- not always carry. Where it reports more failures than were collected, its
	-- number is the honest one.
	local reportedErrors = 0
	local reportedWarnings = 0
	pcall(function()
		reportedErrors = TestService.ErrorCount
		reportedWarnings = TestService.WarnCount
	end)

	warned = math.max(warned, reportedWarnings)

	return {
		outcomes = outcomes,
		passed = passed,
		failed = math.max(failed, reportedErrors),
		warned = warned,
		timedOut = not finished,
		elapsedMs = math.floor((os.clock() - startedAt) * 1000),
	}
end

function TestOps.isAvailable(): boolean
	local ok, service = pcall(function()
		return game:GetService("TestService")
	end)
	return ok and service ~= nil and (service :: any).RunAsync ~= nil
end

return TestOps
