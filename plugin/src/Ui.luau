--!nonstrict
--[[
	The Studio-side connection panel.

	Deliberately small. The plugin's job in the UI is to answer three questions:
	is Studio connected, which code is being paired, and how do I recover. Spec
	sections 8 and 25 put everything else in the harness.
]]

local Client = require(script.Parent.Client)
local Constants = require(script.Parent.Constants)

local Ui = {}

local COLORS = {
	background = Color3.fromRGB(28, 28, 32),
	panel = Color3.fromRGB(38, 38, 44),
	text = Color3.fromRGB(235, 235, 240),
	muted = Color3.fromRGB(150, 150, 160),
	accent = Color3.fromRGB(120, 170, 255),
	good = Color3.fromRGB(110, 205, 140),
	warn = Color3.fromRGB(235, 185, 100),
	bad = Color3.fromRGB(235, 120, 120),
}

local STATUS_COLORS = {
	connected = COLORS.good,
	pairing = COLORS.warn,
	disconnected = COLORS.bad,
}

local function corner(parent: Instance, radius: number)
	local instance = Instance.new("UICorner")
	instance.CornerRadius = UDim.new(0, radius)
	instance.Parent = parent
end

local function label(parent: Instance, text: string, size: number, color: Color3): TextLabel
	local instance = Instance.new("TextLabel")
	instance.BackgroundTransparency = 1
	instance.Size = UDim2.new(1, 0, 0, size + 8)
	instance.Font = Enum.Font.Gotham
	instance.TextSize = size
	instance.TextColor3 = color
	instance.TextXAlignment = Enum.TextXAlignment.Left
	instance.TextWrapped = true
	instance.Text = text
	instance.Parent = parent
	return instance
end

local function button(parent: Instance, text: string): TextButton
	local instance = Instance.new("TextButton")
	instance.Size = UDim2.new(1, 0, 0, 30)
	instance.BackgroundColor3 = COLORS.panel
	instance.BorderSizePixel = 0
	instance.AutoButtonColor = true
	instance.Font = Enum.Font.GothamMedium
	instance.TextSize = 13
	instance.TextColor3 = COLORS.text
	instance.Text = text
	instance.Parent = parent
	corner(instance, 6)
	return instance
end

function Ui.create(hostPlugin: Plugin)
	local widget = hostPlugin:CreateDockWidgetPluginGui(
		"LuuCodePanel",
		DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 280, 300, 240, 240)
	)
	widget.Title = "Luu Code"
	widget.Name = "LuuCode"

	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = COLORS.background
	root.BorderSizePixel = 0
	root.Parent = widget

	local padding = Instance.new("UIPadding")
	padding.PaddingTop = UDim.new(0, 12)
	padding.PaddingBottom = UDim.new(0, 12)
	padding.PaddingLeft = UDim.new(0, 12)
	padding.PaddingRight = UDim.new(0, 12)
	padding.Parent = root

	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Vertical
	layout.Padding = UDim.new(0, 8)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = root

	local statusLabel = label(root, "Connecting…", 15, COLORS.text)
	statusLabel.LayoutOrder = 1

	local detailLabel = label(root, "", 12, COLORS.muted)
	detailLabel.LayoutOrder = 2
	detailLabel.Size = UDim2.new(1, 0, 0, 34)

	local codeFrame = Instance.new("Frame")
	codeFrame.LayoutOrder = 3
	codeFrame.Size = UDim2.new(1, 0, 0, 56)
	codeFrame.BackgroundColor3 = COLORS.panel
	codeFrame.BorderSizePixel = 0
	codeFrame.Visible = false
	codeFrame.Parent = root
	corner(codeFrame, 8)

	local codeLabel = Instance.new("TextLabel")
	codeLabel.BackgroundTransparency = 1
	codeLabel.Size = UDim2.fromScale(1, 1)
	codeLabel.Font = Enum.Font.RobotoMono
	codeLabel.TextSize = 26
	codeLabel.TextColor3 = COLORS.accent
	codeLabel.Text = ""
	codeLabel.Parent = codeFrame

	local placeLabel = label(root, "", 12, COLORS.muted)
	placeLabel.LayoutOrder = 4

	local runLabel = label(root, "", 12, COLORS.muted)
	runLabel.LayoutOrder = 5

	local spacer = Instance.new("Frame")
	spacer.LayoutOrder = 6
	spacer.BackgroundTransparency = 1
	spacer.Size = UDim2.new(1, 0, 0, 4)
	spacer.Parent = root

	local reconnectButton = button(root, "Reconnect")
	reconnectButton.LayoutOrder = 7

	local forgetButton = button(root, "Forget this pairing")
	forgetButton.LayoutOrder = 8

	local portLabel = label(root, "", 11, COLORS.muted)
	portLabel.LayoutOrder = 9

	reconnectButton.Activated:Connect(function()
		Client.reconnect()
	end)

	forgetButton.Activated:Connect(function()
		-- Forces the next handshake to request a fresh pairing code, which is
		-- how a user revokes an approval from the Studio side.
		Client.forgetToken()
		Client.reconnect()
	end)

	local function render(state: any)
		statusLabel.Text = ({
			connected = "Connected",
			pairing = "Waiting for approval",
			disconnected = "Not connected",
		})[state.status] or state.status
		statusLabel.TextColor3 = STATUS_COLORS[state.status] or COLORS.text

		detailLabel.Text = state.message or ""

		codeFrame.Visible = state.pairingCode ~= nil
		codeLabel.Text = state.pairingCode or ""

		placeLabel.Text = state.place and string.format("Place: %s", state.place.name) or ""

		if state.run ~= nil then
			runLabel.Text = state.run.running and string.format("Playtest running (%s)", state.run.realm) or "Edit mode"
		end

		portLabel.Text = string.format("Local server port %d · plugin %s", state.port, Constants.PLUGIN_VERSION)
	end

	render(Client.state())
	Client.onChanged(render)

	return widget
end

return Ui
