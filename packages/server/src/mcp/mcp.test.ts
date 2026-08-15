/**
 * The MCP surface is a stable integration point (spec section 21), so these
 * tests pin the things an external agent depends on: the tool list, schema
 * shape, image handling for screenshots, and typed failures.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AGENT_OPS, LuuCodeError, TOOL_NAMES } from "@luumen/code-protocol";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";
import type { McpBackend } from "./server.js";
import { MCP_TOOLS, toolSchema } from "./tools.js";

async function connect(
  execute: (op: string, params: unknown) => Promise<unknown>,
  extra: Partial<McpBackend> = {},
): Promise<Client> {
  const server = createMcpServer({ execute: (op, params) => execute(op, params), ...extra });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

describe("tool definitions", () => {
  it("exposes a unique name per tool", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * An operation the protocol gives a name to but nobody wrote a description
   * for is a tool the permission controls list and no agent can call. The
   * failure is silent in every other direction, so it is pinned here.
   */
  it("describes every operation an agent can reach", () => {
    const described = new Set(MCP_TOOLS.map((tool) => tool.op));
    const missing = AGENT_OPS.filter((op) => !described.has(op));

    expect(missing).toEqual([]);
  });

  it("names every tool from the protocol, so a rename cannot land in one place only", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.name).toBe(TOOL_NAMES[tool.op]);
    }
  });

  it("produces an object schema for every tool, including no-argument ones", () => {
    for (const tool of MCP_TOOLS) {
      const schema = toolSchema(tool.op);
      expect(schema.type, tool.name).toBe("object");
      expect(schema.properties, tool.name).toBeDefined();
    }
  });

  it("keeps parameter descriptions, which are what an agent reads", () => {
    const schema = toolSchema("run.start") as { properties: Record<string, { description?: string }> };
    expect(schema.properties.mode?.description).toMatch(/play/i);
  });
});

describe("tool calls", () => {
  it("lists the full Roblox surface", async () => {
    const client = await connect(async () => ({}));
    const { tools } = await client.listTools();

    expect(tools.length).toBe(MCP_TOOLS.length);
    expect(tools.map((tool) => tool.name)).toContain("studio_start_playtest");
    await client.close();
  });

  it("returns results as JSON text", async () => {
    const client = await connect(async (op) => {
      expect(op).toBe("dm.services");
      return { services: [{ name: "Workspace" }] };
    });

    const result = await client.callTool({ name: "studio_services", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]!.text)).toEqual({ services: [{ name: "Workspace" }] });
    await client.close();
  });

  it("returns a screenshot as an image block so multimodal agents can see it", async () => {
    const client = await connect(async () => ({
      data: "aGVsbG8=",
      mimeType: "image/png",
      width: 1280,
      height: 720,
      capturedAt: 0,
      source: "viewport",
      realm: "client",
    }));

    const result = await client.callTool({ name: "studio_screenshot", arguments: {} });
    const content = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;

    expect(content[0]?.type).toBe("image");
    expect(content[0]?.mimeType).toBe("image/png");
    // The caption has to say which of the three pictures this is: a window
    // capture has Studio's own interface around it, which moves every
    // coordinate an agent might read off the image.
    expect(content[1]?.text).toContain("client viewport");
    await client.close();
  });

  /**
   * A tool that is off is left out of the menu rather than offered and refused.
   * An agent picks from what it is shown, and an entry that always fails costs
   * it a call and a turn every time it reaches for the obvious tool.
   */
  it("leaves a tool the user has turned off out of the list", async () => {
    const client = await connect(async () => ({}), {
      blockedOps: async () => ["dm.delete"],
    });

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).not.toContain("studio_delete_instance");
    expect(names).toContain("studio_create_instance");
    await client.close();
  });

  /**
   * Failing open matters more than failing closed here. A shorter menu is
   * indistinguishable from the user having made it shorter, so an agent would
   * take a lookup failure at face value and never try the tool again.
   */
  it("advertises everything when it cannot find out what is blocked", async () => {
    const client = await connect(async () => ({}), {
      blockedOps: async () => {
        throw new Error("the server went away");
      },
    });

    const { tools } = await client.listTools();
    expect(tools.length).toBe(MCP_TOOLS.length);
    await client.close();
  });

  it("reports a failure with its code and hint rather than throwing", async () => {
    const client = await connect(async () => {
      throw new LuuCodeError("STUDIO_NOT_CONNECTED", "Roblox Studio is not connected to Luu Code.", {
        hint: "Open the place in Roblox Studio; the plugin connects on its own.",
      });
    });

    const result = await client.callTool({ name: "studio_services", arguments: {} });
    const content = result.content as Array<{ text: string }>;

    expect(result.isError).toBe(true);
    expect(content[0]?.text).toContain("STUDIO_NOT_CONNECTED");
    expect(content[0]?.text).toContain("connects on its own");
    await client.close();
  });

  it("rejects an unknown tool name", async () => {
    const client = await connect(async () => ({}));
    const result = await client.callTool({ name: "studio_not_a_tool", arguments: {} });

    expect(result.isError).toBe(true);
    await client.close();
  });
});
