/**
 * The `luu-code-mcp` entry point.
 *
 * An external agent should be able to add one MCP server and have Roblox
 * Studio work, without also being told to run a daemon or open the Electron
 * app. So this attaches to a Luu Code server if one is already running, and
 * starts one in-process if not. Spec sections 21 and 47.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

async function resolveBackend(): Promise<ResolvedBackend> {
  const existing = LocalClient.fromAuthFile();

  if (existing && (await existing.isAlive())) {
    // Sharing the running server means the harness and this agent see the same
    // Studio session, the same output buffer, and the same permissions.
    return {
      mode: "attached to the running Luu Code server",
      backend: { execute: (op, params) => existing.execute(op, params, { origin: "mcp" }) },
      dispose: async () => undefined,
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
    backend: { execute: (op, params) => owned.execute(op, params, { origin: "mcp" }) },
    dispose: () => owned.close(),
  };
}
