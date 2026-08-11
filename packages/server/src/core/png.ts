/**
 * RGBA to PNG.
 *
 * The plugin captures the viewport and reads its pixels, but it cannot encode
 * them: PNG is deflate, and Luau has no compressor. Node does, so the split
 * falls where the tools are — raw pixels cross the wire, and the image is built
 * here.
 *
 * Deliberately not a dependency. The whole format needed for this one job is a
 * fixed header, one compressed block of scanlines, and a CRC — and a native
 * image library in a local server that ships on three platforms is a build
 * problem out of all proportion to sixty lines.
 */
import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Standard PNG/zlib CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }

  return table;
})();

function crc32(data: Buffer): number {
  let crc = -1;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);

  const tagged = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tagged), 0);

  return Buffer.concat([length, tagged, crc]);
}

/**
 * Encodes 8-bit RGBA pixels, row-major and top-down, as a PNG.
 *
 * Every scanline is written with filter type 0. Real filters buy perhaps a
 * quarter off the size at the cost of a pass over the image per row, and this
 * runs on a screenshot an agent is waiting for.
 */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const expected = width * height * 4;

  if (rgba.length < expected) {
    throw new Error(`Expected ${expected} bytes of RGBA for ${width}x${height}, got ${rgba.length}`);
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    rgba.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
