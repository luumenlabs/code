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

local Client = require(script.Client)
local Constants = require(script.Constants)
local RunState = require(script.RunState)
local Ui = require(script.Ui)

local toolbar = plugin:CreateToolbar("Luu Code")
local toggleButton = toolbar:CreateButton("LuuCodeToggle", "Show the Luu Code connection panel", "rbxassetid://0", "Luu Code")
toggleButton.ClickableWhenViewportHidden = true

RunState.start()

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
	-- does not have to keep the panel open to know Studio is reachable.
	toggleButton.Icon = "rbxassetid://0"
	toggleButton:SetActive(widget.Enabled or state.status == "pairing")
end)

Client.start(plugin)

plugin.Unloading:Connect(function()
	Client.stop()
end)

print(string.format("Luu Code %s loaded. Local server port %d.", Constants.PLUGIN_VERSION, Client.port()))
