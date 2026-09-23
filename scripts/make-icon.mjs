#!/usr/bin/env node
/**
 * Draws the .mcpb icon (512x512 RGBA PNG): a hub node linked to four satellite nodes on a rounded
 * dark-blue square. An original, generic "connected nodes" mark; it does not use or imitate the
 * Symbol or NEM logos. No dependency: shapes are rasterised with 4x4 supersampling and the PNG is
 * encoded with node:zlib and a hand-written CRC-32, so the output is reproducible.
 *
 *   node scripts/make-icon.mjs mcpb/icon.png
 *
 * Development only; neither the MCP server nor the build reads this file.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const SAMPLES = 4; // per axis

const BACKGROUND = [27, 42, 74]; // #1B2A4A
const LINK = [127, 184, 214]; // #7FB8D6
const HUB = [255, 255, 255];
const SATELLITE = [242, 184, 75]; // #F2B84B

const MARGIN = 16;
const CORNER = 96;
const HUB_CENTER = [256, 256];
const HUB_RADIUS = 58;
const SATELLITES = [
  [140, 140],
  [372, 140],
  [140, 372],
  [372, 372],
];
const SATELLITE_RADIUS = 36;
const LINK_HALF_WIDTH = 11;

function insideRoundedSquare(x, y) {
  const lo = MARGIN;
  const hi = SIZE - MARGIN;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + CORNER), hi - CORNER);
  const cy = Math.min(Math.max(y, lo + CORNER), hi - CORNER);
  return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER ** 2;
}

function insideCircle(x, y, [cx, cy], r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function nearSegment(x, y, [ax, ay], [bx, by], halfWidth) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= halfWidth * halfWidth;
}

/** Colour of one sample point, or null outside the icon (transparent). */
function sample(x, y) {
  if (!insideRoundedSquare(x, y)) return null;
  if (insideCircle(x, y, HUB_CENTER, HUB_RADIUS)) return HUB;
  if (SATELLITES.some((c) => insideCircle(x, y, c, SATELLITE_RADIUS))) return SATELLITE;
  if (SATELLITES.some((c) => nearSegment(x, y, HUB_CENTER, c, LINK_HALF_WIDTH))) return LINK;
  return BACKGROUND;
}

function render() {
  const stride = SIZE * 4 + 1; // filter byte + RGBA
  const raw = Buffer.alloc(stride * SIZE);
  const n = SAMPLES * SAMPLES;
  for (let py = 0; py < SIZE; py++) {
    raw[py * stride] = 0; // filter: none
    for (let px = 0; px < SIZE; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = sample(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          covered++;
        }
      }
      const o = py * stride + 1 + px * 4;
      if (covered > 0) {
        raw[o] = Math.round(r / covered);
        raw[o + 1] = Math.round(g / covered);
        raw[o + 2] = Math.round(b / covered);
        raw[o + 3] = Math.round((255 * covered) / n);
      }
    }
  }
  return raw;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function png(raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = process.argv[2];
if (!out || process.argv.length !== 3) {
  console.error('usage: node scripts/make-icon.mjs <out.png>');
  process.exitCode = 2;
} else {
  writeFileSync(out, png(render()));
}
