/**
 * Client for a Luu Code server that is already running.
 *
 * Used by the CLI and by the MCP stdio bridge so several agents can share one
 * Studio connection instead of each starting a server and fighting over the
 * port.
 */
import { LuuCodeError } from "@luumen/code-protocol";
import type { CapabilityReport, PermissionGroup, PermissionSettings, ServerEvent, SessionStatus } from "@luumen/code-protocol";
import { readClientAuth } from "./core/auth.js";

export interface LocalClientOptions {
  port: number;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface ServerSnapshot {
  status: SessionStatus;
  capabilities: CapabilityReport;
  settings: { permissions: PermissionSettings; autoApprovePairing: boolean };
}

export class LocalClient {
  private readonly base: string;
  private readonly token: string;
  private readonly http: typeof fetch;

  constructor(options: LocalClientOptions) {
    this.base = `http://127.0.0.1:${options.port}`;
    this.token = options.token;
    this.http = options.fetchImpl ?? fetch;
  }

  /** Reads the credentials a running server published, if there is one. */
  static fromAuthFile(): LocalClient | null {
    const auth = readClientAuth();
    if (!auth) return null;
    return new LocalClient({ port: auth.port, token: auth.token });
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` };
  }

  async isAlive(): Promise<boolean> {
    try {
      const response = await this.http(`${this.base}/health`, { signal: AbortSignal.timeout(1_500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<ServerSnapshot> {
    const response = await this.http(`${this.base}/status`, { headers: this.headers() });
    if (!response.ok) throw new LuuCodeError("INTERNAL", `The local server returned ${response.status}.`);
    return (await response.json()) as ServerSnapshot;
  }

  async execute(
    op: string,
    params: unknown,
    options: { sessionId?: string; realm?: string; origin?: string; chat?: string } = {},
  ): Promise<unknown> {
    const response = await this.http(`${this.base}/command`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ op, params, ...options }),
    });

    if (!response.ok) {
      throw new LuuCodeError("INTERNAL", `The local server returned ${response.status} for ${op}.`);
    }

    const body = (await response.json()) as { ok: boolean; data?: unknown; error?: unknown };

    if (!body.ok) throw LuuCodeError.from(body.error);
    return body.data;
  }

  async approvePairing(sessionId: string): Promise<boolean> {
    const response = await this.http(`${this.base}/pairing/approve`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ sessionId }),
    });
    const body = (await response.json()) as { ok: boolean };
    return body.ok;
  }

  async rejectPairing(sessionId: string): Promise<boolean> {
    const response = await this.http(`${this.base}/pairing/reject`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ sessionId }),
    });
    const body = (await response.json()) as { ok: boolean };
    return body.ok;
  }

  async setPermission(group: PermissionGroup, allowed: boolean): Promise<PermissionSettings> {
    const response = await this.http(`${this.base}/permissions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ group, allowed }),
    });
    const body = (await response.json()) as { permissions: PermissionSettings };
    return body.permissions;
  }

  async disconnect(sessionId: string): Promise<void> {
    await this.http(`${this.base}/session/disconnect`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ sessionId }),
    });
  }

  /**
   * Streams server events. Returns a function that stops the stream.
   */
  events(onEvent: (event: ServerEvent) => void, onError?: (error: unknown) => void): () => void {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await this.http(`${this.base}/events`, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new LuuCodeError("INTERNAL", `Event stream returned ${response.status}.`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");

            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                onEvent(JSON.parse(line.slice(6)) as ServerEvent);
              } catch {
                // A malformed frame should not kill the stream.
              }
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) onError?.(error);
      }
    })();

    return () => controller.abort();
  }
}
