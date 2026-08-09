/**
 * Visual observation. Spec sections 17 and 36.
 *
 * Roblox exposes no way for a plugin to read the viewport, so screenshots have
 * to come from the desktop. Capture is scoped to the Roblox Studio window
 * rather than the whole screen wherever the platform allows it, which keeps
 * unrelated windows out of the agent's context.
 *
 * The Electron harness registers a better provider at startup (it can capture
 * an occluded window through the compositor); this platform path is what makes
 * headless MCP use work without it.
 */
import { readFile, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LuuCodeError } from "@luumen/code-protocol";
import type { ScreenshotResult } from "@luumen/code-protocol";
import { osascript, powershell } from "./process.js";
import { screenshotDir } from "../config/paths.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("screenshot");

export interface ScreenshotRequest {
  source: "studio" | "screen";
  maxWidth: number;
  format: "png" | "jpeg";
}

export type ScreenshotProvider = (request: ScreenshotRequest) => Promise<ScreenshotResult>;

const WINDOWS_CAPTURE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LuuCodeWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$source = '__SOURCE__'
$maxWidth = __MAXWIDTH__
$outputPath = '__OUTPUT__'
$format = '__FORMAT__'

$bounds = $null

if ($source -eq 'studio') {
  $process = Get-Process -Name 'RobloxStudioBeta','RobloxStudio' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

  if ($null -eq $process) { Write-Error 'NO_STUDIO_WINDOW'; exit 1 }

  $handle = $process.MainWindowHandle

  # A minimized window has no pixels on screen, so restore it before capturing.
  if ([LuuCodeWin]::IsIconic($handle)) {
    [void][LuuCodeWin]::ShowWindow($handle, 9)
    Start-Sleep -Milliseconds 350
  }

  $rect = New-Object LuuCodeWin+RECT
  if (-not [LuuCodeWin]::GetWindowRect($handle, [ref]$rect)) { Write-Error 'NO_WINDOW_RECT'; exit 1 }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { Write-Error 'EMPTY_WINDOW_RECT'; exit 1 }

  $bounds = New-Object System.Drawing.Rectangle($rect.Left, $rect.Top, $width, $height)
} else {
  Add-Type -AssemblyName System.Windows.Forms
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$graphics.Dispose()

$final = $bitmap
if ($maxWidth -gt 0 -and $bitmap.Width -gt $maxWidth) {
  $scale = $maxWidth / $bitmap.Width
  $targetWidth = [int]($bitmap.Width * $scale)
  $targetHeight = [int]($bitmap.Height * $scale)
  $resized = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
  $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
  $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $resizeGraphics.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)
  $resizeGraphics.Dispose()
  $bitmap.Dispose()
  $final = $resized
}

if ($format -eq 'jpeg') {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 82)
  $final.Save($outputPath, $codec, $params)
} else {
  $final.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
}

Write-Output ("{0}x{1}" -f $final.Width, $final.Height)
$final.Dispose()
`;

function tempFile(extension: string): string {
  const directory = screenshotDir();
  mkdirSync(directory, { recursive: true });
  return join(directory, `capture_${randomUUID().slice(0, 8)}.${extension}`);
}

async function captureWindows(request: ScreenshotRequest): Promise<ScreenshotResult> {
  const extension = request.format === "jpeg" ? "jpg" : "png";
  const output = tempFile(extension);

  const script = WINDOWS_CAPTURE.replace("__SOURCE__", request.source)
    .replace("__MAXWIDTH__", String(request.maxWidth))
    .replace("__OUTPUT__", output.replace(/'/g, "''"))
    .replace("__FORMAT__", request.format);

  let dimensions = "0x0";

  try {
    const { stdout } = await powershell(script, 30_000);
    dimensions = stdout.trim().split(/\r?\n/).pop() ?? "0x0";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("NO_STUDIO_WINDOW")) {
      throw new LuuCodeError("SCREENSHOT_FAILED", "No Roblox Studio window is open on this machine.", {
        hint: "Open the place in Studio, then capture again.",
      });
    }

    throw new LuuCodeError("SCREENSHOT_FAILED", `Windows screen capture failed: ${message}`, { cause: error });
  }

  return finalize(output, request, dimensions);
}

async function captureMac(request: ScreenshotRequest): Promise<ScreenshotResult> {
  const extension = request.format === "jpeg" ? "jpg" : "png";
  const output = tempFile(extension);
  const args = ["-x", "-o", "-t", request.format === "jpeg" ? "jpg" : "png"];

  if (request.source === "studio") {
    try {
      const { stdout } = await osascript(
        'tell application "System Events" to tell process "RobloxStudio" to get {position, size} of window 1',
      );
      const numbers = stdout
        .trim()
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10));

      if (numbers.length >= 4 && numbers.every((value) => Number.isFinite(value))) {
        args.push("-R", `${numbers[0]},${numbers[1]},${numbers[2]},${numbers[3]}`);
      }
    } catch (error) {
      // Usually a missing Accessibility permission. Fall back to the full
      // screen rather than failing the agent's whole verification step.
      log.warn("Could not read the Studio window rect; capturing the full screen instead", error);
    }
  }

  args.push(output);

  try {
    await (await import("./process.js")).runCommand("screencapture", args, { timeoutMs: 30_000 });
  } catch (error) {
    throw new LuuCodeError("SCREENSHOT_FAILED", `macOS screen capture failed: ${(error as Error).message}`, { cause: error });
  }

  return finalize(output, request, "0x0");
}

async function finalize(path: string, request: ScreenshotRequest, dimensions: string): Promise<ScreenshotResult> {
  let data: Buffer;

  try {
    data = await readFile(path);
  } catch (error) {
    throw new LuuCodeError("SCREENSHOT_FAILED", "The capture produced no image file.", { cause: error });
  } finally {
    void unlink(path).catch(() => undefined);
  }

  const [width, height] = dimensions.split("x").map((value) => Number.parseInt(value, 10));

  return {
    data: data.toString("base64"),
    mimeType: request.format === "jpeg" ? "image/jpeg" : "image/png",
    width: Number.isFinite(width) ? (width as number) : 0,
    height: Number.isFinite(height) ? (height as number) : 0,
    capturedAt: Date.now(),
    source: request.source,
  };
}

export function platformScreenshotProvider(): ScreenshotProvider | null {
  if (process.platform === "win32") return captureWindows;
  if (process.platform === "darwin") return captureMac;
  return null;
}
