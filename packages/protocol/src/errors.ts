/**
 * Failure taxonomy for every Roblox-facing operation.
 *
 * Spec section 32 requires that failures are distinguishable by both the coding
 * agent and the user. Each code below maps to a distinct recovery strategy an
 * agent can reason about, so new codes should only be added when the agent
 * would genuinely act differently.
 */
export const ERROR_CODES = [
  /** No Studio session is paired and connected. */
  "STUDIO_NOT_CONNECTED",
  /** The referenced Studio session id is unknown or was replaced. */
  "SESSION_UNKNOWN",
  /** Studio accepted the command but stopped responding before completing it. */
  "STUDIO_TIMEOUT",
  /** The target path or handle does not resolve to an instance. */
  "TARGET_NOT_FOUND",
  /** The handle was valid once but its instance was destroyed or unparented. */
  "TARGET_STALE",
  /** The path matched more than one instance; the agent must disambiguate. */
  "TARGET_AMBIGUOUS",
  /** The handle came from a different edit/run realm than the current one. */
  "WRONG_REALM",
  /** Roblox itself refused the operation (security, locked property, API rules). */
  "NOT_ALLOWED_BY_ROBLOX",
  /** Parameters failed validation before reaching Studio. */
  "INVALID_PARAMS",
  /** The capability is not available in this Studio version, OS, or context. */
  "UNSUPPORTED_CAPABILITY",
  /** The operation needs a running playtest and none is active. */
  "PLAYTEST_NOT_RUNNING",
  /** The operation needs edit mode and a playtest is active. */
  "PLAYTEST_ALREADY_RUNNING",
  /** The requested runtime context (client or server) does not exist here. */
  "RUNTIME_CONTEXT_UNAVAILABLE",
  /** Synthetic input could not be delivered. */
  "INPUT_FAILED",
  /** Screenshot capture failed at the native layer. */
  "SCREENSHOT_FAILED",
  /** The user or configuration denied this permission group. */
  "PERMISSION_DENIED",
  /** A client called the local server without valid local credentials. */
  "UNAUTHORIZED",
  /** Executed Luau raised an error. */
  "EXECUTION_ERROR",
  /** Anything unclassified. Always accompanied by a message. */
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface WireError {
  code: ErrorCode;
  message: string;
  /** Structured extras: candidate targets, offending property, and so on. */
  details?: Record<string, unknown>;
  /** Optional agent-facing hint about what to try instead. */
  hint?: string;
}

/** Error type carried across the server, MCP, and harness boundaries. */
export class LuuCodeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options?: { details?: Record<string, unknown>; hint?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LuuCodeError";
    this.code = code;
    this.details = options?.details;
    this.hint = options?.hint;
  }

  toWire(): WireError {
    const wire: WireError = { code: this.code, message: this.message };
    if (this.details) wire.details = this.details;
    if (this.hint) wire.hint = this.hint;
    return wire;
  }

  static from(value: unknown): LuuCodeError {
    if (value instanceof LuuCodeError) return value;
    if (isWireError(value)) {
      const opts: { details?: Record<string, unknown>; hint?: string } = {};
      if (value.details) opts.details = value.details;
      if (value.hint) opts.hint = value.hint;
      return new LuuCodeError(value.code, value.message, opts);
    }
    if (value instanceof Error) return new LuuCodeError("INTERNAL", value.message, { cause: value });
    return new LuuCodeError("INTERNAL", String(value));
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export function isWireError(value: unknown): value is WireError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return isErrorCode(candidate.code) && typeof candidate.message === "string";
}

/**
 * Human-readable, agent-actionable phrasing for a failure. The harness shows
 * this to the user and MCP returns it to external agents.
 */
export function describeError(error: WireError): string {
  return error.hint ? `${error.message} (${error.hint})` : error.message;
}
