/**
 * A fabricated Luu Code, for pictures.
 *
 * Everything the renderer knows about the world arrives through one object —
 * `window.luuCode` — so a convincing screenshot needs no changes to the app at
 * all: stand up a fake bridge over this data, point Electron at the real built
 * renderer, and what appears on screen is the actual UI drawing actual props.
 *
 * Nothing here ships. There is no import of this file anywhere in `src/`, and
 * the app never learns it exists.
 *
 * Times are relative to the moment you run it, so "8h ago" stays "8h ago" and
 * the live turn's clock reads a sensible "1m 12s" in every shot.
 */
const NOW = Date.now();
const sec = (n) => n * 1_000;
const min = (n) => n * 60_000;
const hour = (n) => n * 3_600_000;
const day = (n) => n * 86_400_000;

// ---------------------------------------------------------------------------
// Places
//
// Sequels and remasters of games that exist, which is what a Studio full of
// half-finished projects actually looks like.
// ---------------------------------------------------------------------------

const PROJECTS = [
  { id: "prj_bee", identity: "game:4712880153", placeId: 8421771003, name: "Bee Simulator 6", lastUsedAt: NOW - min(1) },
  { id: "prj_tower", identity: "game:2119351644", placeId: 6103552918, name: "Tower of Hell Remastered", lastUsedAt: NOW - min(4) },
  { id: "prj_mm", identity: "game:1583270280", placeId: 7742019556, name: "Murder Mystery 4", lastUsedAt: NOW - hour(8) },
  { id: "prj_lumber", identity: "game:1300192951", placeId: 5566210874, name: "Lumber Tycoon 3", lastUsedAt: NOW - day(1) - hour(3) },
  { id: "prj_doors", identity: "game:6516141723", placeId: 9003174652, name: "Doors Floor 3", lastUsedAt: NOW - day(2) },
  { id: "prj_pets", identity: null, placeId: 0, name: "Pet Sim 99", lastUsedAt: NOW - day(5) },
];

// The conversation the window opens on, and the Studio window it works in.
const OPEN = "thr_pollen";
const SESSION_ID = "ses_bee_main";

/**
 * `agent` is what draws the provider mark on the second line of each row, so
 * the list is deliberately mixed: a real sidebar is not all one vendor.
 */
const THREADS = [
  // Bee Simulator 6 — two chats working at once, one of them the open one.
  { id: OPEN, projectId: "prj_bee", title: "Pollen counter desyncs on rejoin", agent: "claude", messageCount: 4, createdAt: NOW - min(14), updatedAt: NOW - min(1) },
  { id: "thr_honey", projectId: "prj_bee", title: "Balance honey costs for tier 4 hives", agent: "codex", messageCount: 9, createdAt: NOW - hour(2), updatedAt: NOW - min(3) },
  { id: "thr_flight", projectId: "prj_bee", title: "Debug bee flying through hive walls", agent: "claude", messageCount: 22, createdAt: NOW - hour(6), updatedAt: NOW - hour(5) },
  { id: "thr_field", projectId: "prj_bee", title: "Field respawn timer runs twice on empty servers", agent: "claude", messageCount: 11, createdAt: NOW - day(1), updatedAt: NOW - hour(20) },

  // Tower of Hell Remastered — one chat working.
  { id: "thr_lava", projectId: "prj_tower", title: "Lava rise speed drifts on long rounds", agent: "claude", messageCount: 6, createdAt: NOW - min(25), updatedAt: NOW - min(4) },
  { id: "thr_sections", projectId: "prj_tower", title: "Randomise section order per round", agent: "codex", messageCount: 14, createdAt: NOW - day(1), updatedAt: NOW - hour(11) },

  // Everything below is finished work.
  { id: "thr_sheriff", projectId: "prj_mm", title: "Sheriff gun fires twice on one click", agent: "claude", messageCount: 17, createdAt: NOW - hour(9), updatedAt: NOW - hour(8) },
  { id: "thr_round", projectId: "prj_mm", title: "Round timer skips the last second", agent: "codex", messageCount: 8, createdAt: NOW - day(2), updatedAt: NOW - day(1) - hour(20) },

  { id: "thr_trees", projectId: "prj_lumber", title: "Trees stop respawning after an hour", agent: "claude", messageCount: 26, createdAt: NOW - day(1) - hour(6), updatedAt: NOW - day(1) - hour(3) },
  { id: "thr_conveyor", projectId: "prj_lumber", title: "Wood jitters on the mill conveyor", agent: "claude", messageCount: 12, createdAt: NOW - day(3), updatedAt: NOW - day(3) },

  { id: "thr_closet", projectId: "prj_doors", title: "Hiding in a closet breaks the camera", agent: "codex", messageCount: 19, createdAt: NOW - day(2) - hour(2), updatedAt: NOW - day(2) },
  { id: "thr_entity", projectId: "prj_doors", title: "Entity spawn rate should scale with room count", agent: "claude", messageCount: 7, createdAt: NOW - day(4), updatedAt: NOW - day(4) },

  { id: "thr_follow", projectId: "prj_pets", title: "Pet follow distance is too wide indoors", agent: "claude", messageCount: 10, createdAt: NOW - day(5), updatedAt: NOW - day(5) },
  { id: "thr_hatch", projectId: "prj_pets", title: "Egg hatch animation stutters on mobile", agent: "codex", messageCount: 15, createdAt: NOW - day(6), updatedAt: NOW - day(6) },

  // Two filed away, so the Archived fold has something in it.
  { id: "thr_old_shop", projectId: "prj_bee", title: "Shop UI pass", agent: "claude", messageCount: 31, createdAt: NOW - day(9), updatedAt: NOW - day(8), archived: true },
  { id: "thr_old_badge", projectId: "prj_mm", title: "Badge award on first win", agent: "codex", messageCount: 5, createdAt: NOW - day(12), updatedAt: NOW - day(12), archived: true },
].map((thread) => ({ ...thread, placeName: PROJECTS.find((p) => p.id === thread.projectId).name }));

/** Three chats mid-turn: two in Bee Simulator 6, one in Tower of Hell. */
const AGENT_STATES = {
  [OPEN]: "working",
  thr_honey: "thinking",
  thr_lava: "working",
};

// ---------------------------------------------------------------------------
// The open conversation
//
// Two turns. The first has landed, so the app folds its working-out behind
// "Worked for 42s" and shows only the answer — which is the point of that fold.
// The second is still running, so every row is open: the thinking, the Roblox
// operations, the tool calls, and the live clock underneath.
// ---------------------------------------------------------------------------

const T1 = NOW - min(9);
const T2 = NOW - sec(72);

const ref = (path, className, childCount = 0) => ({
  handle: `h_${path.replace(/\W+/g, "_").toLowerCase()}`,
  path,
  name: path.split(".").pop(),
  className,
  childCount,
});

const lines = (text) => text.replace(/\n$/, "").split("\n").length;

const activity = (id, at, category, title, detail, status = "ok", instances = []) => ({
  kind: "activity",
  id,
  at,
  activity: {
    id: `act_${id}`,
    op: "inspect.tree",
    origin: "harness",
    chat: OPEN,
    title,
    detail,
    category,
    startedAt: at,
    finishedAt: status === "running" ? null : at + sec(2),
    status,
    error: null,
    instances,
  },
});

const tool = (id, at, name, input, result, isError = false) => ({
  kind: "tool",
  id,
  at,
  name,
  input,
  result,
  isError,
});

const TIMELINE = [
  // ----- Turn one, finished -------------------------------------------------
  {
    kind: "user",
    id: "u1",
    at: T1,
    text: "Players who rejoin lose their pollen — the leaderstat reads 0 until they collect again, but the profile still has the right number. Where is it going?",
  },
  {
    kind: "thinking",
    id: "k1",
    at: T1 + sec(3),
    text: "Two candidates. Either the leaderstat is written from a default before the profile loads, or the profile load overwrites the leaderstat instead of the other way round. The giveaway is that collecting once fixes it — that means the value is right in the profile and only the display is wrong, so this is a write-order problem in PlayerAdded rather than data loss.",
  },
  activity("a1", T1 + sec(6), "inspect", "Listed ServerScriptService", "34 children", "ok"),
  tool(
    "t1",
    T1 + sec(11),
    "Grep",
    { pattern: "leaderstats|Pollen\\b", path: "src/server", output_mode: "files_with_matches" },
    "src/server/Data/ProfileStore.luau\nsrc/server/Pollen/PollenService.luau\nsrc/server/Pollen/PollenLeaderstats.luau\nsrc/server/Player/PlayerSetup.luau",
  ),
  tool(
    "t2",
    T1 + sec(17),
    "Read",
    { file_path: "src/server/Pollen/PollenLeaderstats.luau" },
    'local Players = game:GetService("Players")\n\nlocal function onPlayerAdded(player: Player)\n\tlocal stats = Instance.new("Folder")\n\tstats.Name = "leaderstats"\n\n\tlocal pollen = Instance.new("IntValue")\n\tpollen.Name = "Pollen"\n\tpollen.Value = 0\n\tpollen.Parent = stats\n\n\tstats.Parent = player\nend\n\nPlayers.PlayerAdded:Connect(onPlayerAdded)',
  ),
  activity(
    "a2",
    T1 + sec(24),
    "inspect",
    "Read Source on ServerScriptService.Pollen.PollenService",
    "412 lines",
    "ok",
  ),
  {
    kind: "assistant",
    id: "m1",
    at: T1 + sec(42),
    text: `Found it. Nothing is lost — the leaderstat is just written before the profile arrives.

\`PollenLeaderstats\` creates the \`IntValue\` on \`PlayerAdded\` and hard-codes \`Value = 0\`:

\`\`\`lua
local pollen = Instance.new("IntValue")
pollen.Name = "Pollen"
pollen.Value = 0
\`\`\`

\`PollenService\` then loads the profile a moment later and updates its own cache, but never writes back to \`leaderstats\`. So the display sits at 0 until the next \`AddPollen\` call pushes a fresh number into it — which is exactly why collecting one flower "fixes" it.

Two things worth doing:

1. Wait for the profile in \`PlayerAdded\` and seed the \`IntValue\` from it.
2. Guard the write, so a profile that fails to load leaves the old value alone instead of stamping 0 over it.`,
  },

  // ----- Turn two, still running --------------------------------------------
  {
    kind: "user",
    id: "u2",
    at: T2,
    text: "That's it. Do both — seed it from the profile, and never let a failed load write 0 over a good value.",
  },
  {
    kind: "thinking",
    id: "k2",
    at: T2 + sec(4),
    text: "ProfileStore already exposes a per-player promise, so the leaderstat setup can await it rather than racing it. The guard belongs in the same place: if the load rejects, leave the IntValue untouched and let the retry path handle it.",
  },
  activity(
    "a3",
    T2 + sec(11),
    "inspect",
    "Read Source on ServerScriptService.Pollen.PollenLeaderstats",
    "88 lines",
    "ok",
  ),
  tool(
    "t3",
    T2 + sec(18),
    "Read",
    { file_path: "src/server/Data/ProfileStore.luau", offset: 120, limit: 60 },
    "function ProfileStore.waitForProfile(player: Player): Profile?\n\tlocal loaded = loading[player]\n\tif loaded then\n\t\treturn loaded:expect()\n\tend\n\n\treturn profiles[player]\nend",
  ),
  tool(
    "t4",
    T2 + sec(26),
    "Grep",
    { pattern: "waitForProfile", path: "src/server", output_mode: "content", "-n": true },
    "src/server/Pollen/PollenService.luau:64:\tlocal profile = ProfileStore.waitForProfile(player)\nsrc/server/Shop/ShopService.luau:31:\tlocal profile = ProfileStore.waitForProfile(player)",
  ),
  tool(
    "t5",
    T2 + sec(39),
    "Edit",
    {
      file_path: "src/server/Pollen/PollenLeaderstats.luau",
      old_string: '\tlocal pollen = Instance.new("IntValue")\n\tpollen.Name = "Pollen"\n\tpollen.Value = 0',
      new_string:
        '\tlocal profile = ProfileStore.waitForProfile(player)\n\tif not profile then\n\t\t-- A failed load must never stamp 0 over a good value.\n\t\treturn\n\tend\n\n\tlocal pollen = Instance.new("IntValue")\n\tpollen.Name = "Pollen"\n\tpollen.Value = profile.Data.pollen',
    },
    "Applied 1 edit to src/server/Pollen/PollenLeaderstats.luau",
  ),
  activity(
    "a4",
    T2 + sec(48),
    "edit",
    "Changed Source on ServerScriptService.Pollen.PollenLeaderstats",
    "Seeds the leaderstat from the loaded profile and bails out when there is none",
    "ok",
    [ref("ServerScriptService.Pollen.PollenLeaderstats", "Script")],
  ),
  activity("a5", T2 + sec(60), "playtest", "Started a playtest", "Server and one client", "running"),
];

// ---------------------------------------------------------------------------
// The change journal
//
// What has been done to Bee Simulator 6 in this Studio window — which is not
// only the open chat's work, because the journal is per place and the honey
// balancing chat is editing the same game.
//
// The dock opens every diff, so the order matters: the list runs oldest first
// and the top of it is what ends up in the picture.
// ---------------------------------------------------------------------------

const LEADERSTATS_BEFORE = `local Players = game:GetService("Players")

local function onPlayerAdded(player: Player)
\tlocal stats = Instance.new("Folder")
\tstats.Name = "leaderstats"

\tlocal pollen = Instance.new("IntValue")
\tpollen.Name = "Pollen"
\tpollen.Value = 0
\tpollen.Parent = stats

\tstats.Parent = player
end

Players.PlayerAdded:Connect(onPlayerAdded)
`;

const LEADERSTATS_AFTER = `local Players = game:GetService("Players")

local ProfileStore = require(script.Parent.Parent.Data.ProfileStore)

local function onPlayerAdded(player: Player)
\tlocal stats = Instance.new("Folder")
\tstats.Name = "leaderstats"

\tlocal profile = ProfileStore.waitForProfile(player)
\tif not profile then
\t\t-- A failed load must never stamp 0 over a good value.
\t\treturn
\tend

\tlocal pollen = Instance.new("IntValue")
\tpollen.Name = "Pollen"
\tpollen.Value = profile.Data.pollen
\tpollen.Parent = stats

\tstats.Parent = player
end

Players.PlayerAdded:Connect(onPlayerAdded)
`;

const HIVE_CONFIG_BEFORE = `local HiveConfig = {}

HiveConfig.tiers = {
\t{ name = "Wooden", cost = 0, rate = 1 },
\t{ name = "Stone", cost = 250, rate = 1.6 },
\t{ name = "Gilded", cost = 1200, rate = 2.4 },
\t{ name = "Diamond", cost = 9000, rate = 4 },
}

return HiveConfig
`;

const HIVE_CONFIG_AFTER = `local HiveConfig = {}

HiveConfig.tiers = {
\t{ name = "Wooden", cost = 0, rate = 1 },
\t{ name = "Stone", cost = 250, rate = 1.6 },
\t{ name = "Gilded", cost = 1200, rate = 2.4 },
\t{ name = "Diamond", cost = 4800, rate = 3.1 },
}

return HiveConfig
`;

const change = (record) => ({
  chat: null,
  session: SESSION_ID,
  parentPath: null,
  revertable: true,
  reason: null,
  ...record,
});

const CHANGES = [
  // The other Bee chat, mid-turn on tier 4 pricing.
  change({
    id: "chg_tier4",
    op: "edit.attributes",
    activityId: "act_honey_1",
    chat: "thr_honey",
    at: NOW - min(16),
    kind: "attributes",
    target: ref("ReplicatedStorage.Config.Hives.Tier4", "Configuration"),
    summary: "Set HoneyCost and PollenRate on Tier4",
    attributes: [
      { name: "HoneyCost", before: 9000, after: 4800 },
      { name: "PollenRate", before: 4, after: 3.1 },
    ],
  }),
  change({
    id: "chg_hiveconfig",
    op: "edit.source",
    activityId: "act_honey_2",
    chat: "thr_honey",
    at: NOW - min(3),
    kind: "source",
    target: ref("ReplicatedStorage.Config.HiveConfig", "ModuleScript"),
    summary: "Changed the source of HiveConfig",
    source: {
      before: HIVE_CONFIG_BEFORE,
      after: HIVE_CONFIG_AFTER,
      beforeLines: lines(HIVE_CONFIG_BEFORE),
      afterLines: lines(HIVE_CONFIG_AFTER),
    },
  }),

  // The open chat's live turn: the same edit tool call `t5` made, as the place
  // recorded it.
  change({
    id: "chg_leaderstats",
    op: "edit.source",
    activityId: "act_a4",
    chat: OPEN,
    at: T2 + sec(48),
    kind: "source",
    target: ref("ServerScriptService.Pollen.PollenLeaderstats", "Script"),
    summary: "Changed the source of PollenLeaderstats",
    source: {
      before: LEADERSTATS_BEFORE,
      after: LEADERSTATS_AFTER,
      beforeLines: lines(LEADERSTATS_BEFORE),
      afterLines: lines(LEADERSTATS_AFTER),
    },
  }),
];

// ---------------------------------------------------------------------------
// Studio, providers, versions
// ---------------------------------------------------------------------------

const SESSION = {
  id: SESSION_ID,
  installId: "inst_9f31c0",
  windowId: "win_01",
  place: {
    name: "Bee Simulator 6",
    placeId: 8421771003,
    gameId: 4712880153,
    identity: "game:4712880153",
    unsaved: false,
    nameSource: "published",
    creatorId: 1174763,
    creatorType: "Group",
  },
  studioVersion: "0.712.1.7120583",
  pluginVersion: "0.4.2",
  status: "connected",
  endpoints: [
    {
      id: "ep_edit",
      realm: "edit",
      run: { running: false, edit: true, mode: null, realm: "edit", epoch: 4 },
      lastSeen: NOW - sec(1),
      polling: true,
    },
  ],
  run: { running: false, edit: true, mode: null, realm: "edit", epoch: 4 },
  lastSeen: NOW - sec(1),
  active: true,
};

const CAPABILITIES = [
  ["inspect.datamodel", "studio-plugin"],
  ["inspect.scripts", "studio-plugin"],
  ["inspect.selection", "studio-plugin"],
  ["edit.instances", "studio-plugin"],
  ["edit.scripts", "studio-plugin"],
  ["edit.undo-history", "studio-plugin"],
  ["playtest.run", "studio-plugin"],
  ["playtest.play", "studio-plugin"],
  ["output.capture", "studio-plugin"],
  ["runtime.inspect", "studio-plugin"],
  ["runtime.exec", "studio-plugin"],
  ["input.virtual", "studio-plugin"],
  ["input.native", "native"],
  ["view.screenshot", "native"],
].map(([id, provider]) => ({ id, available: true, provider }));

const AGENTS = [
  {
    id: "claude",
    label: "Claude Code",
    command: "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
    version: "2.1.224",
    installed: true,
    problem: null,
    installHint: "npm i -g @anthropic-ai/claude-code",
    latestVersion: "2.1.224",
    updateCommand: "npm i -g @anthropic-ai/claude-code@latest",
  },
  {
    // Deliberately a version behind, so the amber count on Settings → Providers
    // is in the shot rather than being a feature you have to describe.
    id: "codex",
    label: "Codex",
    command: "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd",
    version: "0.58.0",
    installed: true,
    problem: null,
    installHint: "npm i -g @openai/codex",
    latestVersion: "0.59.1",
    updateCommand: "npm i -g @openai/codex@latest",
  },
];

const EFFORT = {
  id: "effort",
  label: "Reasoning",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
    { value: "ultracode", label: "Ultracode" },
    { value: "ultrathink", label: "Ultrathink" },
  ],
};

const CONTEXT_1M = { id: "context1m", label: "1M context", kind: "boolean", default: true };
const FAST_MODE = { id: "fastMode", label: "Fast mode", kind: "boolean", default: false };

const MODELS = [
  { slug: "claude-opus-5", name: "Claude Opus 5", provider: "claude", isDefault: true, options: [EFFORT, FAST_MODE, CONTEXT_1M] },
  { slug: "claude-fable-5", name: "Claude Fable 5", provider: "claude", options: [EFFORT, CONTEXT_1M] },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "claude", options: [EFFORT] },
  { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "claude", options: [] },
  {
    slug: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    provider: "codex",
    isDefault: true,
    options: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        kind: "select",
        choices: [
          { value: "low", label: "Low", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra High" },
        ],
      },
    ],
  },
];

const VERSIONS = {
  update: {
    state: "idle",
    channel: "release",
    currentVersion: "0.4.2",
    availableVersion: null,
    percent: 0,
    message: null,
    checkedAt: NOW - min(6),
    releaseUrl: "https://github.com/luumenlabs/code/releases",
  },
  plugin: {
    supported: true,
    directory: "C:\\Users\\dev\\AppData\\Local\\Roblox\\Plugins",
    fileName: "LuuCode.rbxm",
    bundledVersion: "0.4.2",
    installedVersion: "0.4.2",
    installed: true,
    message: null,
  },
  mcpCommand: '"C:\\Program Files\\Luu Code\\Luu Code.exe" "C:\\Program Files\\Luu Code\\resources\\app\\dist\\mcp\\server.cjs"',
};

/** Studio output, so the dock's second tab is not empty if you switch to it. */
const OUTPUT = [
  { cursor: 1, realm: "server", source: "PollenService", type: "info", message: "Profile store ready (2 sessions)" },
  { cursor: 2, realm: "server", source: "HiveSpawner", type: "output", message: "Spawned 48 bees across 6 hives" },
  { cursor: 3, realm: "client", source: null, type: "output", message: "Pollen HUD mounted" },
  { cursor: 4, realm: "server", source: "PollenLeaderstats", type: "warning", message: "leaderstats written before profile load — seeding from default" },
  { cursor: 5, realm: "server", source: "PollenService", type: "output", message: "AddPollen(player=Nectarine_Dev, amount=14)" },
  { cursor: 6, realm: "client", source: null, type: "output", message: "Field 3 unlocked" },
];

const SNAPSHOT = {
  status: {
    serverVersion: "0.4.2",
    sessions: [SESSION],
    activeSessionId: SESSION.id,
    chats: Object.fromEntries(THREADS.map((thread) => [thread.id, SESSION.id])),
    pending: [],
  },
  capabilities: {
    capabilities: CAPABILITIES,
    permissions: { inspect: true, edit: true, playtest: true, exec: true, input: true, screenshot: true },
    disabledTools: [],
    platform: "win32",
  },
  agents: AGENTS,
  models: MODELS,
  modelProblem: null,
  settings: {
    titleGeneration: { enabled: true, provider: "auto", model: null },
    plugin: { autoInstall: true },
    customModels: {},
    favourites: [{ id: "fav_opus_max", model: "claude-opus-5", options: [{ id: "effort", value: "max" }] }],
    globalRules: "",
    showThinking: true,
    // Off, so a warning line in the mock output cannot flip the dock to the
    // Output tab a second before the shutter.
    followRuntimeErrors: false,
    // Wider than the default dock: the panel is showing diffs, and a line of
    // Luau that runs out of room is the one thing a diff cannot afford.
    layout: { sidebarWidth: 276, dockWidth: 430 },
  },
  session: { agent: "claude", state: "working", sessionId: "sess_a91f", model: "claude-opus-5", message: null },
  agentStates: AGENT_STATES,
  serverPort: 41703,
  mcpCommand: VERSIONS.mcpCommand,
  versions: VERSIONS,
  platform: process.platform,
  channel: "release",
  threads: { projects: PROJECTS, threads: THREADS, activeThreadId: OPEN },
  thread: {
    ...THREADS.find((thread) => thread.id === OPEN),
    agentSessionId: "sess_a91f",
    modelSelection: { model: "claude-opus-5", options: [{ id: "effort", value: "high" }] },
    items: TIMELINE,
    // The conversation's own half of the journal, which is what puts the
    // "1 change" fold under its second turn.
    changes: CHANGES.filter((record) => record.chat === OPEN),
  },
  modelSelection: { model: "claude-opus-5", options: [{ id: "effort", value: "high" }] },
  pendingAsks: {},
};

module.exports = { SNAPSHOT, OUTPUT, VERSIONS, AGENTS, CHANGES };
