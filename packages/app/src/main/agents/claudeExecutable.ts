/**
 * The path the Claude Agent SDK can actually spawn.
 *
 * Everywhere else a CLI is launched through `spawnAgent`, which resolves the
 * command against PATH and falls back to `cmd /d /s /c` for a batch shim. The
 * SDK offers no such hook: it spawns `pathToClaudeCodeExecutable` directly, with
 * no shell and — on Windows — no PATH or PATHEXT lookup. So a bare `claude`
 * never resolves, and an npm `claude.cmd` fails with `spawn EINVAL`, which Node
 * has returned for batch scripts since 20.12. The path has to be a real
 * executable before it goes in.
 *
 * Leaving it unset is worse, and is what "Native CLI binary for win32-x64 not
 * found" was: the SDK then looks for the CLI it ships as an optional
 * dependency, by resolving `@anthropic-ai/claude-agent-sdk-win32-x64` relative
 * to its own module URL. The main process is bundled, so that URL is
 * `dist/main/main.cjs`, and resolution walks the app's `node_modules` — where
 * pnpm links the SDK itself but never its platform packages. The binary is on
 * disk, in the store, and unreachable from the bundle.
 *
 * Pointing the SDK at the user's own install is also the honest thing to do
 * here. Luu Code drives the Claude Code they already have and are already
 * signed in to; it should not quietly run a second copy that shipped inside a
 * dependency.
 */
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { resolveWindowsExecutable } from "./adapter.js";

/** Launcher scripts Node refuses to spawn without a shell. */
const SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Something spawnable inside the npm package, relative to the shim beside it.
 *
 * Current versions ship a native `claude.exe`; older ones only have `cli.js`,
 * which the SDK runs with a JavaScript runtime. Ordered accordingly.
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

  // A shim with no package beside it — nothing better to offer. The shim path
  // at least makes the SDK's failure name a real file on disk.
  return resolved;
}
