--!nonstrict
--[[
	Bringing Creator Store assets into the place.

	The search half is the server's — it is Roblox's web API and needs no Studio
	— so all that happens here is the download and the parenting. LoadAsset
	yields on the network and produces a detached container, which is why it runs
	outside the undo recording: only the parenting is a change to the place, and
	a recording left open across a slow download is one another edit can collide
	with.
]]

local AssetService = game:GetService("AssetService")
local InsertService = game:GetService("InsertService")

local Changes = require(script.Parent.Parent.Changes)
local Errors = require(script.Parent.Parent.Errors)
local Handles = require(script.Parent.Parent.Handles)
local History = require(script.Parent.Parent.History)
local Path = require(script.Parent.Parent.Path)

local AssetOps = {}

--[[
	Probed rather than assumed: the services resolve in every build, so the
	question worth asking is whether either loader is there to call.
]]
function AssetOps.isAvailable(): boolean
	local ok, callable = pcall(function()
		return typeof((AssetService :: any).LoadAssetAsync) == "function" or typeof(InsertService.LoadAsset) == "function"
	end)
	return ok and callable == true
end

--[[
	Whether this place will load an asset somebody else owns.

	"Allow Loading Third Party Assets", under Game Settings → Security, is off in
	every new place, and with it off Roblox refuses every Creator Store model
	with a message about authorization that names neither the setting nor the
	place. It is the single reason insertion fails on a free, public, script-free
	model, and an agent told only "User is not authorized" concludes the asset
	is the problem and goes looking for another one, which fails the same way.

	Read through pcall and reported as unknown rather than as false: Roblox does
	not document a property for this, so a build that does not expose one must
	not be reported as a place with the setting turned off.
]]
function AssetOps.thirdPartyAssetsAllowed(): boolean?
	local ok, value = pcall(function()
		return (AssetService :: any).AllowInsertFreeAssets
	end)

	if ok and type(value) == "boolean" then
		return value
	end

	return nil
end

local THIRD_PARTY_HINT =
	'Turn on "Allow Loading Third Party Assets" in Studio under Game Settings → Security. It is off in every new place, and with it off Roblox refuses every Creator Store asset this account does not own — including free ones.'

--[[
	Why Roblox refused, in terms the agent can act on.

	The three outcomes are different jobs: an id that names nothing is a search
	away from being fixed, an asset that will not load for this place is not, and
	a place with asset loading turned off is the user's switch to flip.
]]
local function classify(assetId: number, message: string): any
	local lowered = string.lower(message)

	local missing = string.find(lowered, "404", 1, true) ~= nil
		or string.find(lowered, "does not exist", 1, true) ~= nil
		or string.find(lowered, "not found", 1, true) ~= nil

	if missing then
		return Errors.new(
			"TARGET_NOT_FOUND",
			string.format("There is no asset %d, or it is no longer public: %s", assetId, message),
			{ assetId = assetId },
			"Check the id, or search the store for what you want instead of guessing at one."
		)
	end

	-- The message Roblox gives for a place that will not load third-party
	-- assets. It says nothing about the setting, so this does: without it the
	-- only readable conclusion is that the asset is bad, and the next asset
	-- fails identically.
	local notAuthorized = string.find(lowered, "not authorized", 1, true) ~= nil
		or string.find(lowered, "unauthorized", 1, true) ~= nil
		or string.find(lowered, "403", 1, true) ~= nil
		or string.find(lowered, "insufficient permission", 1, true) ~= nil

	if notAuthorized then
		return Errors.new(
			"NOT_ALLOWED_BY_ROBLOX",
			string.format(
				"Roblox refused asset %d: %s. This is a setting on the place, not a property of the asset — trying a different asset will fail the same way.",
				assetId,
				message
			),
			{ assetId = assetId, thirdPartyAssets = AssetOps.thirdPartyAssetsAllowed() },
			THIRD_PARTY_HINT
		)
	end

	return Errors.new(
		"NOT_ALLOWED_BY_ROBLOX",
		string.format("Roblox would not load asset %d: %s", assetId, message),
		{ assetId = assetId },
		"Only free assets and ones this account already owns can be inserted. Pick a free asset, or have the user buy this one first."
	)
end

--[[
	Downloads the asset into a detached container.

	AssetService:LoadAssetAsync is the current API and the one Studio's own
	insertion path uses; InsertService:LoadAsset is kept behind it for builds
	that predate it. Both return a Model holding the asset's contents.
]]
local function load(assetId: number): (boolean, any)
	if typeof((AssetService :: any).LoadAssetAsync) == "function" then
		return pcall(function()
			return (AssetService :: any):LoadAssetAsync(assetId)
		end)
	end

	return pcall(function()
		return InsertService:LoadAsset(assetId)
	end)
end

local function countScripts(instances: { Instance }): (number, number)
	local scripts = 0
	local descendants = 0

	for _, instance in ipairs(instances) do
		descendants += 1
		if instance:IsA("LuaSourceContainer") then
			scripts += 1
		end

		for _, child in ipairs(instance:GetDescendants()) do
			descendants += 1
			if child:IsA("LuaSourceContainer") then
				scripts += 1
			end
		end
	end

	return descendants, scripts
end

function AssetOps.insert(params: any): any
	local parent = Handles.resolve(params.parent)
	local assetId = params.assetId

	-- Checked before the download rather than after it fails, when the build
	-- exposes the flag: the failure is the same either way, but this way the
	-- agent is told the place is the problem before it spends a turn shopping.
	if AssetOps.thirdPartyAssetsAllowed() == false then
		Errors.throw(
			"NOT_ALLOWED_BY_ROBLOX",
			"This place does not load assets from other creators, so no Creator Store asset can be inserted into it.",
			{ assetId = assetId, thirdPartyAssets = false },
			THIRD_PARTY_HINT
		)
	end

	local ok, container = load(assetId)

	if not ok then
		error(classify(assetId, tostring(container)), 0)
	end

	local contents = container:GetChildren()

	if #contents == 0 then
		container:Destroy()
		Errors.throw(
			"TARGET_NOT_FOUND",
			string.format("Asset %d loaded but held nothing", assetId),
			{ assetId = assetId },
			"Nothing was added to the place. Pick a different asset."
		)
	end

	-- Both of these are checked before anything is parented, so a request that
	-- cannot be honoured leaves the place exactly as it was.
	if params.name ~= nil and #contents > 1 then
		container:Destroy()
		Errors.throw(
			"INVALID_PARAMS",
			string.format("Asset %d holds %d top-level instances, so one name cannot be given to it", assetId, #contents),
			{ assetId = assetId, count = #contents },
			"Insert it without a name and rename what you want afterwards."
		)
	end

	local movable = {}
	for _, instance in ipairs(contents) do
		if instance:IsA("PVInstance") then
			table.insert(movable, instance)
		end
	end

	if params.position ~= nil and #movable == 0 then
		local className = contents[1].ClassName
		container:Destroy()
		Errors.throw(
			"INVALID_PARAMS",
			string.format("Asset %d holds nothing that can be positioned; it is a %s", assetId, className),
			{ assetId = assetId, className = className },
			"Insert it without a position. An asset like this is used by setting it on a property, not by placing it in the world."
		)
	end

	local _, undoLabel = History.record(string.format("Insert asset %d", assetId), function()
		for _, instance in ipairs(contents) do
			if params.name ~= nil then
				instance.Name = params.name
			end

			local parented, err = pcall(function()
				instance.Parent = parent
			end)

			if not parented then
				error(Errors.fromRobloxError(string.format("Could not parent to %s: %s", Path.of(parent), tostring(err))), 0)
			end
		end

		if params.position ~= nil then
			local target = CFrame.new(params.position[1], params.position[2], params.position[3])
			for _, instance in ipairs(movable) do
				instance:PivotTo(target)
			end
		end
	end)

	-- The wrapper LoadAsset builds is transport, not part of the asset, and
	-- leaving it behind would put an empty Model in the place for every insert.
	container:Destroy()

	local records = {}
	for _, instance in ipairs(contents) do
		table.insert(records, Changes.create(instance))
	end

	local descendants, scripts = countScripts(contents)

	return {
		instances = Handles.describeMany(contents),
		undoLabel = undoLabel,
		assetId = assetId,
		inserted = #contents,
		descendants = descendants,
		scripts = scripts,
		changes = records,
	}
end

return AssetOps
