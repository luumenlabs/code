/**
 * The MCP server that fronts the Roblox integration.
 *
 * It is a thin adapter: every call goes through the same dispatcher the
 * first-party harness uses, so an external agent gets identical validation,
 * permissions, and failure reporting. Spec section 21.
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
   * Operations the user has turned off.
   *
   * A tool that is off is left out of the list rather than offered and refused:
   * an agent picks from what it is shown, and a menu with entries that always
   * fail wastes a call and a turn each time. Asked once per list request rather
   * than per tool, and asked fresh, because the answer changes while an agent
   * is running. Optional, so a backend that does not model permissions — the
   * tests do not — advertises everything.
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
    // listChanged is declared because the user can turn a tool off while an
    // agent is mid-conversation. Without the notification the client keeps
    // offering the list it fetched when it connected, and the first the agent
    // hears of the change is a refusal.
    capabilities: { tools: { listChanged: true } },
    instructions: INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A backend that cannot answer advertises everything. Hiding tools because
    // a permissions lookup failed would look identical to the user having
    // turned them off, and an agent would take the shorter menu at face value.
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
      // Not short-circuited on `allowed` here. A client working from a list it
      // fetched before the user changed something should get the dispatcher's
      // refusal, which names the tool and says where to turn it back on —
      // rather than a second, thinner version of the same message from here.
      const result = await backend.execute(tool.op, request.params.arguments ?? {}, { origin: "mcp" });
      return successResult(tool.op, result);
    } catch (error) {
      return errorResult(LuuCodeError.from(error));
    }
  });

  return server;
}

function successResult(op: string, result: unknown): CallToolResult {
  // Screenshots go back as an image block so multimodal agents can actually
  // look at them, which is the entire point of capturing one.
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
 * Says which of the three pictures this is.
 *
 * They are not interchangeable: a viewport capture is what the experience is
 * drawing, and a window capture has Studio's own chrome around it, which moves
 * every coordinate in the image.
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
