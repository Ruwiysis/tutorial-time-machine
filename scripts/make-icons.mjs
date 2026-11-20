// Draws the Tutorial Time-Machine icon (an hourglass on a violet tile) and
// writes PNGs for the extension and the web app. No dependencies: a tiny PNG
// encoder on top of node:zlib, with 4x4 supersampling for smooth edges.
//
//   node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const BG_TOP = [124, 87, 240]; // violet, matches the on-device accent
const BG_BOTTOM = [79, 52, 196];
const GLASS = [255, 255, 255];
const SAND = [255, 176, 92]; // cache amber

/** Colour of a point (x, y in 0..1), or null if transparent. */
function shade(x, y) {
  // Rounded-square tile.
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;

  // Frame bars.
  if (x >= 0.26 && x <= 0.74 && ((y >= 0.17 && y <= 0.25) || (y >= 0.75 && y <= 0.83))) return GLASS;

  // Glass: two triangles meeting at a narrow neck in the middle.
  const half = (t) => 0.035 + 0.165 * t; // half-width, t = 0 at the neck, 1 at a bar
  if (y > 0.25 && y < 0.75) {
    const t = Math.abs(y - 0.5) / 0.25;
    const w = half(t);
    if (Math.abs(x - 0.5) <= w) {
      const inner = Math.abs(x - 0.5) <= w - 0.045 && y > 0.29 && y < 0.71;
      if (!inner) return GLASS; // outline
      if (y > 0.6) return SAND; // sand pile at the bottom
      if (y > 0.4 && y < 0.5) return SAND; // what's left in the top chamber
      if (y >= 0.5 && Math.abs(x - 0.5) < 0.012) return SAND; // falling stream
    }
  }
  // Background gradient.
  return BG_TOP.map((c, i) => Math.round(c + (BG_BOTTOM[i] - c) * y));
}

function render(size) {
  const ss = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0 + RGBA
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = 1 + px * 4;
      if (a) {
        row[o] = Math.round(r / a);
        row[o + 1] = Math.round(g / a);
        row[o + 2] = Math.round(b / a);
      }
      row[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(out('apps/extension/public/icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(out(`apps/extension/public/icons/icon${size}.png`), render(size));
mkdirSync(out('apps/web/public'), { recursive: true });
writeFileSync(out('apps/web/public/icon-32.png'), render(32));
writeFileSync(out('apps/web/public/icon-180.png'), render(180));
writeFileSync(out('apps/web/public/icon-512.png'), render(512));
console.log('icons written');
