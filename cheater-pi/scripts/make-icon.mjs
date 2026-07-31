// Generates the Kitten app icon from the mascot's pixel-art data (src/ui/catPixels.ts).
// Zero dependencies: PNG encoding is raw zlib deflate + CRC32, ICO packing is a hand-written
// directory over PNG-compressed entries (supported since Vista).
//
// Usage:  node cheater-pi/scripts/make-icon.mjs        (requires `npm run build` first)
// Output: assets/icon/kitten.ico, kitten.svg, kitten-256.png  (committed; builds never run this)
//
// The icon derives from CAT_BASE + the idle face, so it can never drift from the in-app mascot.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const outDir = join(repoRoot, "assets", "icon");

const { composeCat, PALETTE } = await import(
  new URL("../dist/src/ui/catPixels.js", import.meta.url).href
);

const GRID = composeCat("ready"); // idle face
const GRID_W = 30;
const GRID_H = 24;

// The plate behind the cat: the cat is near-black charcoal, so without a backing it vanishes on
// light taskbars/desktops. A dark rounded plate keeps the pink ears + green eyes readable anywhere.
const PLATE = [19, 19, 23];

// ---------------------------------------------------------------------------- rendering

/** RGBA of one grid cell, or null for transparent. */
function cellRgba(col, row) {
  if (col < 0 || row < 0 || col >= GRID_W || row >= GRID_H) return null;
  const rgb = PALETTE[GRID[row][col]];
  return rgb ? [rgb[0], rgb[1], rgb[2], 255] : null;
}

/** Render the icon at `size`x`size`: analytic rounded plate + the cat sampled into the center. */
function renderIcon(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const margin = Math.round(size * 0.03);
  const radius = Math.max(2, Math.round(size * 0.19));
  const lo = margin;
  const hi = size - 1 - margin;

  const insidePlate = (x, y) => {
    if (x < lo || x > hi || y < lo || y > hi) return false;
    const cx = x < lo + radius ? lo + radius : x > hi - radius ? hi - radius : x;
    const cy = y < lo + radius ? lo + radius : y > hi - radius ? hi - radius : y;
    if (cx === x || cy === y) return true;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  // Cat placement: centered in the 32-logical frame, scaled with the icon.
  const s = size / 32;
  const ox = (size - GRID_W * s) / 2;
  const oy = (size - GRID_H * s) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rgba = null;
      if (s >= 1) {
        // Nearest-neighbor: crisp pixel art at 32 and every upscale.
        rgba = cellRgba(Math.floor((x - ox) / s), Math.floor((y - oy) / s));
      } else {
        // Box-average downscale (16/24): average covered cells so features stay legible.
        const c0 = (x - ox) / s;
        const r0 = (y - oy) / s;
        let rs = 0, gs = 0, bs = 0, as = 0, n = 0;
        for (let r = Math.floor(r0); r < r0 + 1 / s; r++) {
          for (let c = Math.floor(c0); c < c0 + 1 / s; c++) {
            const v = cellRgba(c, r);
            n++;
            if (v) { rs += v[0]; gs += v[1]; bs += v[2]; as += 255; }
          }
        }
        if (n > 0 && as / n > 96) rgba = [rs / n, gs / n, bs / n, 255];
      }
      if (!rgba && insidePlate(x, y)) rgba = [PLATE[0], PLATE[1], PLATE[2], 255];
      if (rgba) {
        const i = (y * size + x) * 4;
        px[i] = rgba[0]; px[i + 1] = rgba[1]; px[i + 2] = rgba[2]; px[i + 3] = rgba[3];
      }
    }
  }
  return px;
}

// ---------------------------------------------------------------------------- PNG

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------- ICO

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir[o] = size === 256 ? 0 : size;
    dir[o + 1] = size === 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4);  // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ---------------------------------------------------------------------------- SVG (derived, for docs)

function makeSvg() {
  const rects = [];
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const rgb = PALETTE[GRID[r][c]];
      if (!rgb) continue;
      rects.push(`<rect x="${c + 1}" y="${r + 4}" width="1" height="1" fill="rgb(${rgb[0]},${rgb[1]},${rgb[2]})"/>`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">`,
    `<rect x="1" y="1" width="30" height="30" rx="6" fill="rgb(${PLATE[0]},${PLATE[1]},${PLATE[2]})"/>`,
    ...rects,
    `</svg>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------- main

const SIZES = [16, 24, 32, 48, 64, 128, 256];
mkdirSync(outDir, { recursive: true });
const entries = SIZES.map((size) => ({ size, png: encodePng(renderIcon(size), size) }));
writeFileSync(join(outDir, "kitten.ico"), encodeIco(entries));
writeFileSync(join(outDir, "kitten-256.png"), entries.find((e) => e.size === 256).png);
writeFileSync(join(outDir, "kitten.svg"), makeSvg());
console.log(`wrote ${join(outDir, "kitten.ico")} (${SIZES.join("/")}) + kitten-256.png + kitten.svg`);
