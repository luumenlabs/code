/**
 * The `luu-code` command line.
 *
 * Enough to use Luu Code without the Electron app: run the server, approve a
 * Studio connection, check what is connected, and print the MCP configuration
 * for an external agent. Spec sections 23 and 47.
 */
import { createInterface } from "node:readline/promises";
import { LuuCodeError, describeError } from "@luumen/code-protocol";
import type { PermissionGroup, ServerEvent } from "@luumen/code-protocol";
import { PERMISSION_GROUPS } from "@luumen/code-protocol";
import { LocalClient } from "../client.js";
import { createLuuCodeServer, SERVER_VERSION } from "../index.js";
import { runStdioServer } from "../mcp/stdio.js";
import { configDir } from "../config/paths.js";
import { setLogLevel } from "../util/logger.js";

const USAGE = `luu-code ${SERVER_VERSION} — connect coding agents to Roblox Studio

Usage:
  luu-code serve [--port <n>] [--approve-all]   Start the local server
  luu-code status                               Show what is connected
  luu-code approve <sessionId>                  Approve a waiting Studio session
  luu-code reject <sessionId>                   Decline a waiting Studio session
  luu-code permissions [<group> on|off]         Show or change permissions
  luu-code mcp                                  Run the MCP server on stdio
  luu-code mcp-config [claude|codex|json]       Print MCP client configuration
  luu-code where                                Print the local data directory

Permission groups: ${PERMISSION_GROUPS.join(", ")}
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;

    case "version":
    case "--version":
      process.stdout.write(`${SERVER_VERSION}\n`);
      return 0;

    case "serve":
      return serve(rest);

    case "status":
      return status();

    case "approve":
      return resolvePairing(rest[0], true);

    case "reject":
      return resolvePairing(rest[0], false);

    case "permissions":
      return permissions(rest);

    case "mcp":
      await runStdioServer();
      return 0;

    case "mcp-config":
      return mcpConfig(rest[0]);

    case "where":
      process.stdout.write(`${configDir()}\n`);
      return 0;

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

async function serve(args: string[]): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex !== -1 ? Number.parseInt(args[portIndex + 1] ?? "", 10) : undefined;
  const approveAll = args.includes("--approve-all");

  setLogLevel(args.includes("--verbose") ? "debug" : "info");

  const server = await createLuuCodeServer(port && Number.isFinite(port) ? { port } : {});

  process.stdout.write(`Luu Code server running on http://127.0.0.1:${server.port}\n`);
  process.stdout.write(`Install the Studio plugin, then approve the connection when Studio asks.\n\n`);

  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let prompting = false;

  server.bus.subscribe((event: ServerEvent) => {
    if (event.type === "pairing.requested") {
      const { request } = event;
      process.stdout.write(`\nRoblox Studio wants to connect:\n`);
      process.stdout.write(`  Place:   ${request.place.name}\n`);
      process.stdout.write(`  Code:    ${request.code}\n`);
      process.stdout.write(`  Studio:  ${request.studioVersion}\n`);

      if (approveAll) {
        server.approvePairing(request.sessionId);
        process.stdout.write(`  Approved automatically (--approve-all).\n\n`);
        return;
      }

      if (!rl) {
        process.stdout.write(`\nRun: luu-code approve ${request.sessionId}\n\n`);
        return;
      }

      if (prompting) return;
      prompting = true;

      void rl
        .question(`\nDoes Studio show code ${request.code}? Approve? [y/N] `)
        .then((answer) => {
          prompting = false;
          const approved = /^y(es)?$/i.test(answer.trim());
          if (approved) {
            server.approvePairing(request.sessionId);
            process.stdout.write("Approved.\n\n");
          } else {
            server.rejectPairing(request.sessionId);
            process.stdout.write("Declined.\n\n");
          }
        })
        .catch(() => {
          prompting = false;
        });
    }

    if (event.type === "session.connected") {
      process.stdout.write(`Connected to ${event.session.place.name}\n`);
    }

    if (event.type === "session.disconnected") {
      process.stdout.write(`Studio disconnected: ${event.reason}\n`);
    }
  });

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.stdout.write("\nShutting down.\n");
      rl?.close();
      void server.close().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  return 0;
}

async function requireClient(): Promise<LocalClient> {
  const client = LocalClient.fromAuthFile();

  if (!client || !(await client.isAlive())) {
    throw new LuuCodeError("STUDIO_NOT_CONNECTED", "No Luu Code server is running.", {
      hint: "Start one with `luu-code serve`, or open the Luu Code app.",
    });
  }

  return client;
}

async function status(): Promise<number> {
  try {
    const client = await requireClient();
    const snapshot = await client.snapshot();

    if (snapshot.status.sessions.length === 0) {
      process.stdout.write("No Roblox Studio session is connected.\n");
    }

    for (const session of snapshot.status.sessions) {
      const marker = session.active ? "*" : " ";
      process.stdout.write(`${marker} ${session.place.name}  [${session.id}]\n`);
      process.stdout.write(`    Studio ${session.studioVersion}, plugin ${session.pluginVersion}\n`);
      process.stdout.write(
        `    ${session.run.running ? `Playtest running in the ${session.run.realm} DataModel` : "Edit mode"}\n`,
      );
      process.stdout.write(`    Connections: ${session.endpoints.map((endpoint) => endpoint.realm).join(", ") || "none"}\n`);
    }

    for (const pending of snapshot.status.pending) {
      process.stdout.write(`\n  Waiting for approval: ${pending.place.name} (code ${pending.code})\n`);
      process.stdout.write(`    luu-code approve ${pending.sessionId}\n`);
    }

    const unavailable = snapshot.capabilities.capabilities.filter((entry) => !entry.available);
    if (unavailable.length > 0) {
      process.stdout.write("\nUnavailable capabilities:\n");
      for (const entry of unavailable) {
        process.stdout.write(`  ${entry.id}: ${entry.reason ?? "unavailable"}\n`);
      }
    }

    return 0;
  } catch (error) {
    return reportError(error);
  }
}

async function resolvePairing(sessionId: string | undefined, approve: boolean): Promise<number> {
  if (!sessionId) {
    process.stderr.write("Provide the session id shown by `luu-code status`.\n");
    return 1;
  }

  try {
    const client = await requireClient();
    const ok = approve ? await client.approvePairing(sessionId) : await client.rejectPairing(sessionId);

    if (!ok) {
      process.stderr.write("That pairing request is no longer waiting. Reconnect from Studio.\n");
      return 1;
    }

    process.stdout.write(approve ? "Approved.\n" : "Declined.\n");
    return 0;
  } catch (error) {
    return reportError(error);
  }
}

async function permissions(args: string[]): Promise<number> {
  try {
    const client = await requireClient();

    if (args.length === 0) {
      const snapshot = await client.snapshot();
      for (const group of PERMISSION_GROUPS) {
        process.stdout.write(`${group.padEnd(12)} ${snapshot.settings.permissions[group] ? "on" : "off"}\n`);
      }
      return 0;
    }

    const [group, value] = args;

    if (!group || !PERMISSION_GROUPS.includes(group as PermissionGroup) || (value !== "on" && value !== "off")) {
      process.stderr.write(`Usage: luu-code permissions <${PERMISSION_GROUPS.join("|")}> on|off\n`);
      return 1;
    }

    const updated = await client.setPermission(group as PermissionGroup, value === "on");
    process.stdout.write(`${group} is now ${updated[group as PermissionGroup] ? "on" : "off"}\n`);
    return 0;
  } catch (error) {
    return reportError(error);
  }
}

function mcpConfig(target = "json"): number {
  const command = process.platform === "win32" ? "luu-code-mcp.cmd" : "luu-code-mcp";

  if (target === "claude") {
    process.stdout.write(`claude mcp add luu-code -- ${command}\n`);
    return 0;
  }

  if (target === "codex") {
    process.stdout.write(`[mcp_servers.luu-code]\ncommand = "${command}"\nargs = []\n`);
    return 0;
  }

  process.stdout.write(
    `${JSON.stringify({ mcpServers: { "luu-code": { command, args: [] } } }, null, 2)}\n`,
  );
  return 0;
}

function reportError(error: unknown): number {
  const failure = LuuCodeError.from(error);
  process.stderr.write(`${describeError(failure.toWire())}\n`);
  return 1;
}
