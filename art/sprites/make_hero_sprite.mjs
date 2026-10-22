#!/usr/bin/env node
/**
 * make_hero_sprite.mjs
 * ------------------------------------------------------------------
 * Generates a hand-drawn 32x32 "16-bit" RPG hero sprite:
 *   - exactly 32x32 px, RGBA, transparent background
 *   - exactly 12 palette colours (no extra shades, no anti-aliasing)
 *   - nearest-neighbour preview (x12) + palette strip for viewing
 *
 * Everything is procedural: the sprite is a 32-row ASCII grid where every
 * letter maps to one palette colour. Edit the grid / palette and re-run.
 *
 * Usage:  node art/sprites/make_hero_sprite.mjs [outDir]
 * Default outDir = the user's Desktop.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ */
/* 12-colour palette (16-bit RPG / SNES-ish, limited + cohesive)       */
/* ------------------------------------------------------------------ */
const PALETTE = {
  a: '#0f0d16', //  1 outline / eyes            (near black)
  b: '#3a2a45', //  2 deep shadow / inner shade (dark violet)
  c: '#8a4a33', //  3 leather dark / hair dark  (brown)
  d: '#c17a45', //  4 leather / hair / brass    (light brown)
  e: '#a95f45', //  5 skin shadow               (terracotta)
  f: '#e8a86b', //  6 skin base
  g: '#ffd7a3', //  7 skin highlight
  h: '#22485a', //  8 tunic dark                (deep teal)
  i: '#3b8496', //  9 tunic mid                 (teal)
  j: '#74c7cf', // 10 tunic light / hem         (aqua)
  k: '#d3dce6', // 11 steel light               (blade)
  l: '#7d8b9c', // 12 steel dark / blade edge
};

const SIZE = 32;
const px = (l, mid, r) => '.'.repeat(l) + mid + '.'.repeat(r);

/* ------------------------------------------------------------------ */
/* The sprite grid. '.' = transparent, letters = PALETTE keys.         */
/* Geometry: head x11..20, torso x12..19, arms x9..10 / x21..22,       */
/* sword point-down in the right hand, feet x12..14 / x17..19.         */
/* ------------------------------------------------------------------ */
const GRID = [
  /* 00 */ px(0, '.'.repeat(32), 0),
  /* 01 */ px(0, '.'.repeat(32), 0),
  /* 02 */ px(13, 'a'.repeat(6), 13),                                   // hair crown
  /* 03 */ px(12, 'a' + 'c'.repeat(6) + 'a', 12),
  /* 04 */ px(11, 'a' + 'c'.repeat(8) + 'a', 11),
  /* 05 */ px(11, 'a' + 'c' + 'd'.repeat(6) + 'c' + 'a', 11),          // fringe
  /* 06 */ px(11, 'a' + 'c' + 'f'.repeat(6) + 'c' + 'a', 11),          // forehead
  /* 07 */ px(11, 'a' + 'c' + 'f'.repeat(6) + 'c' + 'a', 11),
  /* 08 */ px(11, 'acfaffafca', 11),                                    // eyes
  /* 09 */ px(11, 'acffefffca', 11),                                    // nose shadow
  /* 10 */ px(11, 'acfffffeca', 11),                                    // cheek shadow
  /* 11 */ px(11, 'acffeeffca', 11),                                    // mouth
  /* 12 */ px(11, 'aceffffeca', 11),                                    // jaw
  /* 13 */ px(13, 'aeffea', 13),                                        // neck
  /* 14 */ px(8, 'aiia' + 'hhhhhhhh' + 'aiia', 8),                      // shoulders
  /* 15 */ px(8, 'ahha' + 'hhhhhhhb' + 'ahha', 8),
  /* 16 */ px(8, 'ahba' + 'hhddhhbb' + 'abha', 8),                      // chest emblem
  /* 17 */ px(8, 'ahba' + 'hhddhhbb' + 'abha', 8),
  /* 18 */ px(8, 'ahha' + 'cccccccc' + 'ahha', 8),                      // belt
  /* 19 */ px(8, 'ahba' + 'ccddcccc' + 'abha', 8),                      // buckle
  /* 20 */ px(8, 'affa' + 'hhhhhhhb' + 'affa', 8),                      // fists
  /* 21 */ px(8, 'aeea' + 'hhhhhhhb' + 'aeea', 8),
  /* 22 */ px(11, 'a' + 'jjjjjjjb' + 'dddd', 8),                        // hem + cross-guard
  /* 23 */ px(11, 'a' + 'hhh' + '..' + 'hhh' + 'a' + 'kl' + 'a', 8),   // legs + blade
  /* 24 */ px(11, 'a' + 'hhh' + '..' + 'hhh' + 'a' + 'kl' + 'a', 8),
  /* 25 */ px(11, 'a' + 'hbh' + '..' + 'hbh' + 'a' + 'kl' + 'a', 8),
  /* 26 */ px(11, 'a' + 'hhh' + '..' + 'hhh' + 'a' + 'kl' + 'a', 8),
  /* 27 */ px(11, 'a' + 'ccc' + '..' + 'ccc' + 'a' + 'kl' + 'a', 8),   // boot cuff
  /* 28 */ px(11, 'a' + 'cbc' + '..' + 'cbc' + 'a' + 'kl' + 'a', 8),   // boot
  /* 29 */ px(11, 'a' + 'bbb' + '..' + 'bbb' + 'a' + 'ka' + 'a', 8),   // sole + point
  /* 30 */ px(0, '.'.repeat(32), 0),
  /* 31 */ px(0, '.'.repeat(32), 0),
];

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */
if (GRID.length !== SIZE) throw new Error(`grid rows ${GRID.length} != ${SIZE}`);
GRID.forEach((row, y) => {
  if (row.length !== SIZE) throw new Error(`row ${y} length ${row.length} != ${SIZE}`);
  for (const ch of row) {
    if (ch !== '.' && !(ch in PALETTE)) throw new Error(`row ${y}: unknown glyph "${ch}"`);
  }
});

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const RGB = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hexToRgb(v)]));

/* ------------------------------------------------------------------ */
/* PNG encoder (RGBA8, no dependencies)                                */
/* ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * 4 + 1);
    raw[o] = 0; // filter: none
    rgba.copy(raw, o + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* render sprite -> RGBA buffer                                        */
/* ------------------------------------------------------------------ */
function renderSprite() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ch = GRID[y][x];
      const o = (y * SIZE + x) * 4;
      if (ch === '.') continue; // transparent
      const [r, g, b] = RGB[ch];
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* preview: x12 nearest-neighbour on a flat backdrop + palette strip   */
/* ------------------------------------------------------------------ */
function renderPreview(scale = 12) {
  const pad = 24;
  const sw = SIZE * scale;          // 384
  const stripH = 36;
  const W = sw + pad * 2;
  const H = sw + pad * 2 + stripH;
  const out = Buffer.alloc(W * H * 4);

  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    out[o + 3] = 255;
  };

  // backdrop: subtle checker so the sprite silhouette is readable
  const bgA = [26, 28, 36];
  const bgB = [34, 37, 47];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cell = ((x >> 4) + (y >> 4)) & 1;
      put(x, y, cell ? bgA : bgB);
    }
  }

  // sprite, nearest neighbour
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ch = GRID[y][x];
      if (ch === '.') continue;
      const rgb = RGB[ch];
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          put(pad + x * scale + dx, pad + y * scale + dy, rgb);
        }
      }
    }
  }

  // 1px frame around the sprite area
  const frame = [70, 76, 92];
  for (let x = pad - 1; x <= pad + sw; x++) {
    put(x, pad - 1, frame);
    put(x, pad + sw, frame);
  }
  for (let y = pad - 1; y <= pad + sw; y++) {
    put(pad - 1, y, frame);
    put(pad + sw, y, frame);
  }

  // palette strip: 12 swatches
  const keys = Object.keys(PALETTE);
  const swW = Math.floor(sw / keys.length);
  const stripY = pad + sw + 20;
  keys.forEach((k, i) => {
    const x0 = pad + i * swW;
    for (let y = 0; y < stripH; y++) {
      for (let x = 0; x < swW - 1; x++) put(x0 + x, stripY + y, RGB[k]);
    }
  });

  return { buf: out, W, H };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
const outDir = process.argv[2] || path.join(os.homedir(), 'Desktop');
fs.mkdirSync(outDir, { recursive: true });

const spritePath = path.join(outDir, 'rpg_hero_32x32.png');
fs.writeFileSync(spritePath, encodePng(SIZE, SIZE, renderSprite()));

const { buf: prev, W, H } = renderPreview(12);
const previewPath = path.join(outDir, 'rpg_hero_32x32_preview_x12.png');
fs.writeFileSync(previewPath, encodePng(W, H, prev));

// palette reference file (handy for the game's assets)
const paletteTxt = Object.entries(PALETTE)
  .map(([k, v], i) => `${String(i + 1).padStart(2, ' ')}  ${k}  ${v.toUpperCase()}`)
  .join('\n');
fs.writeFileSync(
  path.join(outDir, 'rpg_hero_palette.txt'),
  `32x32 RPG hero - 12 colours\n${paletteTxt}\n`
);

// console summary + ascii sanity dump
const used = new Set(GRID.join('').replace(/\./g, '').split(''));
console.log(JSON.stringify({
  sprite: spritePath,
  preview: previewPath,
  paletteFile: path.join(outDir, 'rpg_hero_palette.txt'),
  size: `${SIZE}x${SIZE}`,
  paletteSize: Object.keys(PALETTE).length,
  colorsUsed: used.size,
  spec: [...used].sort().join(''),
}, null, 2));
console.log(GRID.join('\n'));
