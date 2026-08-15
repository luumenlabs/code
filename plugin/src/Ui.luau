--!nonstrict
--[[
	The Studio-side connection panel. It reports and does not act: the one
	question it answers is whether Studio is connected, and recovery belongs in
	the app. The retry loop reconnects within ten seconds either way.

	Tokens come from Theme.luau, a port of the app's stylesheet, because the two
	are usually on screen side by side.
]]

local Client = require(script.Parent.Client)
local Constants = require(script.Parent.Constants)
local Theme = require(script.Parent.Theme)

local Ui = {}

local STATUS = {
	connected = { text = "Connected", color = Theme.color.success },
	disconnected = { text = "Not connected", color = Theme.color.destructive },
}

local function studioVersion(): string
	local ok, result = pcall(function()
		return version()
	end)

	if not ok then
		return "unknown"
	end

	-- "0.733.0.7330989" is four components, of which two are the version anyone
	-- means, in a very narrow panel.
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

--[[
	The widget itself, which every DataModel may ask for: Studio hands back the
	same one for an id it has seen, so the playtest's peer gets the panel the
	edit peer built and can wire a toggle to it without touching its contents.
]]
function Ui.widget(hostPlugin: Plugin)
	-- Studio keys a widget's saved position and size on this id, so each channel
	-- needs its own or two installed plugins fight over one docked panel.
	local widget = hostPlugin:CreateDockWidgetPluginGui(
		"LuuCodePanel" .. Constants.suffix(),
		DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 300, 420, 260, 300)
	)
	widget.Title = Constants.label()
	widget.Name = "LuuCode" .. Constants.suffix()
	return widget
end

--[[
	Fills the widget, for one peer at a time. The rows are driven by the `Client`
	of the DataModel that built them, and a playtest's DataModel is destroyed
	under it — a second peer building over the first leaves the panel frozen on
	whatever that dying one last said.

	Claimed by whether the widget is empty rather than by run state, which is a
	reading and can be wrong. Nothing else puts children here.
]]
function Ui.claim(widget: any): boolean
	if #widget:GetChildren() > 0 then
		return false
	end

	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = Theme.color.background
	root.BorderSizePixel = 0
	root.Parent = widget

	-- Scrolls because the widget can be dragged shorter than its contents.
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

	-- A message worth reading -------------------------------------------------

	local messageCard = Theme.card(scroll, 50)
	messageCard.Visible = false
	Theme.padding(messageCard, 12, 12)
	Theme.list(messageCard, 0)

	local messageText = Theme.text(messageCard, "", { size = 11, color = Theme.color.muted })

	-- Details -----------------------------------------------------------------
	--
	-- The same four the app's Studio panel lists, in the same order. No Port
	-- row: the message above names the port when nothing is connecting.

	Theme.spacer(scroll, Theme.space.tight, 60)

	local modeValue = Theme.row(scroll, "Mode", 70)
	local placeValue, placeRow = Theme.row(scroll, "Place", 80)
	local universeValue, universeRow = Theme.row(scroll, "Universe", 90)
	local ownerValue, ownerRow = Theme.row(scroll, "Owner", 100)

	-- Neither of these changes for the life of the session, so they are read once
	-- rather than on every connection state change.
	versions.Text = string.format("Studio %s · plugin %s", studioVersion(), Constants.PLUGIN_VERSION)

	local function render(state: any)
		local status = STATUS[state.status] or { text = state.status, color = Theme.color.muted }

		statusDot.BackgroundColor3 = status.color
		statusText.Text = status.text
		statusText.TextColor3 = status.color

		local place = state.place
		placeName.Text = place and place.name or "No place open"

		-- A message earns its card only when it says what the status does not.
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

		-- An unpublished place has neither id, and a zero looks like one.
		local hasPlaceId = place ~= nil and type(place.placeId) == "number" and place.placeId > 0
		placeRow.Visible = hasPlaceId
		placeValue.Text = hasPlaceId and tostring(place.placeId) or ""

		local hasUniverse = place ~= nil and type(place.gameId) == "number" and place.gameId > 0
		universeRow.Visible = hasUniverse
		universeValue.Text = hasUniverse and tostring(place.gameId) or ""

		local owner = ownerOf(place)
		ownerRow.Visible = owner ~= nil
		ownerValue.Text = owner or ""
	end

	render(Client.state())
	Client.onChanged(render)

	return true
end

--[[
	Hands the panel back, so a peer on its way out does not leave rows nothing
	can update. Only ever called by whoever claimed it.
]]
function Ui.release(widget: any)
	for _, existing in ipairs(widget:GetChildren()) do
		existing:Destroy()
	end
end

return Ui
