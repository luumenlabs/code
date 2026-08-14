import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, resolveDraft, toggleOption, writeAnswer } from "./ask.js";
import type { AskQuestion } from "./ask.js";

const single: AskQuestion = {
  id: "q1",
  question: "Which shop?",
  header: "Shop",
  options: [{ label: "Weapons" }, { label: "Potions" }],
  multiple: false,
};

const multiple: AskQuestion = { ...single, multiple: true };

const open: AskQuestion = { id: "q2", question: "Anything else?", header: null, options: [], multiple: false };

describe("answering a question", () => {
  it("has nothing to send until something is picked or written", () => {
    expect(resolveDraft(single, EMPTY_DRAFT)).toBeNull();
    expect(resolveDraft(single, undefined)).toBeNull();
    expect(resolveDraft(open, EMPTY_DRAFT)).toBeNull();
  });

  it("sends one label for a single choice and a list for a multiple", () => {
    expect(resolveDraft(single, toggleOption(single, EMPTY_DRAFT, "Potions"))).toBe("Potions");

    const both = toggleOption(multiple, toggleOption(multiple, EMPTY_DRAFT, "Weapons"), "Potions");
    expect(resolveDraft(multiple, both)).toEqual(["Weapons", "Potions"]);
  });

  it("replaces the choice on a single, and toggles it off on a multiple", () => {
    const swapped = toggleOption(single, toggleOption(single, EMPTY_DRAFT, "Weapons"), "Potions");
    expect(resolveDraft(single, swapped)).toBe("Potions");

    const off = toggleOption(multiple, toggleOption(multiple, EMPTY_DRAFT, "Weapons"), "Weapons");
    expect(resolveDraft(multiple, off)).toBeNull();
  });

  it("lets what was written win, and drops it back to the options when cleared", () => {
    // The two are alternatives. Sending "Potions" and "the stall by the gate"
    // together would leave the agent to decide which one the user meant.
    const written = writeAnswer(toggleOption(single, EMPTY_DRAFT, "Potions"), "the stall by the gate");
    expect(resolveDraft(single, written)).toBe("the stall by the gate");

    const rubbedOut = writeAnswer(written, "");
    expect(resolveDraft(single, rubbedOut)).toBeNull();
  });

  it("ignores whitespace typed into the box", () => {
    const spaces = writeAnswer(toggleOption(single, EMPTY_DRAFT, "Potions"), "   ");
    expect(resolveDraft(single, spaces)).toBe("Potions");
  });

  it("answers an open question with the words alone", () => {
    expect(resolveDraft(open, writeAnswer(EMPTY_DRAFT, "  the lobby one  "))).toBe("the lobby one");
  });
});
