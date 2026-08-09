--!nonstrict
--[[
	Values shared across the plugin. Keep PROTOCOL_VERSION in sync with
	packages/protocol/src/transport.ts.
]]

local Constants = {}

Constants.PLUGIN_VERSION = "0.1.0"
Constants.PROTOCOL_VERSION = 1

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
