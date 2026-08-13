import { describe, expect, it } from "vitest";
import { unwrapRules, wrapRules } from "./rules.js";

describe("wrapRules", () => {
  it("produces a ModuleScript that returns the text", () => {
    expect(wrapRules("Do not touch Workspace.")).toBe("return [==[\nDo not touch Workspace.\n]==]\n");
  });

  it("escalates the bracket level past a closer in the text", () => {
    const source = wrapRules("Close a long string with ]==] when you need to.");

    expect(source).toContain("return [===[");
    expect(unwrapRules(source)).toBe("Close a long string with ]==] when you need to.");
  });
});

describe("unwrapRules", () => {
  it("round-trips multi-line prose", () => {
    const text = "# Rules\n\n- Combat lives under ReplicatedStorage/Systems.\n- Never touch Workspace directly.";
    expect(unwrapRules(wrapRules(text))).toBe(text);
  });

  it("matches what require would return, dropping the leading newline", () => {
    expect(unwrapRules("return [==[\nfirst line\n]==]")).toBe("first line");
  });

  it("reads a hand-written document that was never wrapped", () => {
    expect(unwrapRules("# Rules\n\nJust markdown, no wrapper.\n")).toBe("# Rules\n\nJust markdown, no wrapper.");
  });

  it("survives a document that is only whitespace", () => {
    expect(unwrapRules(wrapRules("   \n\n"))).toBe("");
  });
});
