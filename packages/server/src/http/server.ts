/**
 * The local HTTP surface.
 *
 * Three kinds of caller share one listener:
 *   /studio/*  the Roblox Studio plugin, authenticated by its paired token
 *   /mcp       external MCP clients
 *   everything else, the first-party harness and the CLI
 *
 * The listener binds to loopback. Remote access is not a configuration option
 * here; enabling it would turn a local trust decision into a network one.
 * Spec section 26.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DEFAULT_HOST, LuuCodeError, ROUTES } from "@luumen/code-protocol";
import type { ServerEvent, StudioHelloRequest, StudioPairRequest, StudioSyncRequest } from "@luumen/code-protocol";
import { bearerToken, safeEquals } from "../core/auth.js";
import type { EventBus } from "../core/events.js";
import type { Dispatcher } from "../core/dispatcher.js";
import type { SessionRegistry } from "../core/sessions.js";
import type { SettingsStore } from "../config/settings.js";
import { createMcpServer } from "../mcp/server.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("http");

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpDeps {
  sessions: SessionRegistry;
  dispatcher: Dispatcher;
  settings: SettingsStore;
  bus: EventBus;
  clientToken: string;
  version: string;
}

export interface RunningHttpServer {
  server: HttpServer;
  port: number;
  close(): Promise<void>;
}

export async function startHttpServer(deps: HttpDeps, port: number): Promise<RunningHttpServer> {
  const server = createServer((req, res) => {
    handle(deps, req, res).catch((error) => {
      log.error("Unhandled request failure", error);
      if (!res.headersSent) sendError(res, LuuCodeError.from(error), 500);
    });
  });

  // Long polls and SSE both outlive Node's default idle timeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, DEFAULT_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handle(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${DEFAULT_HOST}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders()).end();
    return;
  }

  if (path === ROUTES.health) {
    sendJson(res, 200, { ok: true, version: deps.version, studioConnected: deps.sessions.hasSessions() });
    return;
  }

  // ---- Studio plugin -------------------------------------------------------

  if (path === ROUTES.hello && req.method === "POST") {
    const body = await readJson<StudioHelloRequest>(req);
    sendJson(res, 200, deps.sessions.hello(body));
    return;
  }

  if (path === ROUTES.pair && req.method === "POST") {
    const body = await readJson<StudioPairRequest>(req);
    sendJson(res, 200, deps.sessions.pair(body.sessionId, body.installId));
    return;
  }

  if (path === ROUTES.sync && req.method === "POST") {
    const body = await readJson<StudioSyncRequest>(req);

    try {
      const response = await deps.sessions.sync(body);
      sendJson(res, 200, response);
    } catch (error) {
      const failure = LuuCodeError.from(error);
      sendError(res, failure, failure.code === "UNAUTHORIZED" ? 401 : 404);
    }
    return;
  }

  // ---- Everything below requires the local client token --------------------

  if (!authorize(deps, req, url)) {
    sendError(res, new LuuCodeError("UNAUTHORIZED", "A local Luu Code token is required for this endpoint."), 401);
    return;
  }

  if (path === ROUTES.mcp) {
    await handleMcp(deps, req, res);
    return;
  }

  if (path === ROUTES.status && req.method === "GET") {
    sendJson(res, 200, {
      status: deps.sessions.status(),
      capabilities: deps.dispatcher.capabilityReport(),
      settings: { permissions: deps.settings.permissions, autoApprovePairing: deps.settings.get().autoApprovePairing },
    });
    return;
  }

  if (path === ROUTES.events && req.method === "GET") {
    streamEvents(deps, req, res);
    return;
  }

  if (path === ROUTES.command && req.method === "POST") {
    const body = await readJson<{
      op: string;
      params?: unknown;
      sessionId?: string;
      realm?: string;
      origin?: string;
      chat?: string;
    }>(req);

    try {
      const data = await deps.dispatcher.execute(body.op, body.params, {
        origin: body.origin === "mcp" ? "mcp" : body.origin === "internal" ? "internal" : "harness",
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(body.realm ? { realm: body.realm as never } : {}),
        ...(body.chat ? { chat: body.chat } : {}),
      });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      const failure = LuuCodeError.from(error);
      sendJson(res, 200, { ok: false, error: failure.toWire() });
    }
    return;
  }

  if (path === `${ROUTES.pairing}/approve` && req.method === "POST") {
    const body = await readJson<{ sessionId: string }>(req);
    sendJson(res, 200, { ok: deps.sessions.approvePairing(body.sessionId) });
    return;
  }

  if (path === `${ROUTES.pairing}/reject` && req.method === "POST") {
    const body = await readJson<{ sessionId: string }>(req);
    sendJson(res, 200, { ok: deps.sessions.rejectPairing(body.sessionId) });
    return;
  }

  if (path === "/permissions" && req.method === "POST") {
    const body = await readJson<{ group: string; allowed: boolean }>(req);
    deps.settings.setPermission(body.group as never, body.allowed);
    deps.bus.emit({ type: "capabilities", report: deps.dispatcher.capabilityReport() });
    sendJson(res, 200, { permissions: deps.settings.permissions });
    return;
  }

  if (path === "/session/disconnect" && req.method === "POST") {
    const body = await readJson<{ sessionId: string }>(req);
    deps.sessions.disconnect(body.sessionId);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, new LuuCodeError("INVALID_PARAMS", `No route for ${req.method} ${path}`), 404);
}

function authorize(deps: HttpDeps, req: IncomingMessage, url: URL): boolean {
  const header = bearerToken(req.headers.authorization);
  if (header && safeEquals(header, deps.clientToken)) return true;

  // EventSource cannot set headers, so the stream endpoint also accepts the
  // token as a query parameter. It never leaves loopback.
  const query = url.searchParams.get("token");
  return query !== null && safeEquals(query, deps.clientToken);
}

async function handleMcp(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stateless: one server and transport per request. There is no cross-request
  // state worth keeping, and it means a client reconnecting mid-session simply
  // works.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer({
    execute: (op, params, context) => deps.dispatcher.execute(op, params, context),
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);

  const body = req.method === "POST" ? await readJson<unknown>(req) : undefined;
  await transport.handleRequest(req, res, body);
}

function streamEvents(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });

  const write = (event: ServerEvent): void => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      unsubscribe();
    }
  };

  const unsubscribe = deps.bus.subscribe(write);

  // Send the current picture immediately so a client that connects late is not
  // left blank until something changes.
  write({ type: "status", status: deps.sessions.status() });
  write({ type: "capabilities", report: deps.dispatcher.capabilityReport() });

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, 20_000);
  heartbeat.unref?.();

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new LuuCodeError("INVALID_PARAMS", "Request body is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) return {} as T;

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch (error) {
    throw new LuuCodeError("INVALID_PARAMS", "Request body is not valid JSON.", { cause: error });
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(payload);
}

function sendError(res: ServerResponse, error: LuuCodeError, status: number): void {
  sendJson(res, status, { ok: false, error: error.toWire() });
}
