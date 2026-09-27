// scripts/gen-icon.js — 纯 Node 生成应用图标（PNG 256 + ICO），零图像库依赖
// 画一个深色圆角方块 + 指南针环 + 双色指针（蓝/绿 = TechCompass 的两个徽章色）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZE = 256;

// ---------- PNG 编码 ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO：标准 BMP 多尺寸（16/32/48/64/256），兼容 electron-builder ----------
function scaleRgba(src, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      // box 采样
      const sx0 = Math.floor((x * srcW) / dstW), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      const sy0 = Math.floor((y * srcH) / dstH), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * srcH) / dstH));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < srcH; sy++) {
        for (let sx = sx0; sx < sx1 && sx < srcW; sx++) {
          const i = (sy * srcW + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (y * dstW + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function bmpEntry(rgba, w, h) {
  const rowMask = Math.ceil(w / 32) * 4; // AND mask 行宽（4 字节对齐）
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);       // biSize
  header.writeInt32LE(w, 4);         // biWidth
  header.writeInt32LE(h * 2, 8);     // biHeight = XOR + AND
  header.writeUInt16LE(1, 12);       // biPlanes
  header.writeUInt16LE(32, 14);      // biBitCount
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // 自底向上
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 4, d = (y * w + x) * 4;
      pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3]; // BGRA
    }
  }
  const mask = Buffer.alloc(rowMask * h); // 全 0（有 alpha）
  return Buffer.concat([header, pixels, mask]);
}

function encodeIco(rgba, size) {
  const sizes = [16, 32, 48, 64, 256];
  const entries = [];
  let offset = 6 + 16 * sizes.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
  const entryDirs = [];
  for (const s of sizes) {
    const scaled = s === size ? rgba : scaleRgba(rgba, size, size, s, s);
    const bmp = bmpEntry(scaled, s, s);
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(bmp.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += bmp.length;
    entryDirs.push(e);
    entries.push(bmp);
  }
  return Buffer.concat([dir, ...entryDirs, ...entries]);
}

// ---------- 绘制 ----------
const px = new Uint8ClampedArray(SIZE * SIZE * 4);
const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const na = a / 255;
  px[i] = Math.round(r * na + px[i] * (1 - na));
  px[i + 1] = Math.round(g * na + px[i + 1] * (1 - na));
  px[i + 2] = Math.round(b * na + px[i + 2] * (1 - na));
  px[i + 3] = Math.min(255, px[i + 3] + a);
};

const C = SIZE / 2;
// 圆角方块背景
const R = 56; // 圆角
const PAD = 8;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const inBox = x >= PAD && y >= PAD && x < SIZE - PAD && y < SIZE - PAD;
    if (!inBox) continue;
    // 圆角距离
    const cx = Math.min(Math.max(x, PAD + R), SIZE - PAD - R);
    const cy = Math.min(Math.max(y, PAD + R), SIZE - PAD - R);
    const d = Math.hypot(x - cx, y - cy);
    if (d <= R) set(x, y, 21, 23, 28, 255);
    else {
      // 圆角边缘 2px 抗锯齿描边
      if (d <= R + 2.5) set(x, y, 92, 179, 255, 200);
    }
  }
}
// 外描边整体（把圆角方块边缘再补一圈）
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.min(Math.max(x, PAD + R), SIZE - PAD - R);
    const cy = Math.min(Math.max(y, PAD + R), SIZE - PAD - R);
    const d = Math.hypot(x - cx, y - cy);
    if (d > R && d <= R + 2) {
      const inOuter = x >= PAD - 2 && y >= PAD - 2 && x < SIZE - PAD + 2 && y < SIZE - PAD + 2;
      if (inOuter) set(x, y, 92, 179, 255, 180);
    }
  }
}

// 指南针环
const RING = 74, RING_W = 10;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - C, y - C);
    if (Math.abs(d - RING) < RING_W / 2) {
      const a = Math.round(255 * Math.min(1, (RING_W / 2 - Math.abs(d - RING)) * 1.4));
      set(x, y, 232, 234, 240, a);
    }
  }
}
// 四个方位刻度
for (let k = 0; k < 4; k++) {
  const ang = (k * Math.PI) / 2;
  const nx = Math.cos(ang), ny = Math.sin(ang);
  for (let t = -6; t <= 6; t++) {
    for (let w = -4; w <= 4; w++) {
      const x = Math.round(C + nx * (RING + 16) + -ny * t);
      const y = Math.round(C + ny * (RING + 16) + nx * t);
      if (Math.abs(t) + Math.abs(w) * 1.4 <= 8) set(x, y, 152, 160, 173, 255);
    }
  }
}
// 指针：蓝（东北→中心）绿（中心→西南）
const N1 = { x: C + 46, y: C - 46 };
const N2 = { x: C - 46, y: C + 46 };
function fillTri(p1, p2, p3, color) {
  const minX = Math.floor(Math.min(p1.x, p2.x, p3.x)), maxX = Math.ceil(Math.max(p1.x, p2.x, p3.x));
  const minY = Math.floor(Math.min(p1.y, p2.y, p3.y)), maxY = Math.ceil(Math.max(p1.y, p2.y, p3.y));
  const sign = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d1 = sign({ x: x + 0.5, y: y + 0.5 }, p1, p2), d2 = sign({ x: x + 0.5, y: y + 0.5 }, p2, p3), d3 = sign({ x: x + 0.5, y: y + 0.5 }, p3, p1);
      const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) set(x, y, color[0], color[1], color[2], 255);
    }
  }
}
const BASE = 17;
fillTri(N1, { x: C - BASE * 0.6, y: C + BASE }, { x: C + BASE, y: C - BASE * 0.6 }, [92, 179, 255]);   // 蓝
fillTri(N2, { x: C - BASE, y: C + BASE * 0.6 }, { x: C + BASE * 0.6, y: C - BASE }, [110, 231, 160]);  // 绿
// 中心圆点
for (let y = -12; y <= 12; y++) {
  for (let x = -12; x <= 12; x++) {
    const d = Math.hypot(x, y);
    if (d <= 11) set(C + x, C + y, 232, 234, 240, 255);
    else if (d <= 13) set(C + x, C + y, 21, 23, 28, 200);
  }
}

// ---------- 输出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const png = encodePng(Buffer.from(px.buffer), SIZE, SIZE);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
fs.writeFileSync(path.join(__dirname, '..', 'ui', 'brand.png'), png);
// Export the same procedural mark at a macOS packaging-compatible resolution.
const macSize = SIZE * 4;
const macPixels = Buffer.alloc(macSize * macSize * 4);
const sourcePixels = Buffer.from(px.buffer);
for (let y = 0; y < macSize; y++) {
  for (let x = 0; x < macSize; x++) {
    const from = (Math.floor(y / 4) * SIZE + Math.floor(x / 4)) * 4;
    sourcePixels.copy(macPixels, (y * macSize + x) * 4, from, from + 4);
  }
}
fs.writeFileSync(path.join(OUT_DIR, 'icon-mac.png'), encodePng(macPixels, macSize, macSize));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(Buffer.from(px.buffer), SIZE));
console.log(`✓ ${path.join(OUT_DIR, 'icon.png')} (${png.length} bytes)`);
console.log(`✓ ${path.join(OUT_DIR, 'icon.ico')} (${fs.statSync(path.join(OUT_DIR, 'icon.ico')).size} bytes)`);
