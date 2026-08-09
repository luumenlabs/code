/**
 * Desktop-level input, used only where Studio itself offers no API.
 *
 * In practice that is one thing: pressing Play. Studio exposes Run mode to
 * plugins but not the Play shortcut, so when the in-Studio path does not take
 * effect the server presses the key against the Studio window instead. Spec
 * sections 13 and 50.
 *
 * Everything else routes through VirtualInputManager inside the game, which is
 * deterministic and does not take over the user's mouse.
 */
import { LuuCodeError } from "@luumen/code-protocol";
import { osascript, powershell } from "./process.js";

const WINDOWS_SEND_KEY = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LuuCodeInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$process = Get-Process -Name 'RobloxStudioBeta','RobloxStudio' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

if ($null -eq $process) { Write-Error 'NO_STUDIO_WINDOW'; exit 1 }

$handle = $process.MainWindowHandle
if ([LuuCodeInput]::IsIconic($handle)) { [void][LuuCodeInput]::ShowWindow($handle, 9) }
[void][LuuCodeInput]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 250

[System.Windows.Forms.SendKeys]::SendWait('__KEYS__')
Write-Output 'sent'
`;

/** SendKeys notation for the shortcuts we need. */
const WINDOWS_KEYS: Record<string, string> = {
  play: "{F5}",
  stop: "+{F5}",
  run: "{F8}",
};

/** macOS virtual key codes. */
const MAC_KEY_CODES: Record<string, string> = {
  play: "96",
  stop: "96 using shift down",
  run: "97",
};

export type StudioShortcut = keyof typeof WINDOWS_KEYS;

export interface NativeInput {
  pressStudioShortcut(shortcut: StudioShortcut): Promise<void>;
  available: boolean;
}

async function pressWindows(shortcut: StudioShortcut): Promise<void> {
  const keys = WINDOWS_KEYS[shortcut];
  if (!keys) throw new LuuCodeError("INVALID_PARAMS", `Unknown Studio shortcut ${shortcut}`);

  try {
    await powershell(WINDOWS_SEND_KEY.replace("__KEYS__", keys), 15_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("NO_STUDIO_WINDOW")) {
      throw new LuuCodeError("INPUT_FAILED", "No Roblox Studio window is open on this machine.");
    }

    throw new LuuCodeError("INPUT_FAILED", `Could not send the Studio shortcut: ${message}`, { cause: error });
  }
}

async function pressMac(shortcut: StudioShortcut): Promise<void> {
  const code = MAC_KEY_CODES[shortcut];
  if (!code) throw new LuuCodeError("INVALID_PARAMS", `Unknown Studio shortcut ${shortcut}`);

  try {
    await osascript('tell application "RobloxStudio" to activate');
    await osascript(`tell application "System Events" to key code ${code}`);
  } catch (error) {
    throw new LuuCodeError(
      "INPUT_FAILED",
      `Could not send the Studio shortcut: ${(error as Error).message}`,
      { hint: "macOS needs Accessibility permission for the app sending the key.", cause: error },
    );
  }
}

export function createNativeInput(): NativeInput {
  if (process.platform === "win32") {
    return { pressStudioShortcut: pressWindows, available: true };
  }

  if (process.platform === "darwin") {
    return { pressStudioShortcut: pressMac, available: true };
  }

  return {
    available: false,
    pressStudioShortcut: async () => {
      throw new LuuCodeError("UNSUPPORTED_CAPABILITY", `Native input is not supported on ${process.platform}.`);
    },
  };
}
