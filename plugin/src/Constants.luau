--!nonstrict
--[[
	Values shared across the plugin. Keep PROTOCOL_VERSION in sync with
	packages/protocol/src/transport.ts.
]]

local Constants = {}

Constants.PLUGIN_VERSION = "0.1.0"
Constants.PROTOCOL_VERSION = 1

--[[
	Which build this plugin came from. "dev" in source; the release workflows
	stamp it the same way they stamp PLUGIN_VERSION. All three install side by
	side in one Studio, so each needs its own icon, toolbar, and widget.
]]
Constants.CHANNEL = "dev"

Constants.CHANNEL_ICON = {
	release = "rbxassetid://89215339105747",
	dev = "rbxassetid://88944225964759",
	nightly = "rbxassetid://128951701517939",
}

Constants.CHANNEL_LABEL = {
	release = "Luu Code",
	dev = "Luu Code Dev",
	nightly = "Luu Code Nightly",
}

--[[
	The name Studio sees. Distinct per channel so two installed plugins get two
	toolbars rather than merging into one with two identical buttons, and so
	each keeps its own docked widget position.
]]
function Constants.label(): string
	return Constants.CHANNEL_LABEL[Constants.CHANNEL] or Constants.CHANNEL_LABEL.release
end

function Constants.icon(): string
	return Constants.CHANNEL_ICON[Constants.CHANNEL] or Constants.CHANNEL_ICON.release
end

--[[
	A stable, channel-specific suffix for anything Studio keys state on.
	Release keeps the bare names it has always had, so an existing install does
	not lose its widget position to a rename.
]]
function Constants.suffix(): string
	if Constants.CHANNEL == "release" then
		return ""
	end
	return Constants.CHANNEL == "nightly" and "Nightly" or "Dev"
end

Constants.DEFAULT_HOST = "http://127.0.0.1"
Constants.DEFAULT_PORT = 33770

Constants.ROUTES = {
	hello = "/studio/hello",
	sync = "/studio/sync",
}

--[[
	Settings persisted through plugin:SetSetting, which writes once per plugin
	for the whole machine. Keys are suffixed with the place identity, so two
	windows on different places do not share one.
]]
Constants.SETTING_INSTALL_ID = "luucode_install_id"
Constants.SETTING_TOKEN = "luucode_token"
Constants.SETTING_PORT = "luucode_port"
Constants.SETTING_AUTOCONNECT = "luucode_autoconnect"

-- How long to wait between reconnect attempts when the server is unreachable.
Constants.RETRY_MIN_SECONDS = 1
Constants.RETRY_MAX_SECONDS = 10

-- Output entries buffered before the plugin forces a sync.
Constants.OUTPUT_FLUSH_THRESHOLD = 25

-- Maximum output entries shipped in a single sync.
Constants.OUTPUT_BATCH_SIZE = 200

return Constants
