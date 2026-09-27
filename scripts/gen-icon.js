// scripts/gen-icon.js — 纯 Node 生成应用图标（PNG 256 + ICO），零图像库依赖
// 画一个深色圆角方块 + 指南针环 + 双色指针（蓝/绿 = TechCompass 的两个徽章色）
import fs from 'node:fs';
import { drawMark, svg } from './compass-mark.js';
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

const px = drawMark(SIZE);


// ---------- 输出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const png = encodePng(Buffer.from(px.buffer), SIZE, SIZE);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
fs.writeFileSync(path.join(OUT_DIR, 'trayTemplate.png'), encodePng(drawMark(32, true), 32, 32));
fs.writeFileSync(path.join(__dirname, '..', 'ui', 'brand.svg'), svg);
fs.writeFileSync(path.join(__dirname, '..', 'ui', 'brand.png'), png);
// Export the same procedural mark at a macOS packaging-compatible resolution.
const macSize = SIZE * 4;
const macPixels = drawMark(macSize);
fs.writeFileSync(path.join(OUT_DIR, 'icon-mac.png'), encodePng(macPixels, macSize, macSize));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(Buffer.from(px.buffer), SIZE));
console.log(`✓ ${path.join(OUT_DIR, 'icon.png')} (${png.length} bytes)`);
console.log(`✓ ${path.join(OUT_DIR, 'icon.ico')} (${fs.statSync(path.join(OUT_DIR, 'icon.ico')).size} bytes)`);
