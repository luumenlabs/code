import { describe, expect, it } from "vitest";
import { formatPath, isHandle, parsePath } from "./targets.js";

describe("parsePath", () => {
  it("drops the leading game segment", () => {
    expect(parsePath("game.Workspace.Baseplate")).toEqual(["Workspace", "Baseplate"]);
    expect(parsePath("Workspace.Baseplate")).toEqual(["Workspace", "Baseplate"]);
  });

  it("supports bracket quoting for awkward names", () => {
    expect(parsePath('Workspace["My Part"].Handle')).toEqual(["Workspace", "My Part", "Handle"]);
    expect(parsePath("Workspace['A.B'].C")).toEqual(["Workspace", "A.B", "C"]);
  });

  it("rejects malformed brackets", () => {
    expect(() => parsePath("Workspace[MyPart]")).toThrow(/quoted name/);
    expect(() => parsePath('Workspace["MyPart')).toThrow(/Unterminated/);
  });

  it("round-trips through formatPath", () => {
    const segments = ["Workspace", "My Part", "Handle"];
    expect(parsePath(formatPath(segments))).toEqual(segments);
  });
});

describe("isHandle", () => {
  it("distinguishes handles from paths", () => {
    expect(isHandle("@h12")).toBe(true);
    expect(isHandle("Workspace.Part")).toBe(false);
  });
});
