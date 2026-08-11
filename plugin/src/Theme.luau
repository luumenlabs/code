--!nonstrict
--[[
	The app's tokens, ported to Roblox.

	Every value is a custom property from packages/app/src/renderer/styles.css,
	converted from oklch to sRGB. Change one there, convert it here.

	Roblox has no colour-mix, so the translucent tokens are pre-composited over
	the background — which is why `border` is a flat grey and not white at 9%.
]]

local Theme = {}

-- U+2009 THIN SPACE, built rather than written as an escape: selene reads string
-- escapes as Lua 5.1, where \u{} does not exist.
local THIN_SPACE = utf8.char(0x2009)

Theme.color = {
	-- --background / --foreground
	background = Color3.fromRGB(10, 10, 10),
	foreground = Color3.fromRGB(242, 242, 242),
	-- --card, --popover: a touch lighter than the page, never a different hue
	card = Color3.fromRGB(20, 20, 20),
	popover = Color3.fromRGB(25, 25, 25),
	-- --border and --input, composited over the background
	border = Color3.fromRGB(32, 32, 32),
	input = Color3.fromRGB(42, 42, 42),
	-- --muted-foreground
	muted = Color3.fromRGB(161, 161, 161),
	-- --accent, --row-hover, --row-active
	accent = Color3.fromRGB(31, 31, 31),
	rowHover = Color3.fromRGB(26, 26, 26),
	rowActive = Color3.fromRGB(36, 36, 36),
	-- --primary: the Luumen brand blue
	primary = Color3.fromRGB(43, 127, 255),
	primaryForeground = Color3.fromRGB(239, 246, 255),
	-- --success / --warning / --destructive
	success = Color3.fromRGB(0, 195, 135),
	warning = Color3.fromRGB(249, 167, 38),
	destructive = Color3.fromRGB(255, 100, 103),
}

--[[
	Puts `gap` between every character. Roblox has no letter-spacing, and the
	section headings and the pairing code both need it.
]]
function Theme.spaced(content: string, gap: string): string
	local pieces = table.create(#content)

	for index = 1, #content do
		table.insert(pieces, string.sub(content, index, index))
	end

	return table.concat(pieces, gap)
end

--[[
	BuilderSans stands in for DM Sans: Roblox will not load a font the plugin
	does not own. Behind a pcall so a font that fails to resolve costs the
	typeface and nothing else.
]]
local function family(name: string, weight: Enum.FontWeight?): Font
	local ok, font = pcall(function()
		return Font.fromName(name, weight)
	end)

	if ok and font ~= nil then
		return font
	end

	return Font.fromEnum(Enum.Font.Gotham)
end

Theme.font = {
	regular = family("BuilderSans", Enum.FontWeight.Regular),
	medium = family("BuilderSans", Enum.FontWeight.Medium),
	semibold = family("BuilderSans", Enum.FontWeight.SemiBold),
	bold = family("BuilderSans", Enum.FontWeight.Bold),
	mono = Font.fromEnum(Enum.Font.RobotoMono),
}

-- --radius: 0.625rem and --control-radius: 0.5rem, at the app's 16px root.
Theme.radius = { card = 10, control = 8, pill = 999 }

Theme.space = { panel = 14, section = 14, row = 6, tight = 4 }

-- ---------------------------------------------------------------------------
-- Primitives
-- ---------------------------------------------------------------------------

function Theme.corner(parent: Instance, radius: number): UICorner
	local instance = Instance.new("UICorner")
	instance.CornerRadius = UDim.new(0, radius)
	instance.Parent = parent
	return instance
end

function Theme.stroke(parent: Instance, color: Color3?): UIStroke
	local instance = Instance.new("UIStroke")
	instance.Color = color or Theme.color.border
	instance.Thickness = 1
	-- Border, not outline: a stroke drawn outside the frame overlaps whatever is
	-- next to it in the list, and at 1px that reads as a doubled divider.
	instance.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	instance.Parent = parent
	return instance
end

function Theme.padding(parent: Instance, vertical: number, horizontal: number): UIPadding
	local instance = Instance.new("UIPadding")
	instance.PaddingTop = UDim.new(0, vertical)
	instance.PaddingBottom = UDim.new(0, vertical)
	instance.PaddingLeft = UDim.new(0, horizontal)
	instance.PaddingRight = UDim.new(0, horizontal)
	instance.Parent = parent
	return instance
end

function Theme.list(parent: Instance, gap: number): UIListLayout
	local instance = Instance.new("UIListLayout")
	instance.FillDirection = Enum.FillDirection.Vertical
	instance.Padding = UDim.new(0, gap)
	instance.SortOrder = Enum.SortOrder.LayoutOrder
	instance.Parent = parent
	return instance
end

export type TextOptions = {
	size: number?,
	color: Color3?,
	font: Font?,
	wrap: boolean?,
	align: Enum.TextXAlignment?,
	order: number?,
}

function Theme.text(parent: Instance, content: string, options: TextOptions?): TextLabel
	local settings = options or {}

	local instance = Instance.new("TextLabel")
	instance.BackgroundTransparency = 1
	instance.FontFace = settings.font or Theme.font.regular
	instance.TextSize = settings.size or 12
	instance.TextColor3 = settings.color or Theme.color.foreground
	instance.TextXAlignment = settings.align or Enum.TextXAlignment.Left
	instance.TextYAlignment = Enum.TextYAlignment.Top
	instance.TextWrapped = settings.wrap ~= false
	instance.Text = content
	instance.LayoutOrder = settings.order or 0
	-- Height follows the text so a message that wraps to three lines is not
	-- clipped to the two the layout guessed at.
	instance.AutomaticSize = Enum.AutomaticSize.Y
	instance.Size = UDim2.new(1, 0, 0, 0)
	instance.Parent = parent

	return instance
end

--[[
	A small-caps section heading. The app letterspaces these; Roblox cannot, so
	the spacing is put in by hand.
]]
function Theme.sectionLabel(parent: Instance, content: string, order: number): TextLabel
	return Theme.text(parent, Theme.spaced(string.upper(content), THIN_SPACE), {
		size = 10,
		color = Theme.color.muted,
		font = Theme.font.semibold,
		order = order,
	})
end

--[[
	One UIListLayout has one gap and this panel needs two, so groups are separated
	by an empty frame.
]]
function Theme.spacer(parent: Instance, height: number, order: number): Frame
	local instance = Instance.new("Frame")
	instance.BackgroundTransparency = 1
	instance.Size = UDim2.new(1, 0, 0, height)
	instance.LayoutOrder = order
	instance.Parent = parent
	return instance
end

function Theme.card(parent: Instance, order: number): Frame
	local instance = Instance.new("Frame")
	instance.BackgroundColor3 = Theme.color.card
	instance.BorderSizePixel = 0
	instance.LayoutOrder = order
	instance.AutomaticSize = Enum.AutomaticSize.Y
	instance.Size = UDim2.new(1, 0, 0, 0)
	instance.Parent = parent

	Theme.corner(instance, Theme.radius.card)
	Theme.stroke(instance)

	return instance
end

--[[
	A label left, its value right. Two labels rather than one with padding, so the
	left truncates and the value keeps its place when the panel is dragged narrow.

	Returns the value and the row, so a caller can fill it in or hide it entirely.
]]
function Theme.row(parent: Instance, name: string, order: number): (TextLabel, Frame)
	local holder = Instance.new("Frame")
	holder.BackgroundTransparency = 1
	holder.Size = UDim2.new(1, 0, 0, 20)
	holder.LayoutOrder = order
	holder.Parent = parent

	local key = Theme.text(holder, name, { size = 12, color = Theme.color.muted, wrap = false })
	key.Size = UDim2.new(0.5, 0, 1, 0)
	key.TextYAlignment = Enum.TextYAlignment.Center
	key.TextTruncate = Enum.TextTruncate.AtEnd
	key.AutomaticSize = Enum.AutomaticSize.None

	local value = Theme.text(holder, "", { size = 12, align = Enum.TextXAlignment.Right, wrap = false })
	value.Position = UDim2.fromScale(0.5, 0)
	value.Size = UDim2.new(0.5, 0, 1, 0)
	value.TextYAlignment = Enum.TextYAlignment.Center
	value.TextTruncate = Enum.TextTruncate.AtEnd
	value.AutomaticSize = Enum.AutomaticSize.None

	return value, holder
end

export type ButtonOptions = {
	variant: string?,
	order: number?,
}

--[[
	The app's two button shapes. Hover lightens through MouseEnter rather than
	AutoButtonColor, which darkens — on a near-black surface that reads as a
	control going disabled under the cursor.
]]
local VARIANTS = {
	outline = {
		rest = Theme.color.card,
		hover = Theme.color.rowActive,
		text = Theme.color.foreground,
		bordered = true,
	},
	primary = {
		rest = Theme.color.primary,
		hover = Theme.color.primary:Lerp(Color3.new(1, 1, 1), 0.12),
		text = Theme.color.primaryForeground,
		bordered = false,
	},
}

--[[
	Returns the button and a function that restyles it, since which button matters
	changes with the connection. The hover handlers read the current variant
	rather than capturing one, so switching cannot leave a stale hover colour.
]]
function Theme.button(parent: Instance, content: string, options: ButtonOptions?): (TextButton, (string) -> ())
	local settings = options or {}

	local instance = Instance.new("TextButton")
	instance.Size = UDim2.new(1, 0, 0, 32)
	instance.BorderSizePixel = 0
	instance.AutoButtonColor = false
	instance.FontFace = Theme.font.medium
	instance.TextSize = 12
	instance.Text = content
	instance.LayoutOrder = settings.order or 0
	instance.Parent = parent

	Theme.corner(instance, Theme.radius.control)
	local border = Theme.stroke(instance)

	local current = VARIANTS.outline
	local hovered = false

	local function apply(name: string)
		current = VARIANTS[name] or VARIANTS.outline
		instance.BackgroundColor3 = hovered and current.hover or current.rest
		instance.TextColor3 = current.text
		border.Enabled = current.bordered
	end

	instance.MouseEnter:Connect(function()
		hovered = true
		instance.BackgroundColor3 = current.hover
	end)

	instance.MouseLeave:Connect(function()
		hovered = false
		instance.BackgroundColor3 = current.rest
	end)

	apply(settings.variant or "outline")

	return instance, apply
end

--[[
	A coloured dot beside a word, which is how the app states connection status.

	Returns both halves so the caller can recolour them together: the dot alone
	is not enough at this size, and the word alone loses the at-a-glance read.
]]
function Theme.statusDot(parent: Instance, order: number): (Frame, TextLabel)
	local holder = Instance.new("Frame")
	holder.BackgroundTransparency = 1
	holder.Size = UDim2.new(1, 0, 0, 16)
	holder.LayoutOrder = order
	holder.Parent = parent

	local dot = Instance.new("Frame")
	dot.Size = UDim2.fromOffset(6, 6)
	dot.Position = UDim2.new(0, 0, 0.5, -3)
	dot.BackgroundColor3 = Theme.color.muted
	dot.BorderSizePixel = 0
	dot.Parent = holder
	Theme.corner(dot, Theme.radius.pill)

	local text = Theme.text(holder, "", { size = 12, font = Theme.font.semibold, wrap = false })
	text.Position = UDim2.fromOffset(14, 0)
	text.Size = UDim2.new(1, -14, 1, 0)
	text.TextYAlignment = Enum.TextYAlignment.Center
	text.AutomaticSize = Enum.AutomaticSize.None

	return dot, text
end

return Theme
