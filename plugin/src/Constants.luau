--!nonstrict
--[[
	Values shared across the plugin. Keep PROTOCOL_VERSION in sync with
	packages/protocol/src/transport.ts.
]]

local Constants = {}

Constants.PLUGIN_VERSION = "0.1.0"
Constants.PROTOCOL_VERSION = 1

--[[
	Which build this plugin came from.

	"dev" in source, because a plugin built from a checkout is a dev plugin —
	the release workflows stamp this the same way they stamp PLUGIN_VERSION. It
	matters because all three can be installed at once, side by side in the same
	Studio: the app installs LuuCode.rbxm, LuuCodeNightly.rbxm, and
	LuuCodeDev.rbxm as separate files, and each needs its own icon, its own
	toolbar, and its own widget so you can tell which one you are clicking.
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
	pair = "/studio/pair",
	sync = "/studio/sync",
}

-- Settings persisted through plugin:SetSetting.
Constants.SETTING_INSTALL_ID = "luucode_install_id"
Constants.SETTING_TOKEN = "luucode_token"
Constants.SETTING_PORT = "luucode_port"
Constants.SETTING_AUTOCONNECT = "luucode_autoconnect"

-- How long to wait between reconnect attempts when the server is unreachable.
Constants.RETRY_MIN_SECONDS = 1
Constants.RETRY_MAX_SECONDS = 10

-- Pairing polls this often while waiting for the user to approve.
Constants.PAIR_POLL_SECONDS = 1.5

-- Output entries buffered before the plugin forces a sync.
Constants.OUTPUT_FLUSH_THRESHOLD = 25

-- Maximum output entries shipped in a single sync.
Constants.OUTPUT_BATCH_SIZE = 200

return Constants
