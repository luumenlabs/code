/**
 * Whether the CLIs the user has are current, and how they would update them.
 *
 * Luu Code drives someone else's binary, so the version it finds is a fact
 * about their machine rather than about this build — and a stale CLI is the
 * quiet cause of a whole class of failures: a model the app offers that the CLI
 * cannot launch, a protocol field it does not send, a bug fixed upstream weeks
 * ago. Saying "2.1.224, 2.1.226 is out" costs one cached request and turns that
 * into something the user can act on.
 *
 * The update command is derived from where the binary actually is, because the
 * right one differs per install method and the wrong one fails in a way that
 * looks like the app is broken: `npm i -g` does nothing for a native install,
 * and `claude update` does not exist on an npm one.
 *
 * Everything here degrades to null. No network, a registry that is down, an
 * unparseable answer — the panel shows the installed version alone, which is
 * what it showed before any of this existed.
 */
import { get } from "node:https";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import type { AgentId, AgentInfo } from "../../shared/agent.js";
import { resolveWindowsExecutable } from "./adapter.js";

interface PackageSpec {
  npm: string;
  /** Homebrew formula, where one exists. */
  brew: string | null;
  /**
   * The CLI's own updater, for installs that manage themselves. Claude Code's
   * native installer puts the binary under `~/.local`, and that copy is updated
   * by `claude update` rather than by any package manager.
   */
  native: { command: string; owns: (path: string) => boolean } | null;
}

/**
 * Only the providers this app could sensibly update.
 *
 * Ollama is missing on purpose: it is not an npm package, it updates itself,
 * and the version that matters for a local model is the daemon's — which the
 * user manages the same way they manage the models. Telling them to run
 * `npm i -g` at it would be a wrong answer confidently given.
 */
const PACKAGES: Partial<Record<AgentId, PackageSpec>> = {
  claude: {
    npm: "@anthropic-ai/claude-code",
    brew: "claude-code",
    native: {
      command: "claude update",
      owns: (path) => /[/\\]\.local[/\\]bin[/\\]claude(\.exe)?$/i.test(path) || /[/\\]\.local[/\\]share[/\\]claude[/\\]/i.test(path),
    },
  },
  codex: { npm: "@openai/codex", brew: "codex", native: null },
};

const CACHE_TTL_MS = 60 * 60 * 1_000;
const TIMEOUT_MS = 4_000;

const cache = new Map<string, { at: number; version: string | null }>();

/**
 * The latest published version, or null.
 *
 * `/latest` rather than the full packument: the full document for a CLI that
 * publishes daily is megabytes, and the only field wanted is `version`.
 */
function fetchLatest(pkg: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = get(
      `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
      { headers: { accept: "application/json" }, timeout: TIMEOUT_MS },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          // A registry that answers with something enormous is not answering
          // the question asked.
          if (body.length > 1_000_000) request.destroy();
        });
        response.on("end", () => {
          try {
            const version = (JSON.parse(body) as { version?: unknown }).version;
            resolve(typeof version === "string" && version.length > 0 ? version : null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

async function latestVersion(pkg: string, force: boolean): Promise<string | null> {
  const hit = cache.get(pkg);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.version;

  const version = await fetchLatest(pkg);
  cache.set(pkg, { at: Date.now(), version });
  return version;
}

/** Where a bare command name actually lives, so its install method can be read. */
function locate(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : null;
  }

  if (process.platform === "win32") return resolveWindowsExecutable(command);

  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * How this particular copy is updated.
 *
 * Ordered narrowest first. npm is the fallback rather than a detection because
 * it is both the most common install and the one with the least distinctive
 * path — `~/AppData/Roaming/npm` on Windows, but a bare `/usr/bin` elsewhere.
 */
function updateCommand(spec: PackageSpec, command: string | null): string {
  const npm = `npm install -g ${spec.npm}@latest`;

  const path = command ? locate(command) : null;
  if (!path) return npm;

  const normalized = path.replace(/\\/g, "/").toLowerCase();

  if (spec.native?.owns(path)) return spec.native.command;
  if (normalized.includes("/pnpm/")) return `pnpm add -g ${spec.npm}@latest`;
  if (normalized.includes("/.bun/")) return `bun add -g ${spec.npm}@latest`;
  if (spec.brew && (normalized.includes("/cellar/") || normalized.includes("/homebrew/"))) {
    return `brew upgrade ${spec.brew}`;
  }

  return npm;
}

/**
 * Adds "is there a newer one, and how would you get it" to what discovery found.
 *
 * Every provider is asked at once. A missing CLI is skipped — there is no
 * version to compare and the install hint already covers it — and so is one
 * this app does not install, which is left exactly as discovery found it.
 *
 * `force` comes from the Refresh button, which is the one place the user has
 * explicitly asked to check again; serving it an hour-old answer would make the
 * button look broken to someone who just updated in a terminal.
 */
export async function withUpdateAdvisory(
  agents: AgentInfo[],
  force = false,
): Promise<AgentInfo[]> {
  return Promise.all(
    agents.map(async (agent) => {
      const spec = PACKAGES[agent.id];
      if (!agent.installed || !spec) return agent;

      return {
        ...agent,
        latestVersion: await latestVersion(spec.npm, force),
        updateCommand: updateCommand(spec, agent.command),
      };
    }),
  );
}
