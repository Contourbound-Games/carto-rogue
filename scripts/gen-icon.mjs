// Renders the desktop build's application icon (build/icon.png, 256x256) from the same shapes as the
// inline favicon in index.html: a trig-point triangle and centre dot on parchment. electron-builder
// turns it into the .exe icon. Replace build/icon.png with final artwork when there is some.
//
// Usage: npm run gen:icon
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'build', 'icon.png');

const SIZE = 256;
/** The favicon's viewBox is 16x16. */
const VIEW = 16;
/** Samples per pixel along each axis (anti-aliasing). */
const SS = 4;

const PARCHMENT = [0xf4, 0xec, 0xd8];
const RED = [0x9b, 0x2d, 0x20];
const INK = [0x3a, 0x2e, 0x2b];

// <path d='M8 2.5 14 13.5H2Z' stroke-width='2' stroke-linejoin='round'/> and <circle cx='8' cy='10' r='1.5'/>
const TRIANGLE = [
  [8, 2.5],
  [14, 13.5],
  [2, 13.5],
];
const STROKE_HALF = 1;
const DOT = { x: 8, y: 10, r: 1.5 };

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function colourAt(x, y) {
  if (Math.hypot(x - DOT.x, y - DOT.y) <= DOT.r) return INK;
  for (let i = 0; i < TRIANGLE.length; i++) {
    if (segmentDistance(x, y, TRIANGLE[i], TRIANGLE[(i + 1) % TRIANGLE.length]) <= STROKE_HALF) return RED;
  }
  return PARCHMENT;
}

// One filter byte (0 = none) before each RGBA row.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let py = 0; py < SIZE; py++) {
  const row = py * (SIZE * 4 + 1);
  for (let px = 0; px < SIZE; px++) {
    const sum = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = colourAt(((px + (sx + 0.5) / SS) * VIEW) / SIZE, ((py + (sy + 0.5) / SS) * VIEW) / SIZE);
        for (let k = 0; k < 3; k++) sum[k] += c[k];
      }
    }
    const o = row + 1 + px * 4;
    for (let k = 0; k < 3; k++) raw[o + k] = Math.round(sum[k] / (SS * SS));
    raw[o + 3] = 255;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(`wrote ${path.relative(root, outPath)} (${SIZE}x${SIZE}, ${png.length} bytes)`);
