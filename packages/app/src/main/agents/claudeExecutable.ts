/**
 * The path the Claude Agent SDK can actually spawn. The SDK spawns
 * `pathToClaudeCodeExecutable` directly — no shell, and on Windows no PATH or
 * PATHEXT lookup — so a bare `claude` never resolves and an npm `claude.cmd`
 * fails with `spawn EINVAL`. It has to be a real executable.
 *
 * Left unset, the SDK resolves the CLI it ships as an optional dependency
 * relative to its own module URL, which from the bundled main process walks a
 * `node_modules` holding no platform packages.
 */
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { resolveWindowsExecutable } from "./adapter.js";

/** Launcher scripts Node refuses to spawn without a shell. */
const SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Something spawnable inside the npm package, relative to the shim beside it.
 * Current versions ship a native `claude.exe`; older ones only `cli.js`.
 */
const PACKAGE_ENTRIES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
];

export function resolveClaudeExecutable(command: string): string {
  // POSIX spawn searches PATH for a bare name on its own, and there are no
  // launcher scripts to unwrap.
  if (process.platform !== "win32") return command;

  const resolved = resolveWindowsExecutable(command) ?? command;
  if (!SHIM_EXTENSIONS.has(extname(resolved).toLowerCase())) return resolved;

  const directory = dirname(resolved);
  for (const segments of PACKAGE_ENTRIES) {
    const candidate = join(directory, ...segments);
    if (existsSync(candidate)) return candidate;
  }

  // A shim with no package beside it. The path at least makes the SDK's failure
  // name a real file on disk.
  return resolved;
}
