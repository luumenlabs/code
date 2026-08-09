/**
 * Logging.
 *
 * Writes to stderr, never stdout: the MCP stdio transport owns stdout and any
 * stray write there corrupts the protocol stream.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = (process.env.LUU_CODE_LOG as LogLevel) ?? "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;

  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.padEnd(5)} [${scope}] ${message}`;

  if (extra === undefined) {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stderr.write(`${line} ${safeStringify(extra)}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, extra) => write("debug", scope, message, extra),
    info: (message, extra) => write("info", scope, message, extra),
    warn: (message, extra) => write("warn", scope, message, extra),
    error: (message, extra) => write("error", scope, message, extra),
  };
}
