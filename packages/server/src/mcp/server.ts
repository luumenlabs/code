/**
 * The MCP server that fronts the Roblox integration. A thin adapter: every call
 * goes through the same dispatcher the harness uses, so an external agent gets
 * identical validation, permissions, and failure reporting.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LuuCodeError, describeError } from "@luumen/code-protocol";
import type { ScreenshotResult } from "@luumen/code-protocol";
import { MCP_TOOLS, findTool, toolSchema } from "./tools.js";

export interface McpBackend {
  execute(op: string, params: unknown, context: { origin: "mcp" }): Promise<unknown>;
  /**
   * Operations the user has turned off, left out of the list rather than
   * offered and refused: an agent picks from what it is shown. Asked once per
   * list request and asked fresh, since the answer changes while an agent runs.
   * Optional, so a backend that does not model permissions advertises all.
   */
  blockedOps?(): Promise<readonly string[]>;
  /** Fires when that answer changes, so the client knows to ask again. */
  onToolsChanged?(listener: () => void): () => void;
}

export const MCP_SERVER_INFO = {
  name: "luu-code",
  version: "0.1.0",
} as const;

/** Environment only; the app's briefing already said the rest, twice. */
const INSTRUCTIONS = `Luu Code connects you to the Roblox Studio session open on this machine.

The place is a live DataModel rather than files on disk: its scripts are Instances, and these tools are the only way to read or change them.

They reach the instance tree, script source, playtesting, Studio's output, runtime state, screenshots, and input to the running game.

studio_status reports whether Studio is connected and which place is open; nothing else works until it is. Handles returned by an inspection name an exact instance, and stay valid until the DataModel is replaced.`;

export function createMcpServer(backend: McpBackend): Server {
  const server = new Server(MCP_SERVER_INFO, {
    // listChanged, because the user can turn a tool off mid-conversation.
    // Without it the client keeps the list it fetched when it connected.
    capabilities: { tools: { listChanged: true } },
    instructions: INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A backend that cannot answer advertises everything: hiding tools because
    // a lookup failed is indistinguishable from the user turning them off.
    const blocked = new Set((await backend.blockedOps?.().catch(() => [])) ?? []);

    return {
      tools: MCP_TOOLS.filter((tool) => !blocked.has(tool.op)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toolSchema(tool.op) as { type: "object" },
      })),
    };
  });

  backend.onToolsChanged?.(() => {
    // The client may not have finished connecting, and a notification sent
    // before it has is an unhandled rejection rather than a missed update.
    void server.sendToolListChanged().catch(() => undefined);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = findTool(request.params.name);

    if (!tool) {
      return errorResult(new LuuCodeError("INVALID_PARAMS", `Unknown tool "${request.params.name}".`));
    }

    try {
      // Not short-circuited on `allowed`: a client working from a stale list
      // should get the dispatcher's refusal, which says where to turn it on.
      const result = await backend.execute(tool.op, request.params.arguments ?? {}, { origin: "mcp" });
      return successResult(tool.op, result);
    } catch (error) {
      return errorResult(LuuCodeError.from(error));
    }
  });

  return server;
}

function successResult(op: string, result: unknown): CallToolResult {
  // Screenshots go back as an image block, so a multimodal agent can look.
  if (op === "view.screenshot") {
    const shot = result as ScreenshotResult;
    return {
      content: [
        {
          type: "image",
          data: shot.data,
          mimeType: shot.mimeType,
        },
        {
          type: "text",
          text: `${describeCapture(shot)} at ${shot.width}x${shot.height}. Mouse and GUI coordinates are in this image's pixel space.`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Says which of the three pictures this is. A viewport capture is what the
 * experience is drawing; a window capture has Studio's chrome around it, which
 * moves every coordinate in the image.
 */
function describeCapture(shot: ScreenshotResult): string {
  if (shot.source === "viewport") return `Captured the ${shot.realm ?? "Studio"} viewport`;
  if (shot.source === "window") return "Captured the Roblox Studio window, including Studio's own interface";
  return "Captured the whole screen";
}

function errorResult(error: LuuCodeError): CallToolResult {
  const wire = error.toWire();

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${wire.code}: ${describeError(wire)}${
          wire.details ? `\n\n${JSON.stringify(wire.details, null, 2)}` : ""
        }`,
      },
    ],
  };
}
