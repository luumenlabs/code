--!nonstrict
--[[
	The Studio-side connection panel.

	Deliberately small. The plugin's job in the UI is to answer three questions:
	is Studio connected, which code is being paired, and how do I recover.
	Everything else belongs in the app.

	It is built to look like the app because it is usually on screen beside it —
	the app in one window, this docked into Studio in the other. Two surfaces
	that are nearly the same read as a mistake, so the tokens come from
	Theme.luau, which is a straight port of the app's stylesheet rather than an
	impression of it.
]]

local Client = require(script.Parent.Client)
local Constants = require(script.Parent.Constants)
local Theme = require(script.Parent.Theme)

local Ui = {}

local STATUS = {
	connected = { text = "Connected", color = Theme.color.success },
	pairing = { text = "Waiting for approval", color = Theme.color.warning },
	disconnected = { text = "Not connected", color = Theme.color.destructive },
}

local function studioVersion(): string
	local ok, result = pcall(function()
		return version()
	end)

	if not ok then
		return "unknown"
	end

	-- "0.733.0.7330989" is four components of build metadata, of which two are
	-- the version anyone means. The rest costs a line of a very narrow panel to
	-- say nothing a person reads.
	local major, minor = string.match(tostring(result), "^(%d+)%.(%d+)")
	return major and string.format("%s.%s", major, minor) or tostring(result)
end

--[[
	"Group 16932405", the way the app writes it.

	Nothing to show for an unpublished place, which has no owner yet — and a row
	reading "User 0" would be an answer rather than the absence of one.
]]
local function ownerOf(place: any): string?
	if place == nil or type(place.creatorId) ~= "number" or place.creatorId <= 0 then
		return nil
	end

	local kind = type(place.creatorType) == "string" and place.creatorType or "User"
	return string.format("%s %d", kind, place.creatorId)
end

function Ui.create(hostPlugin: Plugin)
	-- Studio keys a widget's saved position and size on this id, so each channel
	-- needs its own or two installed plugins fight over one docked panel.
	local widget = hostPlugin:CreateDockWidgetPluginGui(
		"LuuCodePanel" .. Constants.suffix(),
		DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 300, 420, 260, 300)
	)
	widget.Title = Constants.label()
	widget.Name = "LuuCode" .. Constants.suffix()

	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = Theme.color.background
	root.BorderSizePixel = 0
	root.Parent = widget

	-- Scrolls because the widget can be dragged shorter than its contents, and a
	-- pairing code the user cannot reach is the one thing this panel must never
	-- do.
	local scroll = Instance.new("ScrollingFrame")
	scroll.Size = UDim2.fromScale(1, 1)
	scroll.BackgroundTransparency = 1
	scroll.BorderSizePixel = 0
	scroll.CanvasSize = UDim2.new()
	scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
	scroll.ScrollBarThickness = 4
	scroll.ScrollBarImageColor3 = Theme.color.foreground
	scroll.ScrollBarImageTransparency = 0.9
	scroll.VerticalScrollBarInset = Enum.ScrollBarInset.ScrollBar
	scroll.Parent = root

	Theme.padding(scroll, Theme.space.panel, Theme.space.panel)
	Theme.list(scroll, Theme.space.row)

	-- Ordered in tens so a row can be put between two others without renumbering
	-- the panel.

	-- Header ------------------------------------------------------------------

	local statusDot, statusText = Theme.statusDot(scroll, 10)

	local placeName = Theme.text(scroll, "", { size = 16, font = Theme.font.semibold, order = 20 })

	local versions = Theme.text(scroll, "", { size = 11, color = Theme.color.muted, order = 30 })

	Theme.spacer(scroll, Theme.space.tight, 35)

	-- Pairing -----------------------------------------------------------------

	local pairingCard = Theme.card(scroll, 40)
	pairingCard.Visible = false
	Theme.padding(pairingCard, 14, 14)
	Theme.list(pairingCard, 6)

	Theme.sectionLabel(pairingCard, "Approve in Luu Code", 1)

	local codeText = Theme.text(pairingCard, "", {
		size = 26,
		color = Theme.color.primary,
		font = Theme.font.mono,
		align = Enum.TextXAlignment.Center,
		order = 2,
	})

	Theme.text(pairingCard, "Check this code matches the one the app is showing, then approve it there.", {
		size = 11,
		color = Theme.color.muted,
		order = 3,
	})

	-- A message worth reading -------------------------------------------------

	local messageCard = Theme.card(scroll, 50)
	messageCard.Visible = false
	Theme.padding(messageCard, 12, 12)
	Theme.list(messageCard, 0)

	local messageText = Theme.text(messageCard, "", { size = 11, color = Theme.color.muted })

	-- Details -----------------------------------------------------------------
	--
	-- The same four the app's Studio panel lists, in the same order. There is no
	-- Port row: the footer already says where the server is, and stating it twice
	-- in a panel this size reads as two different numbers until you check.

	Theme.spacer(scroll, Theme.space.tight, 60)

	local modeValue = Theme.row(scroll, "Mode", 70)
	local placeValue, placeRow = Theme.row(scroll, "Place", 80)
	local universeValue, universeRow = Theme.row(scroll, "Universe", 90)
	local ownerValue, ownerRow = Theme.row(scroll, "Owner", 100)

	-- Actions -----------------------------------------------------------------

	Theme.spacer(scroll, Theme.space.section - Theme.space.row, 110)

	local reconnectButton, styleReconnect = Theme.button(scroll, "Reconnect", { order = 120 })
	local forgetButton = Theme.button(scroll, "Forget this pairing", { order = 130 })

	-- Footer ------------------------------------------------------------------

	Theme.spacer(scroll, Theme.space.tight, 140)

	local footer = Theme.text(scroll, "", { size = 10, color = Theme.color.muted, order = 150 })

	reconnectButton.Activated:Connect(function()
		Client.reconnect()
	end)

	forgetButton.Activated:Connect(function()
		-- Forces the next handshake to request a fresh pairing code, which is
		-- how a user revokes an approval from the Studio side.
		Client.forgetToken()
		Client.reconnect()
	end)

	-- Neither of these changes for the life of the session, so they are read once
	-- rather than on every connection state change.
	versions.Text = string.format("Studio %s · plugin %s", studioVersion(), Constants.PLUGIN_VERSION)

	local function render(state: any)
		local status = STATUS[state.status] or { text = state.status, color = Theme.color.muted }

		statusDot.BackgroundColor3 = status.color
		statusText.Text = status.text
		statusText.TextColor3 = status.color

		-- Reconnect is the one thing to do when the server has gone, and nothing
		-- worth drawing the eye to once it is back.
		styleReconnect(state.status == "disconnected" and "primary" or "outline")

		local place = state.place
		placeName.Text = place and place.name or "No place open"

		local code = state.pairingCode
		pairingCard.Visible = code ~= nil
		-- Six digits set solid read as a number to be parsed; spaced out they
		-- read as a code to be compared against the one on screen in the app,
		-- which is the only thing anyone ever does with this.
		codeText.Text = code and Theme.spaced(code, "  ") or ""

		-- The status word already says "Connected"; repeating it underneath is
		-- noise in a panel this narrow. A message only earns its card when it
		-- tells the user something the status does not.
		local message = state.message
		messageCard.Visible = type(message) == "string" and #message > 0 and state.status ~= "connected"
		messageText.Text = message or ""

		local run = state.run
		if run == nil then
			modeValue.Text = "—"
		elseif run.running then
			modeValue.Text = string.format("Playtest · %s", run.realm)
		else
			modeValue.Text = "Edit"
		end

		-- An unpublished place has neither id. The rows are hidden rather than
		-- filled with a zero, which looks like an id and is not one.
		local hasPlaceId = place ~= nil and type(place.placeId) == "number" and place.placeId > 0
		placeRow.Visible = hasPlaceId
		placeValue.Text = hasPlaceId and tostring(place.placeId) or ""

		local hasUniverse = place ~= nil and type(place.gameId) == "number" and place.gameId > 0
		universeRow.Visible = hasUniverse
		universeValue.Text = hasUniverse and tostring(place.gameId) or ""

		local owner = ownerOf(place)
		ownerRow.Visible = owner ~= nil
		ownerValue.Text = owner or ""

		footer.Text = string.format("Runs on 127.0.0.1:%d. Nothing leaves this machine.", state.port)
	end

	render(Client.state())
	Client.onChanged(render)

	return widget
end

return Ui
