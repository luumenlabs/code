/**
 * Questions the agent puts to the user, and what came back.
 *
 * A tool rather than a message, because the answer has to arrive inside the
 * turn that asked for it. An agent that asks in prose ends its turn and comes
 * back with no memory of waiting; an agent that asks with this one stops where
 * it is, and the reply is the result of the call.
 */

export interface AskOption {
  label: string;
  /** What picking it means, where the label alone does not say. */
  description?: string;
}

export interface AskQuestion {
  /** Unique within one request, so an answer names what it answers. */
  id: string;
  question: string;
  /** Two or three words naming the decision. Null when none was given. */
  header: string | null;
  /** Empty for an open question, which is a text box and nothing else. */
  options: AskOption[];
  /** Whether more than one option may be picked. */
  multiple: boolean;
}

export interface AskRequest {
  id: string;
  /** The conversation it belongs to. There is nowhere else to put a question. */
  chat: string;
  questions: AskQuestion[];
  at: number;
  /** When the wait is given up, as an absolute time. */
  expiresAt: number;
}

/**
 * One question's reply.
 *
 * A single value, never both halves: writing an answer is choosing not to use
 * the options, and sending "Weapons, actually I meant the potion stall" would
 * leave the agent to work out which of the two the user meant.
 */
export interface AskAnswer {
  questionId: string;
  /** Echoed so the agent reads the reply without matching ids back up. */
  question: string;
  /** Labels picked, or the words written instead. An array only for a multiple. */
  answer: string | string[];
}

export type AskOutcome =
  | { status: "answered"; answers: AskAnswer[] }
  /** The user dismissed the question, which also stops the turn. */
  | { status: "cancelled" }
  /** Nobody answered before the wait ran out, or the turn ended underneath it. */
  | { status: "expired" };

/** What the user has picked and typed for one question, before it is sent. */
export interface AskDraft {
  selected: string[];
  written: string;
}

export const EMPTY_DRAFT: AskDraft = { selected: [], written: "" };

/**
 * The answer a draft amounts to, or null while there is nothing to send.
 *
 * Written text wins outright. The two are alternatives rather than additions,
 * and the form enforces the same thing from the other side by clearing one
 * when the other is used — this is where the rule actually lives.
 */
export function resolveDraft(question: AskQuestion, draft: AskDraft | undefined): string | string[] | null {
  const written = draft?.written.trim();
  if (written) return written;

  const selected = draft?.selected ?? [];
  if (question.multiple) return selected.length > 0 ? selected : null;

  return selected[0] ?? null;
}

/** Picking an option, which discards anything typed for that question. */
export function toggleOption(question: AskQuestion, draft: AskDraft | undefined, label: string): AskDraft {
  const selected = draft?.selected ?? [];

  if (!question.multiple) return { selected: [label], written: "" };

  return {
    selected: selected.includes(label) ? selected.filter((entry) => entry !== label) : [...selected, label],
    written: "",
  };
}

/** Typing, which discards the options once there is anything in the box. */
export function writeAnswer(draft: AskDraft | undefined, written: string): AskDraft {
  return { selected: written.trim().length > 0 ? [] : (draft?.selected ?? []), written };
}
