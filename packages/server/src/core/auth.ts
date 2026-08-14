/**
 * Local trust. Spec section 26.
 *
 * One credential that means something, and one that is bookkeeping:
 *
 *   Clients — the harness and MCP run as the user, so they read a token from a
 *             user-only file. A process that cannot read the user's files
 *             cannot issue commands. This is the boundary.
 *   Studio  — issued a session token on its handshake and quotes it back on
 *             every sync. It tells one connection from a stale one; it is not
 *             something the user grants. Studio used to earn it by having the
 *             user compare a six-digit code between two windows of the same
 *             program, which asked them to vouch for themselves.
 *
 * The server binds to loopback only and never enables remote access by default.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { authFile } from "../config/paths.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("auth");

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthFile {
  token: string;
  port: number;
  pid: number;
  updatedAt: number;
}

/**
 * Publishes the client token for local tooling. Written before the listener
 * starts so a client that reads it can immediately connect.
 */
export function writeClientAuth(token: string, port: number): void {
  const file = authFile();
  const payload: AuthFile = { token, port, pid: process.pid, updatedAt: Date.now() };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });

  try {
    // writeFileSync only applies the mode when creating the file.
    chmodSync(file, 0o600);
  } catch (error) {
    log.warn("Could not restrict permissions on the auth file", error);
  }
}

export function readClientAuth(): AuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authFile(), "utf8")) as AuthFile;
    if (typeof parsed.token === "string" && typeof parsed.port === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
