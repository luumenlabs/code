/**
 * Running a short-lived platform helper.
 *
 * Native integration exists only to reach the few Roblox Studio capabilities a
 * plugin cannot provide. Spec section 50 draws that line deliberately: this is
 * not a general computer-control layer.
 */
import { execFile } from "node:child_process";
import { LuuCodeError } from "@luumen/code-protocol";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: options.timeoutMs ?? 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new LuuCodeError("INTERNAL", `${command} failed: ${stderr.trim() || error.message}`, {
              details: { command, stderr: stderr.trim() },
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export function powershell(script: string, timeoutMs = 20_000): Promise<RunResult> {
  return runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    input: script,
    timeoutMs,
  });
}

export function osascript(script: string, timeoutMs = 20_000): Promise<RunResult> {
  return runCommand("osascript", ["-e", script], { timeoutMs });
}
