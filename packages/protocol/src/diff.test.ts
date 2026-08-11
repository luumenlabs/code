import { describe, expect, it } from "vitest";
import { countLines, diffLines, formatDiff, splitLines } from "./diff.js";

describe("splitLines", () => {
  it("treats a trailing newline as a terminator, not an empty line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(countLines("a\nb\n")).toBe(2);
  });

  it("normalises CRLF, which Studio and git both produce", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("diffLines", () => {
  it("reports nothing for identical sources", () => {
    const diff = diffLines("local a = 1\nreturn a\n", "local a = 1\nreturn a\n");
    expect(diff.hunks).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it("finds a one-line change inside a longer file", () => {
    const before = ["-- header", "local speed = 16", "local jump = 50", "return speed"].join("\n");
    const after = ["-- header", "local speed = 32", "local jump = 50", "return speed"].join("\n");

    const diff = diffLines(before, after);

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.lines.filter((line) => line.op === "remove")[0]!.text).toBe("local speed = 16");
    expect(diff.hunks[0]!.lines.filter((line) => line.op === "add")[0]!.text).toBe("local speed = 32");
  });

  it("keeps line numbers pointing at the right side of each change", () => {
    const diff = diffLines("a\nb\nc", "a\nB\nc");
    const lines = diff.hunks[0]!.lines;

    expect(lines.find((line) => line.op === "remove")).toMatchObject({ before: 2, after: null, text: "b" });
    expect(lines.find((line) => line.op === "add")).toMatchObject({ before: null, after: 2, text: "B" });
  });

  it("handles a pure insertion at the end", () => {
    const diff = diffLines("a\nb", "a\nb\nc");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.hunks[0]!.lines.find((line) => line.op === "add")).toMatchObject({ after: 3, text: "c" });
  });

  it("handles a pure deletion at the start", () => {
    const diff = diffLines("a\nb\nc", "b\nc");
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(0);
    expect(diff.hunks[0]!.lines.find((line) => line.op === "remove")).toMatchObject({ before: 1, text: "a" });
  });

  it("splits distant changes into separate hunks and merges near ones", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 2", "LINE 2").replace("line 38", "LINE 38");

    const far = diffLines(before, after, { context: 2 });
    expect(far.hunks).toHaveLength(2);

    const near = diffLines(before, after, { context: 40 });
    expect(near.hunks).toHaveLength(1);
  });

  it("says so rather than pretending when the sides are too far apart to align", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `a${index}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, index) => `b${index}`).join("\n");

    const diff = diffLines(before, after, { maxCells: 1000 });

    expect(diff.coarse).toBe(true);
    expect(diff.removed).toBe(3000);
    expect(diff.added).toBe(3000);
  });

  it("renders a unified patch", () => {
    const patch = formatDiff(diffLines("a\nb\nc", "a\nB\nc"), "Workspace.Shop");

    expect(patch).toContain("--- Workspace.Shop");
    expect(patch).toContain("@@ -1,3 +1,3 @@");
    expect(patch).toContain("-b");
    expect(patch).toContain("+B");
  });
});
