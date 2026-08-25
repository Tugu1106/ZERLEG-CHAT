/**
 * Generates the app/tray icons as real PNG files so the repo carries no opaque
 * binary blobs. Run with `node scripts/make-icons.mjs` after changing the design.
 *
 * Draws the ZERLEG bolt on a rounded-square badge, anti-aliased by
 * supersampling, then encodes it as an 8-bit RGBA PNG by hand via zlib.
 */
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- rendering

/** Signed distance to a rounded rectangle; negative inside. */
function roundedRect(px, py, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(px - cx) - (halfW - r);
  const dy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * The ZERLEG bolt, as a closed polygon in unit coordinates. A lightning mark
 * stays legible at 16px in a crowded tray, where an exclamation reads as a
 * generic system warning.
 */
const BOLT = [
  [0.575, 0.14],
  [0.28, 0.565],
  [0.455, 0.565],
  [0.415, 0.86],
  [0.715, 0.425],
  [0.53, 0.425],
];

/** Even-odd point-in-polygon test. */
function insidePolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Colour at a point in the unit square, as [r, g, b, alpha]. */
function sample(px, py, palette) {
  /*
   * macOS menu-bar icons are "template" images: the bare glyph in black plus
   * alpha, which the system re-colours for the light or dark menu bar. A badge
   * would look wrong up there, so template variants skip it entirely.
   */
  if (palette.template) {
    return insidePolygon(px, py, BOLT) ? [0, 0, 0, palette.alpha] : [0, 0, 0, 0];
  }

  const badge = roundedRect(px, py, 0.5, 0.5, 0.48, 0.48, 0.22);
  if (badge > 0) return [0, 0, 0, 0];

  if (insidePolygon(px, py, BOLT)) return [...palette.glyph, 1];

  const t = (py - 0.02) / 0.96;
  return [
    lerp(palette.top[0], palette.bottom[0], t),
    lerp(palette.top[1], palette.bottom[1], t),
    lerp(palette.top[2], palette.bottom[2], t),
    1,
  ];
}

function render(size, palette) {
  const SS = 4; // supersample factor per axis
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          const c = sample(px, py, palette);
          // Accumulate premultiplied so edge pixels do not pick up stray colour.
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (y * size + x) * 4;
      if (alpha > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------- output

const ALERT = { top: [251, 113, 133], bottom: [159, 18, 57], glyph: [255, 255, 255] };
const MUTED = { top: [148, 163, 184], bottom: [51, 65, 85], glyph: [226, 232, 240] };
/** Shown in the tray while an urgent alert is still unacknowledged. */
const ATTENTION = { top: [255, 224, 130], bottom: [217, 119, 6], glyph: [69, 10, 10] };

/* macOS menu bar: bare glyph, black + alpha, at 1x and 2x. */
const MAC_ON = { template: true, alpha: 1 };
const MAC_OFF = { template: true, alpha: 0.38 };

const targets = [
  ['desktop/resources/icon.png', 256, ALERT],
  ['desktop/resources/tray.png', 32, ALERT],
  ['desktop/resources/tray-offline.png', 32, MUTED],
  ['desktop/resources/tray-alert.png', 32, ATTENTION],

  ['desktop/resources/trayTemplate.png', 16, MAC_ON],
  ['desktop/resources/trayTemplate@2x.png', 32, MAC_ON],
  ['desktop/resources/trayOfflineTemplate.png', 16, MAC_OFF],
  ['desktop/resources/trayOfflineTemplate@2x.png', 32, MAC_OFF],
];

for (const [relPath, size, palette] of targets) {
  const file = resolve(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng(size, render(size, palette)));
  console.log(`wrote ${relPath} (${size}x${size})`);
}
