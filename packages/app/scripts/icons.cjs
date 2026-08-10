/**
 * Renders the icon masters into every raster format the app and the README need.
 *
 * Two channels: the blue release icon and the purple nightly one, so a nightly
 * build is recognisable in a dock full of app icons.
 *
 * Run with `pnpm assets:icons` from the repo root. Output is committed, so this
 * only needs running when a master SVG changes.
 *
 * Electron does the rasterising because it is already a dependency and it is
 * the same renderer that will draw the icon in the app, so what ships and what
 * you preview cannot drift.
 */
const { app, BrowserWindow } = require("electron");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..", "..", "..");
const assetsDir = join(repoRoot, "assets");
const pngDir = join(assetsDir, "png");
const scratchDir = join(__dirname, ".icons-tmp");

/** Sizes Windows, macOS, Linux, and the web all want between them. */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

/** Sizes packed into the .ico. 256 is the practical ceiling for the format. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** OSType → pixel size, for the .icns. */
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
];

/**
 * The channels, and what each one is called on disk.
 *
 * `renderer` is the copy the app loads as its favicon; only the release icon
 * needs one, since the window itself takes the platform icon.
 */
const VARIANTS = [
  { name: "release", master: "icon.svg", stem: "icon", renderer: true },
  { name: "nightly", master: "icon-nightly.svg", stem: "icon-nightly", renderer: false },
];

app.disableHardwareAcceleration();
// Without this, a scaled display silently multiplies every capture.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

/**
 * One window for the whole run, resized between shots.
 *
 * Creating and destroying a transparent window per size raced with itself and
 * failed the load; reusing it is both faster and reliable.
 */
let canvas = null;
let shot = 0;

/** Renders an HTML document at an exact pixel size and returns the image. */
async function shoot(html, width, height) {
  if (!canvas) {
    canvas = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      useContentSize: true,
      backgroundColor: "#00000000",
    });
  }

  canvas.setContentSize(width, height);

  // A real file rather than a data URL: data URLs this long fail to load, and a
  // file origin is what lets the banner's @font-face URLs resolve. The name
  // changes every shot so nothing is served from cache.
  const document = join(scratchDir, `render-${(shot += 1)}.html`);
  writeFileSync(document, html);

  await canvas.loadFile(document);
  // A beat for webfonts and gradients to settle before the capture.
  await new Promise((done) => setTimeout(done, 250));

  let image = await canvas.webContents.capturePage();
  const captured = image.getSize();

  if (captured.width !== width || captured.height !== height) {
    image = image.resize({ width, height, quality: "best" });
  }

  return image;
}

function page(body, background = "transparent") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:${background};overflow:hidden}
  </style></head><body>${body}</body></html>`;
}

async function renderIcon(svg, size) {
  const scaled = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
  return shoot(page(`<div style="width:${size}px;height:${size}px">${scaled}</div>`), size, size);
}

/**
 * A 32-bit bottom-up DIB, the classic ICO payload.
 *
 * `capturePage` hands back BGRA top-down, which is already the channel order a
 * DIB wants; only the row order has to be flipped. The AND mask is left blank
 * because the alpha channel carries the transparency.
 */
function dib(image, size) {
  const bgra = image.toBitmap();
  const stride = size * 4;

  const xor = Buffer.alloc(bgra.length);
  for (let row = 0; row < size; row += 1) {
    bgra.copy(xor, (size - 1 - row) * stride, row * stride, row * stride + stride);
  }

  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height: colour rows plus mask rows
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(xor.length + mask.length, 20);

  return Buffer.concat([header, xor, mask]);
}

/**
 * ICO.
 *
 * Everything up to 128 goes in as a DIB and 256 as PNG, which is the layout
 * Windows shells and icon readers agree on. An all-PNG file renders fine in
 * Explorer but reads as truncated to some decoders.
 */
function buildIco(entries) {
  const payloads = entries.map(({ size, image }) => (size >= 256 ? image.toPNG() : dib(image, size)));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;

  entries.forEach(({ size }, index) => {
    const at = index * 16;
    // 0 means 256 in a single byte.
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(payloads[index].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += payloads[index].length;
  });

  return Buffer.concat([header, directory, ...payloads]);
}

/** ICNS, likewise PNG-backed. */
function buildIcns(byType) {
  const chunks = byType.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);

  return Buffer.concat([head, body]);
}

function bannerHtml(svg) {
  const fonts = join(repoRoot, "node_modules", ".pnpm");
  const syne = join(
    fonts,
    "@fontsource-variable+syne@5.3.0",
    "node_modules",
    "@fontsource-variable",
    "syne",
    "files",
    "syne-latin-wght-normal.woff2",
  );
  const dmSans = join(
    fonts,
    "@fontsource-variable+dm-sans@5.3.0",
    "node_modules",
    "@fontsource-variable",
    "dm-sans",
    "files",
    "dm-sans-latin-wght-normal.woff2",
  );

  const face = (family, file) =>
    `@font-face{font-family:'${family}';font-weight:100 900;src:url('file:///${file.replace(/\\/g, "/")}') format('woff2-variations')}`;

  return page(
    `<div style="
        width:1200px;height:480px;box-sizing:border-box;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;
        background:radial-gradient(120% 140% at 50% 0%, #1b1f28 0%, #0f1013 55%, #0a0a0b 100%);
        font-family:'DM Sans Variable',system-ui,sans-serif;color:#fafafa;text-align:center;">
      <div style="width:132px;height:132px;filter:drop-shadow(0 24px 60px rgba(59,130,246,.35))">${svg.replace(/width="1024" height="1024"/, 'width="132" height="132"')}</div>
      <div style="font-family:'Syne Variable',system-ui,sans-serif;font-weight:800;font-size:56px;letter-spacing:-.02em;line-height:1">Luu Code</div>
      <div style="font-size:20px;line-height:1.5;color:#a1a1aa;max-width:640px">Use Claude Code or Codex with Roblox Studio.</div>
    </div>
    <style>${face("Syne Variable", syne)}${face("DM Sans Variable", dmSans)}</style>`,
  );
}

app.whenReady().then(async () => {
  mkdirSync(pngDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });

  let releaseSvg = "";

  for (const variant of VARIANTS) {
    const svg = readFileSync(join(assetsDir, variant.master), "utf8");
    const rendered = new Map();

    if (variant.renderer) {
      releaseSvg = svg;
      // The renderer's favicon, kept next to the code that loads it so Vite can
      // fingerprint it like any other asset.
      writeFileSync(join(__dirname, "..", "src", "renderer", "assets", "icon.svg"), svg);
    }

    console.log(`\n${variant.name}`);

    for (const size of SIZES) {
      const image = await renderIcon(svg, size);
      const png = image.toPNG();

      rendered.set(size, image);
      writeFileSync(join(pngDir, `${variant.stem}-${size}.png`), png);
      console.log(`  ${variant.stem}-${size}.png  ${png.length.toLocaleString()} bytes`);
    }

    writeFileSync(join(assetsDir, `${variant.stem}.png`), rendered.get(1024).toPNG());

    writeFileSync(
      join(assetsDir, `${variant.stem}.ico`),
      buildIco(ICO_SIZES.map((size) => ({ size, image: rendered.get(size) }))),
    );
    console.log(`  ${variant.stem}.ico`);

    writeFileSync(
      join(assetsDir, `${variant.stem}.icns`),
      buildIcns(ICNS_TYPES.map(([type, size]) => [type, rendered.get(size).toPNG()])),
    );
    console.log(`  ${variant.stem}.icns`);
  }

  const banner = (await shoot(bannerHtml(releaseSvg), 1200, 480)).toPNG();
  writeFileSync(join(assetsDir, "banner.png"), banner);
  console.log(`\nbanner.png  ${banner.length.toLocaleString()} bytes`);

  rmSync(scratchDir, { recursive: true, force: true });
  app.quit();
});
