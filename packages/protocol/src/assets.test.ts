/**
 * How an asset id is named.
 *
 * The point of accepting a URL is that an agent that found something through a
 * web search never has to pick the number out of it, so every form Roblox
 * publishes a store page under is pinned here.
 */
import { describe, expect, it } from "vitest";
import { COMMANDS } from "./commands.js";

function insert(assetId: unknown): number | string {
  const parsed = COMMANDS["assets.insert"].params.safeParse({ assetId });
  return parsed.success ? (parsed.data.assetId as number) : (parsed.error.issues[0]?.message ?? "rejected");
}

describe("naming an asset", () => {
  it("takes an id as a number or as the digits of one", () => {
    expect(insert(1818)).toBe(1818);
    expect(insert("1818")).toBe(1818);
  });

  it("reads the id out of every store URL Roblox hands out", () => {
    expect(insert("https://create.roblox.com/store/asset/1269895074/car")).toBe(1269895074);
    expect(insert("https://www.roblox.com/library/1818/Tree")).toBe(1818);
    expect(insert("rbxassetid://140278004623742")).toBe(140278004623742);
  });

  it("refuses a string with no id in it rather than inserting something else", () => {
    expect(insert("a car")).toMatch(/no asset id/i);
  });

  it("defaults to Workspace, which is where an asset is wanted when nobody said", () => {
    const parsed = COMMANDS["assets.insert"].params.parse({ assetId: 1 });
    expect(parsed.parent).toBe("game.Workspace");
  });
});
