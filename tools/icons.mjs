import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "app", "public", "icons");

const SLOPE = 0.20909;
const railX = (y) => [16 + (87 - y) * SLOPE, 84 - (87 - y) * SLOPE];

const INDIGO = [0x3a, 0x3a, 0x3a];
const VERMILION = [0x1f, 0x5f, 0xe0];
const PAPER = [0xf2, 0xf2, 0xf2];

const CARD = [0xfc, 0xfc, 0xfc];

const WAYS = {
  "ink-on-paper": { ground: PAPER, ink: INDIGO },
  "paper-on-ink": { ground: INDIGO, ink: PAPER },
  "ink-on-card": { ground: CARD, ink: INDIGO },
};

function markSegments(ink) {
  const segments = [
    { a: [16, 87], b: [27.5, 32], w: 10, colour: ink },
    { a: [84, 87], b: [72.5, 32], w: 10, colour: ink },
  ];
  for (const y of [77, 57, 40]) {
    const [l, r] = railX(y);
    segments.push({ a: [l, y], b: [r, y], w: 9, colour: ink });
  }
  const [ll, lr] = railX(13);
  segments.push({ a: [ll, 13], b: [lr, 13], w: 9, colour: VERMILION });
  return segments;
}

function markBounds(segments) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segments) {
    const h = s.w / 2;
    for (const [x, y] of [s.a, s.b]) {
      minX = Math.min(minX, x - h); maxX = Math.max(maxX, x + h);
      minY = Math.min(minY, y - h); maxY = Math.max(maxY, y + h);
    }
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function capsuleDistance(px, py, [ax, ay], [bx, by], w) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy) - w / 2;
}

function roundedRectDistance(px, py, size, radius) {
  const hx = size / 2 - radius, hy = size / 2 - radius;
  const qx = Math.abs(px - size / 2) - hx, qy = Math.abs(py - size / 2) - hy;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d));

const over = (src, dst, alpha) => src.map((c, i) => Math.round(c * alpha + dst[i] * (1 - alpha)));

function render(size, { inset, badge, way = "ink-on-paper" }) {
  const { ground, ink } = WAYS[way];
  const segments = markSegments(ink);
  const bounds = markBounds(segments);
  const scale = (size * inset) / Math.max(bounds.w, bounds.h);
  const offsetX = size / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
  const offsetY = size / 2 - ((bounds.minY + bounds.maxY) / 2) * scale;

  const toBox = (p, offset) => (p - offset) / scale;
  const radius = (15 / 64) * size;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5, py = y + 0.5;

      let alpha = badge ? coverage(roundedRectDistance(px, py, size, radius)) : 1;
      let colour = ground;

      const bx = toBox(px, offsetX), by = toBox(py, offsetY);
      for (const s of segments) {
        const d = capsuleDistance(bx, by, s.a, s.b, s.w) * scale;
        const a = coverage(d);
        if (a > 0) {
          colour = over(s.colour, colour, a);
          alpha = Math.max(alpha, a);
        }
      }

      const at = row + 1 + x * 4;
      raw[at] = colour[0];
      raw[at + 1] = colour[1];
      raw[at + 2] = colour[2];
      raw[at + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, raw);
}

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
function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DEST = process.argv.includes('--compare') ? join(ROOT, 'build', 'icon-compare') : OUT;
mkdirSync(DEST, { recursive: true });

const WAY = process.argv.includes('--paper-on-ink')
  ? 'paper-on-ink'
  : process.argv.includes('--ink-on-paper')
    ? 'ink-on-paper'
    : 'ink-on-card';

const targets = process.argv.includes('--compare')
  ? [
      { file: 'A-paper-ECEAE5.png', size: 384, inset: 0.52, badge: false, way: 'ink-on-paper' },
      { file: 'B-card-FBFAF7.png', size: 384, inset: 0.52, badge: false, way: 'ink-on-card' },
      { file: 'C-indigo-1B3B6F.png', size: 384, inset: 0.52, badge: false, way: 'paper-on-ink' },
    ]
  : [
      { file: 'icon-192.png', size: 192, inset: 0.68, badge: true, way: WAY },
      { file: 'icon-512.png', size: 512, inset: 0.68, badge: true, way: WAY },
      { file: 'icon-maskable-512.png', size: 512, inset: 0.52, badge: false, way: WAY },
      { file: 'apple-touch-icon.png', size: 180, inset: 0.68, badge: true, way: WAY },
    ];

for (const t of targets) {
  const bytes = render(t.size, t);
  writeFileSync(join(DEST, t.file), bytes);
  console.log(`  ${t.file.padEnd(26)} ${String(t.size).padStart(4)}px  ${String(bytes.length).padStart(7)} bytes`);
}
console.log(`\nwrote ${DEST}`);
