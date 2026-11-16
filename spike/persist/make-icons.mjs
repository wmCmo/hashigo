import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function ladderPng(size) {
  const bg = [0x18, 0x1c, 0x24];
  const ink = [0xf5, 0xd0, 0x6a];
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const unit = size / 16;
  const railLeft = [4 * unit, 5.2 * unit];
  const railRight = [10.8 * unit, 12 * unit];
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0;
    const onRung =
      y > 2 * unit &&
      y < 14 * unit &&
      [3, 5.2, 7.4, 9.6, 11.8].some((r) => y >= r * unit && y < r * unit + 0.9 * unit);
    for (let x = 0; x < size; x += 1) {
      const inRail =
        (x >= railLeft[0] && x < railLeft[1]) || (x >= railRight[0] && x < railRight[1]);
      const inRung = onRung && x >= railLeft[0] && x < railRight[1];
      const colour = y > 1.5 * unit && y < 14.5 * unit && (inRail || inRung) ? ink : bg;
      const at = rowStart + 1 + x * 3;
      raw[at] = colour[0];
      raw[at + 1] = colour[1];
      raw[at + 2] = colour[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = join(here, `icon-${size}.png`);
  const png = ladderPng(size);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length.toLocaleString()} bytes, ${size}x${size})`);
}
