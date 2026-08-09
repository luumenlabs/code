--!strict
--[[
	Prepares the inputs the analysis tools need.

	Neither input is committed. The Roblox type definitions and Selene's Roblox
	standard library both track Roblox releases, so a stale copy in the repo
	would quietly report the wrong thing after an engine update. They are
	fetched once and reused.

	Run through `luu run analyze`, or directly with `lune run scripts/setup`.
]]

local fs = require("@lune/fs")
local net = require("@lune/net")
local process = require("@lune/process")

local DEFINITIONS_URL = "https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/main/scripts/globalTypes.PluginSecurity.d.luau"
local DEFINITIONS_DIR = ".luau"
local DEFINITIONS_PATH = DEFINITIONS_DIR .. "/globalTypes.d.luau"
local SELENE_STD = "roblox.yml"
local SOURCEMAP = "sourcemap.json"

local function fail(message: string): never
	process.exit(1)
	error(message)
end

local function exec(program: string, args: { string })
	local result = process.exec(program, args)

	if not result.ok then
		print(string.format("`%s %s` failed:", program, table.concat(args, " ")))
		print(result.stderr ~= "" and result.stderr or result.stdout)
		fail("command failed")
	end

	return result
end

-- Plugin-security definitions: without them luau-lsp does not know what `game`,
-- `plugin`, or any Roblox class is, and reports the whole plugin as unknown.
if not fs.isFile(DEFINITIONS_PATH) then
	print("Downloading Roblox plugin-security type definitions...")

	local response = net.request({ url = DEFINITIONS_URL, method = "GET" })

	if not response.ok then
		print(string.format("Could not download type definitions: %d %s", response.statusCode, response.statusMessage))
		fail("download failed")
	end

	if not fs.isDir(DEFINITIONS_DIR) then
		fs.writeDir(DEFINITIONS_DIR)
	end

	fs.writeFile(DEFINITIONS_PATH, response.body)
end

-- Selene needs a generated standard library to know the Roblox API surface.
if not fs.isFile(SELENE_STD) then
	print("Generating the Roblox standard library for Selene...")
	exec("selene", { "generate-roblox-std" })
end

-- The sourcemap teaches luau-lsp how `script.Parent` resolves across modules,
-- so it is refreshed every time rather than cached.
exec("rojo", { "sourcemap", "default.project.json", "--output", SOURCEMAP })

print("Analysis inputs are ready.")
