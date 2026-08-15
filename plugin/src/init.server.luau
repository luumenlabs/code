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

local Bridge = require(script.Bridge)
local Client = require(script.Client)
local Constants = require(script.Constants)
local RunState = require(script.RunState)
local Ui = require(script.Ui)

-- Named for the channel, so a release, a nightly, and a dev plugin installed
-- together are three toolbars rather than one with three identical buttons.
local label = Constants.label()

RunState.start()

-- A playtest bridge only ever lives in the place between one being asked for
-- and Studio copying it. One here now means Studio was interrupted mid-start,
-- so it belongs to nothing and goes before the user can save it.
if not RunState.isRunning() then
	local swept = Bridge.sweep()
	if swept > 0 then
		warn(string.format("[Luu Code] Removed %d playtest bridge(s) left behind by an interrupted session.", swept))
	end
end

-- The connection comes up first and the panel cannot take it down: Studio loads
-- this again in the playtest's DataModel, where building a toolbar and widget
-- against ids that already exist throws.
Client.start(plugin)

local unloading: (() -> ())? = nil

plugin.Unloading:Connect(function()
	Client.stop()
	if unloading then
		unloading()
	end
end)

--[[
	Every DataModel claims the toolbar and the widget — a peer that skipped them
	took the button away from edit too — and one of them fills the panel. Which
	one is settled by whoever finds it empty and holds it until its DataModel
	goes, because a peer that builds over another leaves rows wired to a `Client`
	that is on its way out.
]]
local panelOk, panelProblem = pcall(function()
	local toolbar = plugin:CreateToolbar(label)
	local toggleButton =
		toolbar:CreateButton("LuuCodeToggle" .. Constants.suffix(), "Show the " .. label .. " connection panel", Constants.icon(), label)
	toggleButton.ClickableWhenViewportHidden = true

	local widget = Ui.widget(plugin)

	if Ui.claim(widget) then
		unloading = function()
			Ui.release(widget)
		end
	else
		-- The peer holding it is usually the shorter-lived one: a playtest ends
		-- and hands back a panel the edit peer is still here to fill.
		task.spawn(function()
			while unloading == nil do
				task.wait(1)
				if Ui.claim(widget) then
					unloading = function()
						Ui.release(widget)
					end
				end
			end
		end)
	end

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
