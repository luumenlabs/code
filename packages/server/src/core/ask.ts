/**
 * Questions in flight. The one operation the server cannot finish on its own,
 * so it hands the question to whatever hosts the conversation and holds the
 * agent's call open. With nothing hosting there is nobody to ask, which is
 * reported as a failure rather than left to be assumed away.
 */
import { randomUUID } from "node:crypto";
import { LuuCodeError } from "@luumen/code-protocol";
import type { AskAnswer, AskOption, AskOutcome, AskQuestion, AskRequest } from "@luumen/code-protocol";

/** What the app registers to be handed questions. */
export type AskHost = (request: AskRequest) => Promise<AskOutcome>;

/** One question as the agent wrote it, before ids and defaults are stamped on. */
export interface AskInput {
  question: string;
  header?: string;
  options: AskOption[];
  multiple: boolean;
}

export interface AskCall {
  /** The conversation to ask in. Absent for a client that has none. */
  chat: string | undefined;
  questions: AskInput[];
  timeoutMs: number;
}

/**
 * How long past the host's own deadline to wait before giving up on it. The
 * host owns the timeout; this is the backstop for one that never answers, and
 * matches the grace the dispatcher gives a Studio round trip.
 */
const HOST_GRACE_MS = 5_000;

export class AskRegistry {
  private host: AskHost | null = null;

  /** Null when the window hosting conversations has gone. */
  setHost(host: AskHost | null): void {
    this.host = host;
  }

  get hasHost(): boolean {
    return this.host !== null;
  }

  async request(call: AskCall): Promise<{ answers: AskAnswer[] }> {
    const host = this.host;

    if (!call.chat) {
      throw new LuuCodeError("ASK_UNAVAILABLE", "This tool asks inside a Luu Code conversation, and you are not in one.", {
        hint: "Put the question in your reply instead. The user is reading it there.",
      });
    }

    if (!host) {
      throw new LuuCodeError("ASK_UNAVAILABLE", "No Luu Code window is open to show the question in.", {
        hint: "Put the question in your reply instead.",
      });
    }

    const at = Date.now();
    const request: AskRequest = {
      id: `ask_${randomUUID().slice(0, 8)}`,
      chat: call.chat,
      questions: call.questions.map((input, index) => stamp(input, index)),
      at,
      expiresAt: at + call.timeoutMs,
    };

    let backstop: NodeJS.Timeout | undefined;

    try {
      const outcome = await Promise.race([
        host(request),
        new Promise<AskOutcome>((resolve) => {
          backstop = setTimeout(() => resolve({ status: "expired" }), call.timeoutMs + HOST_GRACE_MS);
          backstop.unref?.();
        }),
      ]);

      switch (outcome.status) {
        case "answered":
          return { answers: outcome.answers };

        case "cancelled":
          throw new LuuCodeError("ASK_CANCELLED", "The user dismissed the question and stopped the turn.", {
            hint: "Stop here. Do not pick an answer on their behalf and carry on.",
          });

        default:
          throw new LuuCodeError("ASK_TIMEOUT", `Nobody answered within ${Math.round(call.timeoutMs / 1000)}s.`, {
            hint: "Say what you were going to ask, and either wait for a reply or state the assumption you are proceeding on.",
          });
      }
    } finally {
      clearTimeout(backstop);
    }
  }
}

function stamp(input: AskInput, index: number): AskQuestion {
  return {
    id: `q${index + 1}`,
    question: input.question,
    header: input.header ?? null,
    options: input.options,
    multiple: input.multiple,
  };
}

