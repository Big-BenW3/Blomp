// Generates Blomp's PWA icons (a gauge ring on a dark tile) with no image dependencies.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [11, 15, 20];
const RING = [34, 197, 94];
const DIM = [31, 42, 55];

function crc32(buf) {
  let c;
  const table = Array.from({ length: 256 }, (_, n) => {
    c = n;
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

function png(size, scale) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const c = size / 2;
  const rOuter = size * 0.36 * scale;
  const rInner = size * 0.25 * scale;
  const needleLen = size * 0.2 * scale;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const r = Math.hypot(dx, dy);
      // angle 0 = right, increasing clockwise; the gauge sweeps 135deg to 405deg (gap at the bottom)
      let a = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (a < 0) a += 360;
      const inSweep = a >= 135 || a <= 45;
      const sweepPos = a >= 135 ? a - 135 : a + 225; // 0..270
      let px = BG;
      if (r >= rInner && r <= rOuter && inSweep) px = sweepPos <= 200 ? RING : DIM;
      // needle pointing up-right
      const na = (-35 * Math.PI) / 180;
      const t = dx * Math.cos(na) + dy * Math.sin(na);
      const d = Math.abs(-dx * Math.sin(na) + dy * Math.cos(na));
      if (t >= 0 && t <= needleLen && d <= size * 0.018 * scale) px = [230, 237, 243];
      if (r <= size * 0.04 * scale) px = [230, 237, 243];
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", png(192, 1));
writeFileSync("public/icons/icon-512.png", png(512, 1));
writeFileSync("public/icons/icon-maskable-512.png", png(512, 0.8)); // content kept inside the safe zone
writeFileSync("public/icons/apple-touch-icon.png", png(180, 1));
console.log("icons written");
