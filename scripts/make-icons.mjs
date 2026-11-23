// Generates Blomp's PWA icons and favicon (the Ring logo on an indigo tile) with no image dependencies.
// Geometry matches src/components/logo.tsx: a 96 x 96 box, a 275 degree ring with round caps, and a dot in the gap.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const A = [124, 116, 255]; // --logo-a
const B = [67, 56, 202]; // --logo-b
const INK = [255, 255, 255];

const C = 48;
const R = 22;
const HALF = 4.5; // half the 9 unit stroke
const pt = (deg, r = R) => [C + r * Math.sin((deg * Math.PI) / 180), C - r * Math.cos((deg * Math.PI) / 180)];
const CAP0 = pt(72);
const CAP1 = pt(346);
const DOT = pt(29);

function crc32(buf) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Coverage of the white mark at a point in 96-unit space, 0 or 1. */
function inMark(x, y, k) {
  // k scales the mark about the centre (smaller for the maskable safe zone)
  const ux = C + (x - C) / k;
  const uy = C + (y - C) / k;
  if (Math.hypot(ux - DOT[0], uy - DOT[1]) <= 5.6) return true;
  const d = Math.hypot(ux - C, uy - C);
  if (Math.abs(d - R) <= HALF) {
    let deg = (Math.atan2(ux - C, -(uy - C)) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (deg >= 72 && deg <= 346) return true;
  }
  return Math.hypot(ux - CAP0[0], uy - CAP0[1]) <= HALF || Math.hypot(ux - CAP1[0], uy - CAP1[1]) <= HALF;
}

/** Rounded-square test for the tile; `rounded` false fills the whole canvas (maskable and Apple icons). */
function inTile(x, y, rounded) {
  if (!rounded) return true;
  const r = 26;
  const cx = Math.min(Math.max(x, r), 96 - r);
  const cy = Math.min(Math.max(y, r), 96 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function png(size, { rounded, k }) {
  const SS = 3; // 3 x 3 supersampling for smooth edges
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let py = 0; py < size; py++) {
    raw[py * stride] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 96;
          const y = ((py + (sy + 0.5) / SS) / size) * 96;
          if (!inTile(x, y, rounded)) continue;
          const t = (x + y) / 192; // diagonal gradient, top-left to bottom-right
          let col = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
          if (inMark(x, y, k)) col = INK;
          r += col[0]; g += col[1]; b += col[2]; a += 1;
        }
      }
      const o = py * stride + 1 + px * 4;
      const n = SS * SS;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A .ico file that holds one PNG. */
function ico(pngBytes, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = size;
  head[7] = size;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(pngBytes.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, pngBytes]);
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", png(192, { rounded: true, k: 1 }));
writeFileSync("public/icons/icon-512.png", png(512, { rounded: true, k: 1 }));
writeFileSync("public/icons/icon-maskable-512.png", png(512, { rounded: false, k: 0.8 })); // mark kept inside the safe zone
writeFileSync("public/icons/apple-touch-icon.png", png(180, { rounded: false, k: 1 })); // iOS rounds the corners itself
writeFileSync("src/app/favicon.ico", ico(png(48, { rounded: true, k: 1 }), 48));
console.log("icons written");
