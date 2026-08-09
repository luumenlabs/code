/**
 * Finding the coding agents the user already has. Spec section 44.
 *
 * Luu Code never asks for a provider API key. It looks for the CLI the user has
 * already installed and authenticated, and if it cannot find one it says so
 * plainly rather than offering to sell a way around it.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentId, AgentInfo } from "../../shared/agent.js";

const run = promisify(execFile);

interface AgentSpec {
  id: AgentId;
  label: string;
  binary: string;
  versionArgs: string[];
  installHint: string;
  /** Places to look when the binary is not on PATH. */
  fallbacks: () => string[];
}

const WINDOWS = process.platform === "win32";

function localBinaries(...names: string[]): string[] {
  const home = homedir();
  const candidates: string[] = [];

  for (const name of names) {
    const executable = WINDOWS ? `${name}.cmd` : name;
    candidates.push(
      join(home, ".local", "bin", executable),
      join(home, ".bun", "bin", executable),
      join(home, "AppData", "Roaming", "npm", executable),
      join(home, ".npm-global", "bin", executable),
      "/usr/local/bin/" + name,
      "/opt/homebrew/bin/" + name,
    );
  }

  return candidates;
}

const SPECS: AgentSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    versionArgs: ["--version"],
    installHint: "Install Claude Code from https://claude.com/claude-code, then run `claude` once to sign in.",
    fallbacks: () => localBinaries("claude"),
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    versionArgs: ["--version"],
    installHint: "Install the Codex CLI, then run `codex` once to sign in.",
    fallbacks: () => localBinaries("codex"),
  },
];

async function probe(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(command, args, { timeout: 10_000, windowsHide: true, shell: WINDOWS });
    return stdout.trim().split("\n")[0]?.trim() ?? "";
  } catch {
    return null;
  }
}

async function resolve(spec: AgentSpec): Promise<AgentInfo> {
  const base: Omit<AgentInfo, "command" | "version" | "installed" | "problem"> = {
    id: spec.id,
    label: spec.label,
    installHint: spec.installHint,
  };

  const onPath = await probe(spec.binary, spec.versionArgs);

  if (onPath !== null) {
    return { ...base, command: spec.binary, version: onPath || null, installed: true, problem: null };
  }

  for (const candidate of spec.fallbacks()) {
    if (!existsSync(candidate)) continue;
    const version = await probe(candidate, spec.versionArgs);
    if (version !== null) {
      return { ...base, command: candidate, version: version || null, installed: true, problem: null };
    }
  }

  return {
    ...base,
    command: null,
    version: null,
    installed: false,
    problem: `${spec.label} was not found on this machine.`,
  };
}

export async function discoverAgents(): Promise<AgentInfo[]> {
  return Promise.all(SPECS.map(resolve));
}

export function agentSpec(id: AgentId): AgentSpec | undefined {
  return SPECS.find((spec) => spec.id === id);
}
