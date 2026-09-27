// test/pipeline.test.js — 分析管线全链路（mock 引擎）：归一化→分析→校验→落库→缓存→反馈
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.js';
import { Pipeline } from '../lib/pipeline.js';

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pipe-'));
  const store = new Store(dir);
  const pipeline = new Pipeline({ store });
  const analyze = pipeline.analyze.bind(pipeline);
  const enhance = pipeline.enhance.bind(pipeline);
  pipeline.analyze = (input, options = {}) => analyze(input, { agentId: 'mock', ...options });
  pipeline.enhance = (input, options = {}) => enhance(input, { agentId: 'mock', ...options });
  return { store, pipeline };
}

const CTX_A = {
  projectId: 'pj_a', name: '博客', goal: '个人技术博客', stage: 'mvp',
  stack: ['Next.js', 'React', 'Tailwind CSS'], keyDeps: [{ name: 'next', why: '框架' }],
  focus: '加评论系统', constraints: ['单人维护'], version: 1,
};
const CTX_B = {
  projectId: 'pj_b', name: '桌面工具', goal: '一个 Electron 桌面效率工具', stage: 'prototype',
  stack: ['Electron', 'TypeScript'], keyDeps: [{ name: 'electron', why: '桌面壳' }],
  focus: '', constraints: [], version: 1,
};

async function seed(store) {
  await store.upsertProject({ id: 'pj_a', path: '/a', createdAt: 'now' });
  await store.upsertProject({ id: 'pj_b', path: '/b', createdAt: 'now' });
  await store.saveContext(CTX_A);
  await store.saveContext(CTX_B);
}

test('mock 全链路：分析 → 落库 → 结果覆盖全部项目', async () => {
  const { store, pipeline } = boot();
  await seed(store);
  const r = await pipeline.analyze({ type: 'text', value: 'Tauri 值得用吗' });
  assert.equal(r.cached, false);
  assert.ok(r.analysisId.startsWith('an_'));
  const ids = r.result.projects.map((p) => p.projectId).sort();
  assert.deepEqual(ids, ['pj_a', 'pj_b']);
  // 桌面工具项目（Electron 栈）应与 Tauri 相关性更高
  const desk = r.result.projects.find((p) => p.projectId === 'pj_b');
  assert.equal(desk.relevance, 'high');
  assert.equal(desk.verdict, 'try_now');
  assert.ok(desk.tryAction);
  assert.ok(desk.reasoning.includes('桌面工具'));
  // 落库
  const row = store.getAnalysis(r.analysisId);
  assert.ok(row);
  assert.equal(row.agentUsed, 'mock');
  assert.equal(row.contextsSnapshot.length, 2);
});

test('24h 缓存命中', async () => {
  const { store, pipeline } = boot();
  await seed(store);
  const r1 = await pipeline.analyze({ type: 'text', value: 'Deno 2.0 发布了' });
  const r2 = await pipeline.analyze({ type: 'text', value: 'Deno 2.0 发布了' });
  assert.equal(r2.cached, true);
  assert.equal(r2.analysisId, r1.analysisId);
  const r3 = await pipeline.analyze({ type: 'text', value: 'Deno 2.0 发布了' }, { noCache: true });
  assert.equal(r3.cached, false);
});

test('上下文变化后缓存失效', async () => {
  const { store, pipeline } = boot();
  await seed(store);
  await pipeline.analyze({ type: 'text', value: 'Vite 6' });
  await store.saveContext({ ...CTX_A, focus: '换构建工具' }); // version+1
  const r = await pipeline.analyze({ type: 'text', value: 'Vite 6' });
  assert.equal(r.cached, false);
});

test('enhance：从扫描提取上下文草稿', async () => {
  const { store, pipeline } = boot();
  const scan = {
    dir: '/x/sample-blog', name: 'sample-blog',
    pkgJson: { name: 'sample-blog', description: '个人技术博客', deps: ['next', 'react'], scripts: ['dev'] },
    manifests: [], files: {}, stackHints: ['Next.js', 'React'],
    readmeExcerpt: '# sample-blog\n我的个人技术博客', tree: 'src/', gitLog: null, scannedAt: 'now',
  };
  const { draft, agentUsed } = await pipeline.enhance(scan);
  assert.equal(agentUsed, 'mock');
  assert.equal(draft.name, 'sample-blog');
  assert.ok(draft.goal.includes('博客'));
  assert.ok(draft.stack.includes('Next.js'));
});

test('无项目时正常解释名词，不把缺少项目当成问题', async () => {
  const { pipeline } = boot();
  const r = await pipeline.analyze({ type: 'text', value: 'MCP 是什么' });
  assert.deepEqual(r.result.projects, []);
  assert.ok(r.result.terms[0].what.length > 0);
  assert.deepEqual(r.result.missing, []);
});
