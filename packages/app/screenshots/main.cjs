/**
 * A one-window Electron app whose only job is to hold the real renderer still.
 *
 * It is not the app's main process and shares no code with it: no local server,
 * no updater, no plugin installer, no CLI discovery. It opens a window with the
 * same chrome settings the real one uses — the title bar is drawn by the page,
 * so those settings are what make the screenshot look like the product — points
 * it at the built renderer, and swaps in the fake preload.
 *
 * `--shot` captures the page and quits. Without it the window just stays open
 * for you to photograph yourself.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const HERE = __dirname;
const RENDERER = join(HERE, "..", "dist", "renderer", "index.html");

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const WIDTH = Number(arg("width", "1440"));
const HEIGHT = Number(arg("height", "900"));
const OUT = resolve(arg("out", join(HERE, "out", "luu-code.png")));
// Long enough for fonts, the Radix popovers' measurement pass, and the first
// paint of the spinners. A shot taken too early is a shot of a half-styled app.
const SETTLE = Number(arg("settle", "1600"));
const QUALITY = Number(arg("quality", "0.92"));

/**
 * WebP, encoded by the copy of Chromium already running.
 *
 * Electron's `NativeImage` only writes PNG and JPEG, and a screenshot of a UI
 * is the worst case for both: PNG keeps every pixel of a mostly-flat dark
 * surface, JPEG turns 11px text into mush. Rather than take on `sharp` — a
 * native dependency, in a folder whose whole point is that it is disposable —
 * this hands the bitmap back to the page and lets Chromium's own encoder do it.
 *
 * The window is about to be thrown away, so drawing on it costs nothing.
 */
async function encodeWebp(window, image) {
  const source = image.toDataURL();

  const encoded = await window.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(source)};
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);

    return canvas.toDataURL("image/webp", ${QUALITY});
  })()`);

  if (!encoded.startsWith("data:image/webp")) {
    throw new Error("Chromium declined to encode WebP and fell back to PNG.");
  }

  return Buffer.from(encoded.slice(encoded.indexOf(",") + 1), "base64");
}

async function main() {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    // Exact page pixels rather than "window including frame minus whatever the
    // OS took", so `--width`/`--height` are the size of the image.
    useContentSize: true,
    backgroundColor: "#171717",
    title: "Luu Code",
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 10 } } : {}),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  ipcMain.handle("window-minimize", () => window.minimize());
  ipcMain.handle("window-toggle-maximize", () => (window.isMaximized() ? window.unmaximize() : window.maximize()));
  ipcMain.handle("window-close", () => window.close());

  await window.loadFile(RENDERER);
  window.show();

  if (!flag("shot")) {
    console.log(`Window open at ${WIDTH}x${HEIGHT}. Take your screenshot, then close it.`);
    return;
  }

  await new Promise((done) => setTimeout(done, SETTLE));

  const image = await window.webContents.capturePage();
  // The extension is the format. One flag fewer, and no way to ask for a `.webp`
  // that is secretly a PNG.
  const bytes = OUT.endsWith(".webp") ? await encodeWebp(window, image) : image.toPNG();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bytes);

  const { width, height } = image.getSize();
  console.log(`Wrote ${OUT} (${width}x${height}, ${Math.round(bytes.length / 1024)} KB)`);

  /**
   * A real window cannot be bigger than the screen it is on, and Windows
   * silently shrinks one that tries — which produces a cramped layout rather
   * than an error, and you only find out when you look at the picture. So say
   * it out loud.
   *
   * This is the cost of photographing an actual window instead of rendering
   * offscreen. Raising `--scale` shrinks the room available in layout pixels,
   * so a 2x shot needs a display with twice the space, or a smaller `--width`.
   */
  const [got, want] = [window.getContentSize(), [WIDTH, HEIGHT]];
  if (got[0] !== want[0] || got[1] !== want[1]) {
    console.warn(
      `\n  Asked for ${want[0]}x${want[1]} layout pixels, got ${got[0]}x${got[1]}.` +
        `\n  The window was clamped to your display. Lower --scale, or pass a smaller --width/--height.\n`,
    );
  }

  app.quit();
}

app.whenReady().then(main);
app.on("window-all-closed", () => app.quit());
