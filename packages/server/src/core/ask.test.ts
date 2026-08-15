/**
 * Asking the user, end to end through the dispatcher. No fake plugin in here: a
 * question is the one operation that has to work with Studio closed, so every
 * test runs against a server with no session connected.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AskOutcome, AskRequest } from "@luumen/code-protocol";

const home = mkdtempSync(join(tmpdir(), "luu-code-ask-test-"));
process.env.LUU_CODE_HOME = home;
process.env.LUU_CODE_LOG = "error";

const { createLuuCodeServer } = await import("../index.js");
type LuuCodeServer = Awaited<ReturnType<typeof createLuuCodeServer>>;

let server: LuuCodeServer;

/** The last question the host was handed, for asserting what was stamped on it. */
let received: AskRequest | null = null;

/** Registers a host that answers however the test says, and records the ask. */
function host(reply: (request: AskRequest) => AskOutcome | Promise<AskOutcome>): void {
  server.setAskHost(async (request) => {
    received = request;
    return reply(request);
  });
}

const ONE = {
  questions: [{ question: "Which shop?", header: "Shop", options: [{ label: "Weapons" }, { label: "Potions" }] }],
};

beforeAll(async () => {
  server = await createLuuCodeServer({ port: 0 });
});

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  server.setAskHost(null);
  received = null;
});

describe("asking the user", () => {
  it("says so when nothing is hosting a conversation", async () => {
    await expect(server.execute("ask.user", ONE, { chat: "t1" })).rejects.toMatchObject({
      code: "ASK_UNAVAILABLE",
    });
  });

  it("says so when the caller has no conversation to be asked in", async () => {
    host(() => ({ status: "answered", answers: [] }));

    // An MCP client the user wired up themselves. It should put the question in
    // its reply rather than be given a form nobody will see.
    await expect(server.execute("ask.user", ONE, { origin: "mcp" })).rejects.toMatchObject({
      code: "ASK_UNAVAILABLE",
    });
  });

  it("returns the answer, with Studio closed", async () => {
    expect(server.status().sessions).toHaveLength(0);

    host((request) => ({
      status: "answered",
      answers: [{ questionId: request.questions[0]!.id, question: request.questions[0]!.question, answer: "Potions" }],
    }));

    const result = (await server.execute("ask.user", ONE, { chat: "t1" })) as {
      answers: Array<{ answer: string | string[] }>;
    };

    expect(result.answers).toEqual([{ questionId: "q1", question: "Which shop?", answer: "Potions" }]);
  });

  it("stamps ids, the conversation, and a deadline onto the request", async () => {
    host(() => ({ status: "answered", answers: [] }));

    const before = Date.now();
    await server.execute(
      "ask.user",
      {
        questions: [
          { question: "Which shop?", options: [{ label: "Weapons" }, { label: "Potions" }] },
          { question: "Anything else?" },
        ],
        timeoutMs: 60_000,
      },
      { chat: "t7" },
    );

    expect(received?.chat).toBe("t7");
    expect(received?.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
    // An open question is a text box: no options, and nothing to multi-select.
    expect(received?.questions[1]).toMatchObject({ header: null, options: [], multiple: false });
    expect(received?.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("stops the turn when the user dismisses it", async () => {
    host(() => ({ status: "cancelled" }));

    await expect(server.execute("ask.user", ONE, { chat: "t1" })).rejects.toMatchObject({
      code: "ASK_CANCELLED",
    });
  });

  it("reports an unanswered question as its own failure", async () => {
    host(() => ({ status: "expired" }));

    // Distinct from a dismissal: nobody said no, nobody said anything, and the
    // agent's next move is different for each.
    await expect(server.execute("ask.user", ONE, { chat: "t1" })).rejects.toMatchObject({
      code: "ASK_TIMEOUT",
    });
  });

  it("refuses a choice of one", async () => {
    host(() => ({ status: "answered", answers: [] }));

    await expect(
      server.execute("ask.user", { questions: [{ question: "Go on?", options: [{ label: "Yes" }] }] }, { chat: "t1" }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("still asks with the looking permission turned off", async () => {
    host(() => ({ status: "answered", answers: [] }));
    server.setPermission("inspect", false);

    try {
      // Essential, like reporting connection state: turning it off would not
      // restrain the agent, it would only make it guess instead of ask.
      await expect(server.execute("ask.user", ONE, { chat: "t1" })).resolves.toMatchObject({ answers: [] });
    } finally {
      server.setPermission("inspect", true);
    }
  });
});
