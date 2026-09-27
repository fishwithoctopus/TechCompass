// test/normalizer.test.js — 归一化（离线部分；网络路径在 E2E 中覆盖）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeInput, isLink, htmlToText } from '../lib/normalizer.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-norm-'));

test('isLink 识别', () => {
  assert.ok(isLink('https://github.com/a/b'));
  assert.ok(!isLink('bun 是什么'));
});

test('文本归一化并截断', async () => {
  const r = await normalizeInput({ type: 'text', value: 'Bun '.repeat(1000) }, { tmpDir: tmp });
  assert.equal(r.type, 'text');
  assert.equal(r.text.length, 2000);
});

test('截图 dataURL 保存为文件', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await normalizeInput({ type: 'image', value: png }, { tmpDir: tmp });
  assert.equal(r.type, 'image');
  assert.ok(fs.existsSync(r.meta.path));
  assert.ok(r.ref.startsWith('image:'));
});

test('不支持的图片格式报错', async () => {
  await assert.rejects(() => normalizeInput({ type: 'image', value: 'data:image/bmp;base64,AAAA' }, { tmpDir: tmp }));
});

test('htmlToText 抽取正文', () => {
  const html = '<html><head><style>x{}</style><script>bad()</script><title>T</title></head><body><h1>Bun 1.0</h1><p>JavaScript 运行时 &amp; 工具链</p></body></html>';
  const text = htmlToText(html);
  assert.ok(text.includes('Bun 1.0'));
  assert.ok(text.includes('JavaScript 运行时 & 工具链'));
  assert.ok(!text.includes('bad()'));
});
