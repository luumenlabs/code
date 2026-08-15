/**
 * Desktop capture through Electron. desktopCapturer goes through the
 * compositor, so the Studio window is captured without being brought to the
 * front. The server falls back to a platform helper when the app is not running.
 *
 * This answers `source: "window"` and `source: "screen"`. `view.screenshot`
 * captures the viewport through CaptureService inside Studio by default.
 */
import { desktopCapturer, screen } from "electron";
import type { DesktopCaptureProvider, DesktopCaptureRequest } from "@luumen/code-server";
import { LuuCodeError } from "@luumen/code-protocol";

const STUDIO_WINDOW_PATTERN = /roblox studio/i;

export function createElectronDesktopCaptureProvider(): DesktopCaptureProvider {
  return async (request: DesktopCaptureRequest) => {
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    const bounds = screen.getPrimaryDisplay().bounds;

    // Requesting the final size directly makes the compositor do a low-quality
    // resize, so downscale afterwards.
    const thumbnailSize = {
      width: Math.round(bounds.width * scale),
      height: Math.round(bounds.height * scale),
    };

    const sources = await desktopCapturer.getSources({
      types: request.source === "window" ? ["window", "screen"] : ["screen"],
      thumbnailSize,
      fetchWindowIcons: false,
    });

    const source =
      request.source === "window"
        ? sources.find((entry) => STUDIO_WINDOW_PATTERN.test(entry.name)) ?? null
        : sources.find((entry) => entry.id.startsWith("screen")) ?? sources[0] ?? null;

    if (!source) {
      throw new LuuCodeError(
        "SCREENSHOT_FAILED",
        request.source === "window"
          ? "No Roblox Studio window was found to capture."
          : "No screen was available to capture.",
        { hint: "Open the place in Studio, then capture again." },
      );
    }

    let image = source.thumbnail;

    if (image.isEmpty()) {
      throw new LuuCodeError("SCREENSHOT_FAILED", "The capture came back empty.", {
        hint: "On macOS, grant Luu Code Screen Recording permission in System Settings.",
      });
    }

    const size = image.getSize();

    if (request.maxWidth > 0 && size.width > request.maxWidth) {
      image = image.resize({ width: request.maxWidth, quality: "good" });
    }

    const finalSize = image.getSize();

    return {
      data: image.toPNG().toString("base64"),
      mimeType: "image/png",
      width: finalSize.width,
      height: finalSize.height,
      capturedAt: Date.now(),
      source: request.source,
      // A desktop capture photographs a window, not a DataModel.
      realm: null,
    };
  };
}
