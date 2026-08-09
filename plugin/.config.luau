--[[
	The Studio plugin is a Luumen project, driven by `luu`.

	Everything it needs — Rojo, StyLua, Selene, luau-lsp, Lune — is pinned in
	rokit.toml and installed with `luu install`, so contributors working on the
	plugin never need the Node toolchain the rest of the repo uses.

	Tasks:

	  luu build          build straight into the local Studio plugins folder
	  luu dev            the same, rebuilt on every save
	  luu run bundle     a plain LuuCode.rbxm artifact, for CI and releases
	  luu format         stylua
	  luu lint           selene
	  luu run analyze    fetch analysis inputs, then luau-lsp
	  luu run check      what CI runs

	Note: the `luu` config parser does not accept comments inside the table
	below, so anything worth saying about a task is said here.

	`languagemode` is nonstrict because the plugin talks to a DataModel whose
	shape changes underneath it, so handlers are written defensively. luau-lsp
	still checks every module; see .luaurc.

	No Wally packages: a Studio plugin should not drag dependencies into the
	user's Studio install.
]]

return {
	project = {
		name = "luu-code-plugin",
		description = "Roblox Studio plugin for Luu Code",
		license = "MIT",
	},

	tasks = {
		build = "rojo build default.project.json --plugin LuuCode.rbxm",
		dev = "rojo build default.project.json --plugin LuuCode.rbxm --watch",
		bundle = "rojo build default.project.json --output LuuCode.rbxm",

		format = "stylua src",
		lint = "selene src",

		analyze = {
			"lune run scripts/setup",
			"luau-lsp analyze --definitions=.luau/globalTypes.d.luau --base-luaurc=.luaurc --sourcemap=sourcemap.json src",
		},

		check = {
			"stylua --check src",
			"luu lint",
			"luu run analyze",
		},
	},

	luu = {
		install = {
			tools = true,
			packages = false,
		},
	},

	luau = {
		languagemode = "nonstrict",
	},
}
