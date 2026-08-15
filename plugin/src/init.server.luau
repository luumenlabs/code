--!nonstrict
--[[
	Luu Code — Roblox Studio plugin.

	Gives a coding agent running on this machine the ability to inspect and edit
	the open place, control playtesting, read output, observe runtime state, and
	interact with the running game. Everything goes through the local server on
	127.0.0.1; nothing here talks to the internet.

	https://github.com/luumenlabs/code
]]

if not plugin then
	return
end

local RunService = game:GetService("RunService")

local Client = require(script.Client)
local Constants = require(script.Constants)
local RunState = require(script.RunState)
local Ui = require(script.Ui)

-- Named for the channel, so a release, a nightly, and a dev plugin installed
-- together are three toolbars rather than one with three identical buttons.
local label = Constants.label()

RunState.start()

-- The connection comes up first and the panel cannot take it down: Studio loads
-- this again in the playtest's DataModel, where building a toolbar and widget
-- against ids that already exist throws.
Client.start(plugin)

plugin.Unloading:Connect(function()
	Client.stop()
end)

--[[
	The panel belongs to the edit DataModel and only to it. Studio runs this
	again inside each DataModel a playtest creates, and they share one widget —
	so a playtest peer that drew the panel would leave it behind, frozen, when
	that DataModel died.

	The connection above is outside this: every peer connects, one draws.
]]
local panelOk, panelProblem = pcall(function()
	if RunService:IsRunning() then
		return
	end

	local toolbar = plugin:CreateToolbar(label)
	local toggleButton =
		toolbar:CreateButton("LuuCodeToggle" .. Constants.suffix(), "Show the " .. label .. " connection panel", Constants.icon(), label)
	toggleButton.ClickableWhenViewportHidden = true

	local widget = Ui.create(plugin)

	toggleButton:SetActive(widget.Enabled)

	toggleButton.Click:Connect(function()
		widget.Enabled = not widget.Enabled
		toggleButton:SetActive(widget.Enabled)
	end)

	-- The pressed state follows the panel and nothing else.
	widget:GetPropertyChangedSignal("Enabled"):Connect(function()
		toggleButton:SetActive(widget.Enabled)
	end)
end)

if not panelOk then
	warn(
		string.format(
			"[Luu Code] The connection panel could not be built: %s. The Studio connection is unaffected; use the app to see it.",
			tostring(panelProblem)
		)
	)
end

print(string.format("Luu Code %s loaded. Local server port %d.", Constants.PLUGIN_VERSION, Client.port()))
