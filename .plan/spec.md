# Luu Code — Product and Technical Specification

## 1. Overview

Luu Code is an open-source, Roblox Studio-specific UI harness and local integration layer for coding agents such as Claude Code and Codex.

Its purpose is simple: allow existing coding agents to directly understand, modify, run, observe, interact with, and test Roblox experiences inside Roblox Studio.

Luu Code does not provide its own AI models, sell model credits, or require users to supply API keys for a proprietary inference layer. Users authenticate through and use the coding agents they already have access to.

The application exists because general-purpose coding-agent interfaces cannot natively connect those agents to Roblox Studio with the tools required for a complete agentic development loop.

Luu Code provides that missing connection.

The same Roblox Studio capabilities must also be exposed through a local MCP server so users can keep using an external agent interface if they prefer, while still gaining access to Roblox Studio.

---

## 2. Product Thesis

Roblox development has two common agentic workflows today.

The first is Studio-native development, where most of the project exists inside Roblox Studio. General coding agents are poorly suited to this because they primarily operate on the local filesystem and do not have direct access to the Studio DataModel, script editor contents, runtime state, viewport, playtesting environment, or Studio output.

The second is filesystem-based development using tools such as Rojo. In this workflow, coding agents can already edit the project files effectively, but their visibility usually stops at the filesystem. They cannot reliably inspect the resulting Studio state, run the experience, observe runtime behavior, interact with the game, visually verify the result, or autonomously correct problems discovered during testing.

Luu Code solves both problems with the same Studio connection.

For Studio-native development, the agent can directly inspect and edit Roblox Studio.

For Rojo-based development, the existing filesystem and Rojo workflow remains intact, while Luu Code gives the agent access to the Studio and runtime side of the development loop.

The core product is therefore not a replacement for Rojo, T3 Code, Claude Code, Codex, or Roblox Studio.

It is the missing Roblox Studio control and observation layer for coding agents.

---

## 3. Core Principles

### 3.1 Roblox Studio only

Luu Code is specifically designed around Roblox Studio.

It is not a general-purpose local coding environment and should not attempt to replace existing coding-agent applications for editing arbitrary files on the user's computer.

If a user wants a general-purpose coding agent for their filesystem, they should continue using tools built for that purpose.

Luu Code focuses only on the capabilities that those tools cannot provide: direct interaction with Roblox Studio and a running Roblox experience.

### 3.2 Bring your existing coding agent

Luu Code should use existing coding-agent CLIs and their existing authentication.

The user should not need to:

- purchase credits from Luu Code;
- provide an Anthropic, OpenAI, or other model API key to Luu Code;
- use a model hosted or proxied by Luu Code;
- pay for a second AI subscription solely to gain Roblox integration.

The product should work with supported agents through their existing local CLI sessions and authentication mechanisms.

### 3.3 First-party harness, open integration

The Electron application is the first-party UI harness and should provide the richest experience.

At the same time, the underlying Roblox Studio capabilities should not be locked to that application.

A local MCP server must expose the Roblox-facing functionality so users can connect supported external agents and agent interfaces to Roblox Studio without using the Luu Code UI.

### 3.4 Keep the system simple

The product should expose the minimum number of concepts required to give coding agents meaningful control over Roblox Studio.

Avoid inventing unnecessary frameworks, project models, intermediate abstractions, or replacement workflows.

Roblox Studio remains Roblox Studio.

Rojo remains Rojo when the user already uses it.

Claude Code remains Claude Code.

Codex remains Codex.

Luu Code connects them.

### 3.5 Agents must be able to verify their own work

Editing code or instances is not enough.

The defining capability of Luu Code is that an agent can complete a full development loop:

1. inspect the current experience;
2. make a change;
3. run the experience;
4. observe what happened;
5. inspect errors and runtime state;
6. visually inspect the game where useful;
7. interact with the game where useful;
8. determine whether the requested behavior works;
9. fix problems;
10. repeat until the task is complete.

The product should make verification a natural part of agent behavior rather than an optional add-on.

---

## 4. Users

Luu Code is primarily for Roblox developers who already use or want to use coding agents such as Claude Code and Codex.

Relevant users include:

- Roblox developers who work directly inside Studio and do not want to install paid AI Studio extensions;
- developers who already pay for a coding-agent subscription and want to use that subscription for Roblox development;
- Rojo users who want their coding agent to test changes inside Roblox Studio;
- developers who prefer an external agent interface but still want Roblox Studio access through MCP;
- open-source contributors building additional agent integrations or Studio tooling around the local server.

The product should be useful to both experienced Roblox developers and developers who primarily think in terms of modern coding-agent workflows.

---

## 5. High-Level System

The system consists of four major pieces.

### 5.1 Electron application

The Electron application is the first-party Roblox-specific coding-agent harness.

It is responsible for:

- providing the user-facing agent session;
- starting and managing supported coding-agent CLI sessions;
- presenting agent messages and activity;
- presenting Roblox-specific tool activity;
- displaying screenshots and other Studio observations;
- surfacing runtime errors and relevant output;
- allowing the user to understand what the agent is doing inside Studio;
- providing controls that are specifically useful for Roblox development;
- coordinating native capabilities that are difficult or inappropriate to expose solely through MCP.

The application should feel like a focused Roblox agent interface, not a general IDE.

### 5.2 Local server

A local server sits between the coding agent, the Electron application, and Roblox Studio.

It is the central communication layer for the local system.

Its responsibilities include:

- maintaining the connection to Roblox Studio;
- exposing Studio capabilities to the Electron harness;
- exposing Roblox capabilities through MCP;
- routing requests and responses;
- tracking Studio connection state;
- handling screenshots and other binary observations;
- coordinating playtesting and runtime interaction;
- enforcing local permissions and safety boundaries;
- normalizing Roblox operations into a consistent local interface.

The local server should remain local by default. The product should not require a hosted Luu Code backend for core functionality.

### 5.3 Roblox Studio integration

A Roblox Studio integration provides the agent-facing connection into Studio.

Depending on what is technically required, this may include a Studio plugin, native process integration, or both.

The Studio integration is responsible for exposing Roblox-specific operations and observations that cannot be obtained from a normal filesystem agent.

It should allow the local system to inspect and manipulate relevant Studio state, control playtesting, retrieve output and runtime information, capture or coordinate visual observations, and support game interaction.

### 5.4 Local MCP server

The local server must expose an MCP interface containing the Roblox Studio capabilities that can be meaningfully represented as MCP tools and resources.

This allows external MCP-capable coding agents to use Luu Code's Studio integration without using the Electron application.

The MCP server is an alternate client interface to the same local Roblox capabilities, not a separate product.

The first-party Electron harness may provide richer functionality than the MCP interface where native integration or custom orchestration is beneficial.

---

## 6. Supported Agent Model

Luu Code should support coding agents through their local CLI interfaces.

Initial design assumptions should support at least:

- Claude Code;
- Codex.

The architecture should avoid coupling the Roblox integration to the behavior of a single model provider.

Agent-specific differences should be handled at the harness boundary rather than leaking into Roblox Studio.

The coding agent remains responsible for reasoning about the user's request, deciding what Roblox information it needs, deciding what changes to make, deciding when to run or test the game, interpreting observations, and deciding when the task is complete.

Luu Code should provide capabilities and context, not attempt to duplicate the coding agent's reasoning.

---

## 7. Agent Session Experience

The first-party application should provide a persistent coding-agent session centered on Roblox Studio.

A user should be able to open Luu Code, connect it to Studio, select or start a supported coding agent, describe a task, and let the agent operate.

The user should be able to see:

- the conversation;
- what Roblox actions the agent is taking;
- which Studio objects or scripts are being inspected;
- which Studio objects or scripts are being changed;
- when the game is being started or stopped;
- errors or warnings that matter to the task;
- screenshots captured by the agent;
- relevant observations made during testing;
- when the agent considers the task complete.

The interface should make agent activity understandable without overwhelming the user with raw protocol traffic.

The UI should remain focused on Roblox work.

It should not become a generic filesystem browser, terminal replacement, or local source-code editor unless a small embedded view is directly necessary for understanding a Roblox operation.

---

## 8. Roblox Studio Connection

The user must be able to establish a trusted local connection between Luu Code and Roblox Studio.

The connection should make it obvious:

- whether Studio is connected;
- which open Studio session or place is connected;
- whether the connection is currently usable;
- whether the game is currently in edit mode or a playtest;
- whether a requested operation failed because Studio is unavailable.

The connection should be local and explicit.

The system should not silently connect to arbitrary remote Studio instances.

If multiple Studio windows or sessions are available, the user should be able to identify and select the intended one.

The product should handle Studio restarts and temporary disconnections gracefully.

---

## 9. Studio Inspection Capabilities

The agent must be able to inspect the current Roblox experience directly from Studio.

The inspection surface should include the information necessary for an agent to understand the game without forcing the entire experience into a giant prompt.

The agent should be able to request information progressively.

Relevant capabilities include:

### 9.1 DataModel inspection

The agent must be able to inspect the Roblox DataModel hierarchy.

It should be possible to:

- inspect top-level services;
- enumerate descendants;
- inspect a specific instance;
- inspect children of an instance;
- search for instances;
- identify instance classes;
- read names and paths;
- read relevant properties;
- read attributes;
- read tags or equivalent metadata where available;
- distinguish scripts, modules, GUI objects, parts, models, values, services, and other common instance types.

The agent should not need the entire DataModel every time it asks a question.

The system should support scoped inspection.

### 9.2 Script inspection

The agent must be able to read script source stored in Roblox Studio.

This includes relevant script types supported by Studio.

The agent should be able to discover scripts from the DataModel and request their source when needed.

The system should preserve the relationship between a script and its Studio location.

### 9.3 Selection and context

Where useful, the system should allow the agent to inspect:

- the currently selected Studio instances;
- the current place or experience context;
- relevant Studio state associated with the current editing session.

User selection can provide useful context but should not be required for normal agent operation.

---

## 10. Studio Editing Capabilities

The agent must be able to make real changes to the open Roblox Studio experience.

The edit surface should support the common operations needed to build and maintain a Roblox game.

### 10.1 Instance operations

The agent should be able to:

- create instances;
- delete instances;
- rename instances;
- reparent instances;
- duplicate or clone instances where appropriate;
- change supported properties;
- set or remove attributes;
- manipulate relevant metadata;
- create and modify common GUI objects;
- create and modify models, folders, values, parts, and other standard Roblox objects.

Operations must target specific Studio instances and return enough information for the agent to know whether the requested change succeeded.

### 10.2 Script operations

The agent must be able to:

- create scripts;
- read existing source;
- replace or modify script source;
- rename scripts;
- move scripts;
- delete scripts.

The system should detect and surface failures related to invalid targets, unavailable source access, Studio restrictions, or other relevant problems.

### 10.3 Edit integrity

The system should avoid ambiguous edits.

An agent operation should identify its intended target clearly enough that accidental edits to similarly named objects are minimized.

When an operation changes Studio state, the local server should return clear confirmation of what was changed or why the operation failed.

---

## 11. Native Studio Projects

A major goal of Luu Code is to make agentic development practical for projects that primarily live inside Roblox Studio.

A user should not need to install Rojo merely to let an agent make useful changes.

For these projects, the coding agent should use Luu Code's Roblox capabilities to inspect and edit Studio directly.

The user should not have to think about manual source synchronization between a generated local mirror and Studio.

The Studio integration itself is the editing path.

The application should not introduce a second project representation that the user must manage.

---

## 12. Rojo Workflows

Luu Code must work well with Rojo-based projects without attempting to replace Rojo.

When a coding agent already has access to a Rojo project's local files, it can continue editing those files through its normal environment.

Rojo remains responsible for synchronizing those project changes into Roblox Studio.

Luu Code adds the missing Studio and runtime capabilities.

In a Rojo workflow, the agent should be able to:

- observe the resulting Studio DataModel;
- inspect Studio-only state not represented by the filesystem;
- start and stop playtests;
- inspect Studio output;
- observe runtime behavior;
- capture screenshots;
- interact with the running game;
- determine whether filesystem changes actually produced the intended result;
- make additional Roblox Studio changes when appropriate and safe.

Luu Code should not interfere with Rojo's ownership of synchronized content.

Where a Studio edit would conflict with a Rojo-managed object and would likely be overwritten, the agent should be given enough context to avoid making the wrong kind of change.

The product should not require the user to choose between "Rojo mode" and "native mode" unless such a distinction is genuinely necessary for safety.

The expected behavior should be inferred from the connected Studio project and the coding agent's working context where possible.

---

## 13. Playtesting

The agent must be able to control Roblox Studio playtesting as part of the same task.

At minimum, the system should support:

- starting a playtest;
- stopping a playtest;
- determining whether a playtest is currently active;
- detecting transitions between edit and play states;
- waiting for the running experience to become ready enough for observation;
- restarting a playtest when appropriate.

The agent should not require the user to manually click Play after every change.

Playtesting is part of the normal agent loop.

The system should clearly separate edit-time Studio state from runtime state so the agent does not confuse one for the other.

---

## 14. Studio Output and Diagnostics

The agent must be able to inspect errors, warnings, and other useful runtime output from Studio.

The system should support retrieval of relevant output generated during:

- script execution;
- game startup;
- runtime interaction;
- agent-triggered test actions.

The agent should be able to determine whether new errors appeared after its change.

Output should preserve enough context to be useful, including the message and any available source information.

The product should avoid flooding the agent with large quantities of irrelevant historical output.

The agent should be able to retrieve recent output or output associated with the current testing cycle.

Where possible, runtime failures should be surfaced to the active agent session automatically so the agent can react without the user manually copying errors into chat.

---

## 15. Runtime Inspection

The agent must be able to inspect relevant state while the game is running.

This is necessary for reliable testing because many bugs cannot be understood from source code or screenshots alone.

The runtime inspection layer should allow the agent to inspect relevant live Roblox state, including where technically possible:

- active players;
- the local player;
- characters;
- runtime-created instances;
- PlayerGui;
- Backpack and tools;
- replicated values;
- attributes;
- relevant object properties;
- GUI visibility and state;
- current camera state;
- runtime instance hierarchy.

The exact inspection capabilities should respect Roblox Studio's security model and technical limitations.

Runtime inspection should favor structured state over forcing the agent to infer everything from pixels.

---

## 16. Runtime Execution

Where Roblox Studio allows it, the agent should be able to execute controlled Luau or equivalent test operations within the appropriate Studio or playtest context.

This capability exists to improve debugging and verification.

It may be used to:

- inspect a runtime value;
- invoke a test helper;
- establish state required for a test;
- verify assumptions;
- query information that is otherwise difficult to expose through dedicated operations.

Runtime execution must be treated as a powerful capability.

It should be clearly scoped to the connected local Studio session and governed by the same trust model as other Studio edits.

The product should not hide from the user that the coding agent has the ability to execute actions inside their current Roblox development environment.

---

## 17. Screenshots and Visual Observation

The agent must be able to capture visual observations of Roblox Studio or the running game.

Screenshots are required because structured data alone cannot answer questions such as:

- whether a UI looks correct;
- whether elements overlap;
- whether spacing or alignment is wrong;
- whether the game visually resembles the requested result;
- whether an animation, scene, or interface appears as expected;
- whether a visual bug is present despite correct underlying state.

The system should be able to capture the relevant game or Studio viewport without requiring the user to manually take and attach screenshots.

The first-party harness should be capable of passing those screenshots directly into coding agents that support image understanding.

The agent should decide when a screenshot is useful.

The product should not take continuous screenshots unnecessarily.

Screenshots should be associated with the current agent task and testing context so they can be understood in sequence.

---

## 18. Game Interaction

The agent must be able to interact with a running Roblox experience sufficiently to test user-facing behavior.

This includes interaction with:

- Roblox GUI;
- keyboard-controlled gameplay;
- mouse-controlled gameplay;
- common prompts and buttons;
- character movement;
- other interaction surfaces that are relevant to testing a game.

Interaction may use different mechanisms depending on what Roblox Studio exposes reliably.

The product should prefer deterministic, structured interaction when possible and use lower-level native input when necessary.

The important product requirement is not a specific implementation mechanism.

The requirement is that the coding agent can perform meaningful end-to-end testing of the game rather than merely starting it.

The agent should be able to observe the result of an interaction before deciding what to do next.

---

## 19. End-to-End Agent Loop

A central success criterion for Luu Code is that a coding agent can complete a full task without requiring the user to manually bridge the gap between source changes and Studio testing.

A typical successful loop should be possible entirely through the harness:

1. The user describes a Roblox development task.
2. The agent inspects the relevant Studio state.
3. The agent inspects relevant scripts or objects.
4. The agent makes the necessary changes.
5. The agent starts the game.
6. The agent watches for runtime errors.
7. The agent inspects relevant runtime state.
8. The agent captures visual evidence where useful.
9. The agent interacts with the running game where useful.
10. The agent determines whether the behavior matches the user's request.
11. If not, the agent makes another change and repeats the loop.
12. The agent reports completion only after it has reasonable evidence that the requested change works.

The system should make this loop fast enough that agents naturally use it rather than avoiding testing because the integration is cumbersome.

---

## 20. Testing Philosophy

Luu Code should encourage agents to verify behavior rather than claim success based only on code edits.

The product should give the agent multiple forms of evidence:

- Studio structure;
- script source;
- runtime state;
- output and errors;
- screenshots;
- game interaction results.

The agent should use the strongest available evidence for the task.

For example:

- a GUI visibility property is better verified structurally than guessed from a screenshot;
- layout quality is better judged from a screenshot than from raw properties alone;
- a purchase mechanic is better verified by both interaction and runtime state than by source inspection alone;
- a runtime exception should be read directly from Studio output.

The product should not force every task through the same testing procedure.

The coding agent should choose what evidence is appropriate.

---

## 21. MCP Interface

The local MCP server is a required part of the product.

Its purpose is to make the Roblox Studio integration useful outside the Luu Code Electron harness.

A user should be able to connect an MCP-capable coding agent to the local Luu Code server and gain access to Roblox Studio.

The MCP interface should expose the Roblox operations that translate naturally into agent tools and resources.

This should include the practical equivalents of:

- Studio and DataModel inspection;
- instance inspection;
- script reading;
- instance creation and editing;
- script editing;
- playtest control;
- Studio output;
- runtime inspection;
- runtime execution where supported;
- screenshots;
- game interaction where it can be exposed reliably through MCP.

The MCP interface should describe operations clearly enough that an external coding agent can use them without knowledge of the Luu Code Electron application.

MCP should not require the Electron UI to remain open if the local service and Studio connection can operate independently.

The MCP interface should be treated as a stable integration surface.

---

## 22. First-Party Harness Advantages

The first-party Electron application should remain useful even though MCP is available.

It can provide a better Roblox-specific experience because it controls both the agent session and the Roblox integration.

Advantages may include:

- automatic presentation of screenshots in the active conversation;
- richer rendering of Roblox tool calls;
- clearer presentation of Studio objects being changed;
- tighter lifecycle management for Claude Code or Codex;
- native handling of input and screenshot capabilities;
- automatic surfacing of runtime failures;
- Roblox-specific session controls;
- easier connection management;
- better visibility into active playtesting;
- an interface designed specifically around Studio work rather than generic coding tasks.

These advantages should arise naturally from owning the harness.

The product should not intentionally cripple the MCP path in order to force users into the Electron app.

---

## 23. External Agent Use

A user who prefers another coding-agent UI should be able to use it.

For example, a user may prefer to keep a Claude Code or Codex session inside another harness.

As long as that agent environment supports MCP and the user's agent can access the local MCP endpoint, it should be able to use the Roblox integration.

In this case:

- the external application remains responsible for its own conversation UI;
- the coding agent remains responsible for reasoning;
- Luu Code provides the Roblox Studio tools;
- the local server maintains the Studio connection;
- the first-party Electron-specific conveniences are not assumed.

This is an intentional open-system design.

---

## 24. Agent Responsibility

The coding agent is responsible for deciding how to solve the user's task.

Luu Code should not hard-code a development methodology into the system.

The agent decides:

- what information to inspect;
- which scripts to read;
- which Studio objects to inspect;
- whether an object should be edited or recreated;
- whether a script change is required;
- when to run the game;
- what output matters;
- when to inspect runtime state;
- when a screenshot is needed;
- how to interact with the game;
- whether the result is correct;
- whether another iteration is needed.

Luu Code provides the tools, observations, transport, permissions, and UI needed to make those decisions actionable.

The product specification should avoid dictating coding strategies that belong to Claude Code, Codex, or future coding agents.

---

## 25. User Control

The agent may have powerful access to Roblox Studio, so the user needs understandable control over the session.

The application should provide clear ways to:

- stop the active agent;
- stop a running playtest;
- disconnect from Studio;
- see whether the agent is currently taking an action;
- identify which Studio session is connected;
- understand when the agent is about to or has made a significant Studio change;
- recover from a failed or stuck connection.

The user should not need to approve every small operation by default, because that would undermine the agentic workflow.

However, the product should make dangerous or unusually broad actions visible and support appropriate permission controls.

---

## 26. Permissions and Trust

Luu Code runs locally and can modify the user's open Roblox project.

The trust model should be explicit.

The user should understand that an active coding agent may be able to:

- read scripts in the connected project;
- modify scripts;
- create, edit, or delete instances;
- run the game;
- execute test operations;
- interact with the running experience;
- capture Studio or game screenshots;
- inspect runtime state.

The system should scope these permissions to the intended Roblox Studio session.

A malicious local process should not be able to control Studio merely by discovering an unauthenticated local endpoint.

The local connection should therefore use an appropriate local trust mechanism.

Remote network access should not be enabled by default.

---

## 27. Safety Boundaries

The product should protect against accidental damage without turning every edit into a confirmation dialog.

Important safeguards include:

- restricting operations to the connected Studio session;
- preventing accidental cross-project targeting;
- handling stale instance references safely;
- returning clear failures instead of silently targeting a different object;
- stopping operations cleanly when Studio disconnects;
- avoiding uncontrolled repeated input when a playtest becomes unresponsive;
- limiting screenshot capture to the relevant application or viewport where possible;
- clearly separating commands intended for edit mode from commands intended for runtime.

The user should retain access to Studio's normal undo and recovery mechanisms wherever technically possible.

Luu Code should not attempt to bypass Roblox Studio security restrictions.

---

## 28. Privacy

Core Luu Code functionality should operate locally.

Roblox project data, source code, screenshots, runtime state, and other observations should not be uploaded to a Luu Code-controlled service as a requirement for using the product.

Data will naturally be provided to the coding agent or model provider selected by the user when that information is included in the agent session.

Luu Code should make that distinction clear.

The project should not add unnecessary telemetry around source code, screenshots, prompts, or project contents.

If telemetry exists, it should be minimal, transparent, and configurable.

---

## 29. Connection Lifecycle

The system should handle the normal local development lifecycle gracefully.

This includes:

- Luu Code opening before Studio;
- Studio opening before Luu Code;
- a Studio project being closed;
- another Studio project being opened;
- Studio restarting;
- the local server restarting;
- the coding agent restarting;
- a playtest starting or stopping manually;
- temporary loss of communication;
- multiple Studio windows.

The user should not need to repeatedly reinstall or reconfigure the Studio integration during normal use.

Reconnection should be simple and predictable.

---

## 30. State and Identity

Roblox instances may move, be renamed, be recreated, or exist only during runtime.

The local system should provide enough identity tracking to avoid unreliable agent actions.

The exact identity mechanism is an implementation detail, but the product behavior should satisfy these requirements:

- an operation should target the instance the agent actually inspected;
- stale targets should fail clearly;
- runtime-only objects should not be confused with edit-time objects;
- renamed or moved objects should be represented accurately;
- the agent should be able to rediscover an object when a prior reference is no longer valid.

The user should not have to understand this identity mechanism.

---

## 31. Performance

The integration must be responsive enough for iterative agent development.

Important performance goals include:

- Studio inspection returning quickly enough for interactive reasoning;
- small edits applying without noticeable synchronization overhead;
- output and errors reaching the agent promptly;
- playtest state changes being detected quickly;
- screenshots being captured and delivered without excessive delay;
- repeated runtime inspection not freezing Studio;
- large DataModels remaining navigable through scoped queries.

The system should avoid repeatedly serializing or sending the entire game when the agent only needs a small part of it.

---

## 32. Failure Handling

Every Roblox-facing operation should fail clearly.

Failures should distinguish useful categories such as:

- Studio is not connected;
- the target no longer exists;
- the operation is unavailable in the current Studio state;
- the operation is not allowed by Roblox;
- the playtest is not running;
- the requested runtime context is unavailable;
- input could not be delivered;
- screenshot capture failed;
- the Studio plugin or native bridge stopped responding.

Errors should be understandable by both the coding agent and the user.

The agent should be able to recover where appropriate by inspecting current state and trying a different action.

---

## 33. Observability

The first-party application should make the agent's Roblox activity understandable.

The user should be able to distinguish between:

- agent reasoning or conversation;
- Studio inspection;
- Studio edits;
- playtest actions;
- runtime inspection;
- visual observation;
- user-input simulation;
- errors.

This does not require showing every internal protocol message.

The interface should summarize actions in human-readable Roblox terms.

For example, the user should understand that the agent changed a script in ServerScriptService or started a playtest, rather than seeing only opaque tool identifiers.

---

## 34. Studio Changes and User Changes

The user may continue editing Studio while the agent is working.

The product should assume that human and agent activity can coexist.

It should avoid holding a stale snapshot of the project as authoritative.

Before performing operations that depend on current state, the agent should be able to retrieve fresh Studio information.

If the user changes or removes an object the agent previously inspected, the next agent action should either operate on the new current state or fail clearly.

Luu Code should not attempt to lock the Studio project while the agent is active.

---

## 35. Rojo Conflict Awareness

When a connected project contains content controlled by Rojo, direct Studio edits to that content may be overwritten by normal Rojo synchronization.

Luu Code should make this condition visible to the coding agent where it can be detected.

The system does not need to become a Rojo project manager.

It only needs to give the agent enough information to avoid making an obviously temporary Studio-side change when the corresponding source should instead be changed through the coding agent's normal filesystem access.

For Rojo users, Luu Code's primary value remains Studio observation, runtime control, testing, visual understanding, and interaction.

---

## 36. Visual Testing

Visual testing is a first-class capability, not a novelty feature.

The agent should be able to use current multimodal model capabilities to reason about screenshots captured during development.

Useful visual tasks include:

- checking whether UI appears;
- checking alignment and spacing;
- spotting overlapping elements;
- checking whether a scene visually changed;
- confirming that a model or effect is visible;
- detecting obvious graphical regressions;
- comparing the result with the user's visual instructions.

The system should make screenshot capture easy enough that agents use it whenever visual evidence is relevant.

It should not attempt to replace structured inspection with screenshots.

---

## 37. Interaction Testing

End-to-end testing should support real user flows where feasible.

Examples of the kinds of flows the system should make possible include:

- opening a menu;
- pressing a button;
- buying or equipping an item;
- moving a character;
- triggering a prompt;
- opening and closing UI;
- entering a gameplay area;
- checking whether an interaction changes visible or runtime state;
- performing a sequence of actions and observing the final result.

The exact test flow should be chosen by the coding agent according to the user's request.

Luu Code should provide reliable primitives rather than defining a separate test framework the user must learn.

---

## 38. No Proprietary Agent Dependency

The Roblox integration should not depend on an internal Luu Code agent.

There should be no hidden second "playtest agent," "Roblox agent," or other autonomous layer making decisions separately from the user's selected coding agent.

Claude Code, Codex, or another supported coding agent is the agent.

Luu Code gives that agent capabilities.

Internal services may coordinate transport, state, screenshots, input, or permissions, but they should not be presented as independent reasoning agents.

---

## 39. No General Filesystem Product

Luu Code should not expand into a general local coding product.

It should not attempt to compete with T3 Code or similar applications by adding arbitrary project editing, generalized source control workflows, broad terminal features, or unrelated developer tooling.

The product may interact with local processes when necessary to run coding agents or support Studio integration.

That is infrastructure, not the product surface.

The UI and feature decisions should remain centered on Roblox Studio.

---

## 40. No Mandatory Project Migration

A user should not have to convert their existing Roblox project into a proprietary Luu Code format.

Studio-native projects should remain Studio-native.

Rojo projects should remain Rojo projects.

Luu Code should adapt to the workflow rather than requiring the workflow to adapt to Luu Code.

---

## 41. No Hosted AI Billing

Luu Code should not build its business or product architecture around reselling tokens.

The product promise is that users can use coding agents they already have access to.

If a selected coding agent itself requires a subscription or other authentication, that relationship remains between the user and that provider.

Luu Code is responsible for Roblox integration, not model billing.

---

## 42. Open-Source Expectations

The project should be open source in a way that makes the Roblox integration genuinely useful to the community.

The parts required to connect a supported external coding agent to Roblox Studio should be inspectable and usable without relying on a closed Luu Code cloud service.

The local MCP interface is an important part of this openness.

The open-source nature of the project should allow contributors to:

- improve Studio support;
- add support for additional coding agents;
- improve the MCP interface;
- improve platform-specific native integration;
- improve testing and interaction reliability;
- fix compatibility issues with Roblox Studio updates.

---

## 43. Platform Expectations

The product should be designed for the desktop platforms on which Roblox Studio and the supported coding agents are realistically used.

Platform-specific behavior may be necessary for:

- Studio process discovery;
- window capture;
- native input;
- permissions;
- CLI discovery;
- local server lifecycle.

The product should present a consistent conceptual experience even when the implementation differs by operating system.

Unsupported platform limitations should be explicit rather than silently degraded.

---

## 44. Agent Discovery and Authentication

The first-party harness should detect supported coding-agent installations where practical.

The user should be able to choose which supported agent to use.

Luu Code should rely on the agent's existing local authentication rather than collecting provider API keys itself.

If the selected CLI is not installed or authenticated, the application should clearly explain that condition.

Luu Code should not ask the user to paste credentials that belong to another agent provider unless that provider's official CLI flow specifically requires it and it can be handled securely.

---

## 45. Session Persistence

The first-party application should preserve enough session context to make ongoing Roblox work comfortable.

A user should be able to understand previous actions within the current task and continue the conversation naturally.

Persistence should respect the underlying coding agent's own session model.

Luu Code should not fabricate continuity if the underlying CLI session has been lost.

Roblox-specific observations associated with the conversation, such as screenshots or tool results, should remain understandable within that session.

---

## 46. User Experience

The product should feel immediate.

A desirable user flow is:

1. Open Roblox Studio.
2. Open Luu Code.
3. Ensure Studio is connected.
4. Choose Claude Code or Codex.
5. Describe what should change.
6. Watch the coding agent work directly with Studio.
7. Intervene only when desired.

The UI should not require the user to understand MCP, local RPC, Studio APIs, or internal transport.

Those are implementation details.

MCP configuration is relevant only when the user intentionally wants to use Luu Code from an external coding-agent environment.

---

## 47. MCP User Experience

For external-agent users, the product should make local MCP setup straightforward.

The user should be able to determine:

- whether the local MCP server is running;
- how the external agent should connect;
- whether Studio is connected;
- whether an external agent is currently using the integration;
- whether the MCP connection has permission to control the current Studio session.

The MCP setup documentation should be concise and provider-specific where necessary.

Using MCP should not require launching an unnecessary agent session inside the Electron application.

---

## 48. Compatibility with Studio Updates

Roblox Studio changes frequently.

The project should expect API behavior, plugin capabilities, security boundaries, and UI behavior to change over time.

The Studio connection layer should be isolated enough that compatibility fixes do not require redesigning the entire agent harness.

When a capability becomes unavailable because of a Roblox update, the system should fail clearly and degrade only the affected functionality where possible.

---

## 49. Capability Detection

The local server should know which Roblox capabilities are currently available.

Capabilities may vary based on:

- Studio version;
- operating system;
- whether a playtest is active;
- whether a plugin permission has been granted;
- whether a native integration is available;
- whether a particular runtime context exists.

The coding agent should not be encouraged to call operations that cannot work in the current environment.

Capability information should be discoverable through the harness and MCP.

---

## 50. Scope of Native Integration

Some required capabilities may not be possible through a Roblox Studio plugin alone.

Where necessary, Luu Code may use native desktop integration for capabilities such as:

- process discovery;
- window identification;
- viewport capture;
- desktop-level input;
- coordination between Studio and the local application.

Native integration should exist only to support Roblox Studio capabilities.

It should not become a general computer-control product.

When structured Studio APIs can perform an operation more reliably than desktop automation, the structured path should be preferred.

---

## 51. Interaction Reliability

Interaction is one of the most difficult parts of the product and should be treated as a reliability problem rather than a demo feature.

The system should avoid assuming that a click succeeded merely because input was sent.

Where possible, interaction should be followed by observation.

The coding agent should be able to verify state changes after input.

Examples include:

- checking that a GUI became visible after clicking;
- checking that a tool appeared after a purchase;
- checking that the character moved;
- checking that a prompt disappeared;
- checking runtime values after an interaction.

The system should make these follow-up observations easy.

---

## 52. Human Intervention

The user should always be able to take over Studio manually.

The agent should not require exclusive control of the application.

If the user manually changes the game, moves the camera, stops a playtest, or edits an instance, Luu Code should treat Studio's current state as authoritative and allow the agent to re-inspect it.

The system should recover naturally from user intervention instead of assuming every state change came from the agent.

---

## 53. Task Completion

The coding agent should not report a Roblox task as complete solely because an edit operation succeeded.

Where the requested change has observable runtime behavior, the agent should normally verify it.

The level of verification depends on the task.

A purely structural change may only require inspecting Studio state.

A script behavior change may require playtesting and output inspection.

A UI change may require a screenshot.

An interactive gameplay change may require input plus runtime inspection.

Luu Code should give the agent the evidence needed to make that judgment.

---

## 54. Non-Goals

The following are explicitly outside the core purpose of Luu Code.

### 54.1 General-purpose coding

Luu Code is not intended to replace T3 Code, VS Code, Cursor, terminals, or other general coding environments.

### 54.2 Proprietary AI chat

Luu Code is not intended to become another closed Roblox AI chatbot backed by its own token billing.

### 54.3 Replacing Rojo

Luu Code should complement Rojo, not recreate it.

### 54.4 Requiring Rojo

Studio-native projects must remain first-class.

### 54.5 Building a new Roblox project format

The user should not need to migrate to a Luu Code-specific project representation.

### 54.6 Building a separate testing framework for users

The user should not need to learn a custom test DSL merely to benefit from agentic verification.

### 54.7 Building a second autonomous agent

The selected coding agent remains responsible for reasoning and decisions.

### 54.8 Cloud dependency

Core Studio control should not depend on a hosted Luu Code service.

---

## 55. Success Criteria

Luu Code is successful when a Roblox developer can use a supported coding agent and say something like:

"Fix the inventory UI so it opens correctly, make the buy button purchase the selected item, and make sure it works."

The coding agent should then be able to:

- inspect the relevant Roblox Studio objects;
- read the relevant scripts;
- edit the game;
- start a playtest;
- notice any runtime errors;
- open or interact with the UI;
- inspect runtime state;
- capture screenshots if visual verification is useful;
- fix issues discovered during testing;
- verify the final behavior;
- report what it changed.

The user should not need to manually copy scripts out of Studio, paste errors into the chat, take screenshots, press Play after every edit, or tell the agent whether its previous change worked.

For a Rojo project, the same standard applies except that filesystem editing continues through the user's normal coding-agent workflow and Rojo synchronization, while Luu Code provides the Studio-side observation and testing loop.

For an external MCP client, the same Roblox capabilities should remain available even without the first-party Electron harness, subject to the limitations of the external agent environment.

---

## 56. Product Positioning

The simplest user-facing description of Luu Code should remain close to the actual product:

**Use Claude Code or Codex with Roblox Studio.**

Supporting positioning can emphasize:

- use the coding-agent subscription you already have;
- no proprietary AI credits;
- no required model API keys for Luu Code;
- works directly with Roblox Studio;
- works alongside Rojo;
- lets agents run and test the game, not just edit code;
- open source;
- usable through the first-party app or local MCP.

The product should avoid presenting itself as another generic "AI Roblox game builder."

Its value is deeper and more specific:

Luu Code gives existing coding agents the Roblox Studio capabilities they are missing.
