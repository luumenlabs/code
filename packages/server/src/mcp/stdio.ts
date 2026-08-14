/**
 * The `luu-code-mcp` entry point.
 *
 * An external agent should be able to add one MCP server and have Roblox
 * Studio work, without also being told to run a daemon or open the Electron
 * app. So this attaches to a Luu Code server if one is already running, and
 * starts one in-process if not. Spec sections 21 and 47.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { unavailableOps } from "@luumen/code-protocol";
import type { CapabilityReport } from "@luumen/code-protocol";
import { LocalClient } from "../client.js";
import { createLuuCodeServer } from "../index.js";
import type { LuuCodeServer } from "../index.js";
import { createMcpServer } from "./server.js";
import type { McpBackend } from "./server.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("mcp");

export async function runStdioServer(): Promise<void> {
  const { backend, dispose, mode } = await resolveBackend();

  const server = createMcpServer(backend);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    await dispose();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(transport);
  log.info(`Luu Code MCP ready (${mode})`);
}

interface ResolvedBackend {
  backend: McpBackend;
  dispose: () => Promise<void>;
  mode: string;
}

/**
 * Which conversation this process is serving.
 *
 * Luu Code starts one of these per chat and stamps the id into the child's
 * environment, so the operations it performs can be filed against the chat that
 * asked for them rather than against whichever one is on screen. An MCP client
 * the user configured themselves has no chat here and sets nothing.
 */
function chatId(): string | undefined {
  const value = process.env.LUU_CODE_CHAT;
  return value && value.length > 0 ? value : undefined;
}

/**
 * Everything to leave out of the tool list: what the user turned off, and what
 * this Studio build and plugin cannot do at all.
 *
 * The second half is the one that was missing. A tool whose capability will
 * never arrive was advertised anyway, so an agent picked it, was refused, and
 * went looking for another way to do the same thing — which for anything
 * Roblox-shaped means writing it by hand through studio_exec. The rule this
 * restores is the one `server.ts` already states: an agent picks from what it
 * is shown, so do not show it something that cannot work.
 */
function hidden(report: CapabilityReport): string[] {
  return [...report.disabledTools, ...unavailableOps(report)];
}

async function resolveBackend(): Promise<ResolvedBackend> {
  const existing = LocalClient.fromAuthFile();
  const chat = chatId();

  if (existing && (await existing.isAlive())) {
    // Sharing the running server means the harness and this agent see the same
    // Studio session, the same output buffer, and the same permissions. The
    // permissions are the reason this reaches back over HTTP for the tool list
    // rather than caching one: the user is toggling them in the app, in another
    // process, while this agent is mid-conversation.
    let unsubscribe: (() => void) | null = null;

    return {
      mode: "attached to the running Luu Code server",
      backend: {
        execute: (op, params) => existing.execute(op, params, { origin: "mcp", ...(chat ? { chat } : {}) }),
        blockedOps: async () => hidden((await existing.snapshot()).capabilities),
        onToolsChanged: (listener) => {
          unsubscribe = existing.events((event) => {
            if (event.type === "capabilities") listener();
          });
          return unsubscribe;
        },
      },
      dispose: async () => {
        unsubscribe?.();
      },
    };
  }

  let owned: LuuCodeServer;

  try {
    owned = await createLuuCodeServer();
  } catch (error) {
    log.error("Could not start a local Luu Code server", error);
    throw error;
  }

  return {
    mode: `started its own server on port ${owned.port}`,
    backend: {
      execute: (op, params) => owned.execute(op, params, { origin: "mcp", ...(chat ? { chat } : {}) }),
      blockedOps: async () => hidden(owned.capabilities()),
      onToolsChanged: (listener) =>
        owned.bus.subscribe((event) => {
          if (event.type === "capabilities") listener();
        }),
    },
    dispose: () => owned.close(),
  };
}
