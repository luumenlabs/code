/**
 * The `luu-code-mcp` entry point. Attaches to a Luu Code server if one is
 * running, and starts one in-process if not, so adding a single MCP server is
 * all an external agent has to do.
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
 * Which conversation this process is serving. Luu Code starts one per chat and
 * stamps the id into the child's environment. An MCP client the user configured
 * themselves has no chat here and sets nothing.
 */
function chatId(): string | undefined {
  const value = process.env.LUU_CODE_CHAT;
  return value && value.length > 0 ? value : undefined;
}

/**
 * Everything to leave out of the tool list: what the user turned off, and what
 * this Studio build and plugin cannot do at all. An agent picks from what it is
 * shown, so do not show it something that cannot work.
 */
function hidden(report: CapabilityReport): string[] {
  return [...report.disabledTools, ...unavailableOps(report)];
}

async function resolveBackend(): Promise<ResolvedBackend> {
  const existing = LocalClient.fromAuthFile();
  const chat = chatId();

  if (existing && (await existing.isAlive())) {
    // Sharing the running server means the harness and this agent see the same
    // Studio session, output buffer, and permissions. The tool list is fetched
    // over HTTP rather than cached: the user toggles it in another process.
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
