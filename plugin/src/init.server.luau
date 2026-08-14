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
-- together are three toolbars you can tell apart rather than one with three
-- identical buttons in it.
local label = Constants.label()

RunState.start()

-- The connection comes up first and the panel cannot take it down: Studio loads
-- this again in the playtest's DataModel, where building the toolbar and widget
-- against ids that already exist threw and left that DataModel unconnected.
Client.start(plugin)

plugin.Unloading:Connect(function()
	Client.stop()
end)

--[[
	The panel belongs to the edit DataModel and only to it.

	Studio runs this again inside each DataModel a playtest creates, and those
	instances were building the panel too — into the same widget, since Studio
	hands back the one it already has for an id. The last one to build won, so
	the panel on screen belonged to a playtest peer: it reported "Playtest ·
	client" from a Client of its own, and when the playtest ended that DataModel
	died and left the panel behind, frozen on the last thing it had to say.

	The connection above is deliberately outside this. Every peer connects; only
	one of them draws.
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

	widget:GetPropertyChangedSignal("Enabled"):Connect(function()
		toggleButton:SetActive(widget.Enabled)
	end)

	Client.onChanged(function(state)
		-- The button doubles as an at-a-glance connection indicator, so the user
		-- does not have to keep the panel open to know Studio is reachable. That is
		-- carried by the pressed state alone: this handler used to also assign the
		-- icon, but the value was a placeholder that was never filled in, so every
		-- connection change overwrote the real icon with a blank one. Restoring the
		-- intent properly needs a second image per channel; until those exist,
		-- leaving the icon alone is what keeps it visible.
		toggleButton:SetActive(widget.Enabled or state.status == "pairing")
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
