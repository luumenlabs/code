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
}

export const MCP_SERVER_INFO = {
  name: "luu-code",
  version: "0.1.0",
} as const;

const INSTRUCTIONS = `Luu Code connects you to the Roblox Studio session open on this machine.

You can inspect and edit the place, control playtesting, read Studio output, inspect runtime state, capture screenshots, and interact with the running game.

Working effectively:
- Start from studio_status. If Studio is not connected, nothing else will work and the user needs to approve the connection in Studio.
- Explore with studio_services, then studio_tree or studio_search. Handles returned by any inspection are the safest way to act on an exact instance.
- Prefer studio_edit_script over studio_write_script.
- Verify your work. An edit succeeding is not evidence that the behaviour is right: start a playtest, mark the output, interact, then read the output and runtime state back.
- Use screenshots for questions about how something looks, and structured inspection for questions a property can answer.`;

export function createMcpServer(backend: McpBackend): Server {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolSchema(tool.op) as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = findTool(request.params.name);

    if (!tool) {
      return errorResult(new LuuCodeError("INVALID_PARAMS", `Unknown tool "${request.params.name}".`));
    }

    try {
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
