/**
 * Rasterise the mark into the PNGs a web app manifest needs.
 *
 *     node tools/icons.mjs
 *
 * Output is `app/public/icons/`. They are GENERATED — deleting them and
 * re-running is always correct, and `test/icons.test.ts` re-derives the geometry
 * from the same rule `app/brand/mark.svg` follows.
 *
 * ─── WHY A RASTERISER RATHER THAN A DEPENDENCY OR A HAND-PUSHED BITMAP ───────
 *
 * `spike/persist/make-icons.mjs` pushes pixels in a loop and draws a crude
 * ladder, which was right for a throwaway that only had to be 48px-legible. This
 * one has to be the ACTUAL mark: the round line caps are load-bearing (they are
 * why the wordmark is set at maximum softness) and a nearest-neighbour loop
 * cannot draw a round cap.
 *
 * It does not need a library either. Every element of this mark is a THICK LINE
 * SEGMENT WITH ROUND CAPS — which is exactly a capsule, and the signed distance
 * to a capsule is four lines of algebra. Anti-aliasing is then a smoothstep over
 * one pixel of that distance, which is what a real rasteriser does anyway.
 *
 * ─── THE BADGE IS THE ONE PLACE THE BRIEF ALLOWS A CONTAINER ────────────────
 *
 * "Do not add a container. No rounded-square badge behind the mark except in the
 * app-icon context, where the badge is `rx: 15` on a 64-unit square." This is
 * that context, and 15/64 is the radius ratio used below. Everywhere else in the
 * app the mark sits on the bare paper.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "app", "public", "icons");

// ─── the mark, in its 100-unit box. These numbers are DERIVED — see
// `app/brand/mark.svg` and the rail equation in `app/climb.ts`. Do not tidy. ───

const SLOPE = 0.20909;
const railX = (y) => [16 + (87 - y) * SLOPE, 84 - (87 - y) * SLOPE];

const INDIGO = [0x1b, 0x3b, 0x6f];
const VERMILION = [0xe0, 0x45, 0x1d];
const PAPER = [0xec, 0xea, 0xe5];

/**
 * THE COLOURWAY IS NOT IN THE BRIEF. Checked 2026-09-12: §2 constrains the
 * app-icon badge to `rx: 15` on a 64-unit square and says nothing about what
 * colour either the badge or the mark is there. Both readings below obey every
 * rule it DOES state — round caps kept, only the top rung vermilion.
 *
 *   ink-on-paper   paper badge, indigo mark. The literal palette default.
 *   paper-on-ink   indigo badge, paper mark. More separation on a home screen,
 *                  where the icon competes with other icons rather than sitting
 *                  on the app's own ground.
 */
const WAYS = {
  "ink-on-paper": { ground: PAPER, ink: INDIGO },
  "paper-on-ink": { ground: INDIGO, ink: PAPER },
};

/** Two rails, three rungs, one loose rung. Each is a round-capped segment. */
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
  // The one vermilion in the whole system: the step not yet taken. Unchanged in
  // both colourways, because that rule IS in the brief.
  segments.push({ a: [ll, 13], b: [lr, 13], w: 9, colour: VERMILION });
  return segments;
}

/** The drawn extent of the mark in viewBox units, stroke width included. */
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

/** Signed distance from `p` to the capsule of radius w/2 around segment a-b. */
function capsuleDistance(px, py, [ax, ay], [bx, by], w) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy) - w / 2;
}

/** Signed distance to a rounded rectangle centred on the canvas. */
function roundedRectDistance(px, py, size, radius) {
  const hx = size / 2 - radius, hy = size / 2 - radius;
  const qx = Math.abs(px - size / 2) - hx, qy = Math.abs(py - size / 2) - hy;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Coverage in [0,1] from a signed distance, anti-aliased over one pixel. */
const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d));

const over = (src, dst, alpha) => src.map((c, i) => Math.round(c * alpha + dst[i] * (1 - alpha)));

/**
 * Draw the mark on a badge.
 *
 * `inset` is the fraction of the canvas the mark's drawn extent may occupy.
 * MASKABLE ICONS GET A SMALLER ONE AND THE REASON IS GEOMETRY, NOT TASTE: the
 * platform may crop to a circle of 80% diameter, and the largest square that
 * fits inside that circle is 0.8/√2 ≈ 56.6% of the canvas. Anything larger can
 * have its corners cut, which on this mark means the rail feet.
 */
function render(size, { inset, badge, way = "ink-on-paper" }) {
  const { ground, ink } = WAYS[way];
  const segments = markSegments(ink);
  const bounds = markBounds(segments);
  const scale = (size * inset) / Math.max(bounds.w, bounds.h);
  const offsetX = size / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
  const offsetY = size / 2 - ((bounds.minY + bounds.maxY) / 2) * scale;

  // Map a canvas pixel back into viewBox units, so distances stay in those units
  // and the stroke widths mean what the SVG says they mean.
  const toBox = (p, offset) => (p - offset) / scale;
  const radius = (15 / 64) * size;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // PNG filter type 0
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5, py = y + 0.5;

      // `badge` rounds the corners and lets the platform's own background show
      // through outside them — that is the brief's rx:15-on-64 square, and it is
      // the shape desktop Chrome and Windows actually display.
      // A MASKABLE ICON MUST NOT DO THIS: the platform crops it to whatever
      // shape it likes, and a transparent corner under that crop is a visible
      // notch. Maskable is full bleed, alpha 255 everywhere.
      let alpha = badge ? coverage(roundedRectDistance(px, py, size, radius)) : 1;
      let colour = ground;

      const bx = toBox(px, offsetX), by = toBox(py, offsetY);
      // Painted in order, so the rails sit under the rungs exactly as the SVG
      // stacks them.
      for (const s of segments) {
        const d = capsuleDistance(bx, by, s.a, s.b, s.w) * scale;
        const a = coverage(d);
        if (a > 0) {
          colour = over(s.colour, colour, a);
          // Ink is opaque even where it overhangs the badge's rounded corner,
          // so a cap never gets sliced by the container it sits in.
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

// ─── PNG container: signature, IHDR, one deflated IDAT, IEND ────────────────

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DEST = process.argv.includes('--compare') ? join(ROOT, 'build', 'icon-compare') : OUT;
mkdirSync(DEST, { recursive: true });

/**
 * `node tools/icons.mjs --compare` renders BOTH colourways into
 * `build/icon-compare/` so they can be looked at side by side rather than
 * argued about. The brief does not settle this — see WAYS above.
 *
 * `--paper-on-ink` switches the shipped set to the inverted reading.
 */
const WAY = process.argv.includes('--paper-on-ink') ? 'paper-on-ink' : 'ink-on-paper';

const targets = process.argv.includes('--compare')
  ? [
      { file: 'compare-ink-on-paper-512.png', size: 512, inset: 0.68, badge: true, way: 'ink-on-paper' },
      { file: 'compare-paper-on-ink-512.png', size: 512, inset: 0.68, badge: true, way: 'paper-on-ink' },
      { file: 'compare-ink-on-paper-192.png', size: 192, inset: 0.68, badge: true, way: 'ink-on-paper' },
      { file: 'compare-paper-on-ink-192.png', size: 192, inset: 0.68, badge: true, way: 'paper-on-ink' },
    ]
  : [
      // `any`: the mark on its badge, generous.
      { file: 'icon-192.png', size: 192, inset: 0.68, badge: true, way: WAY },
      { file: 'icon-512.png', size: 512, inset: 0.68, badge: true, way: WAY },
      // `maskable`: full bleed, mark inside the safe circle. See `render`.
      { file: 'icon-maskable-512.png', size: 512, inset: 0.52, badge: false, way: WAY },
      // iOS never reads the manifest; it wants its own square and does not round
      // the corners on every version, so this one carries the badge.
      { file: 'apple-touch-icon.png', size: 180, inset: 0.68, badge: true, way: WAY },
    ];

for (const t of targets) {
  const bytes = render(t.size, t);
  writeFileSync(join(DEST, t.file), bytes);
  console.log(`  ${t.file.padEnd(26)} ${String(t.size).padStart(4)}px  ${String(bytes.length).padStart(7)} bytes`);
}
console.log(`\nwrote ${DEST}`);
