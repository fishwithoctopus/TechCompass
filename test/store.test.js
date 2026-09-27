// test/store.test.js — 存储层：原子写、jsonl 追加、锁
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, newId, defaultDataDir } from '../lib/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-'));
  return new Store(dir);
}

test('data.json 读写与项目 CRUD', async () => {
  const s = tmpStore();
  await s.upsertProject({ id: 'pj_1', path: '/x/y', createdAt: 'now' });
  await s.saveContext({ projectId: 'pj_1', name: 'demo', goal: 'g', stage: 'mvp', stack: [], keyDeps: [], focus: '', constraints: [] });
  assert.equal(s.getProjects().length, 1);
  assert.equal(s.getContexts()[0].version, 1);
  await s.saveContext({ projectId: 'pj_1', name: 'demo2', goal: 'g', stage: 'mvp', stack: [], keyDeps: [], focus: '', constraints: [] });
  assert.equal(s.getContexts()[0].version, 2);
  await s.removeProject('pj_1');
  assert.equal(s.getProjects().length, 0);
  assert.equal(s.getContexts().length, 0);
});

test('analyses 追加与读取（倒序）', async () => {
  const s = tmpStore();
  await s.appendAnalysis({ id: 'an_1', result: { terms: [] } });
  await s.appendAnalysis({ id: 'an_2', result: { terms: [] } });
  const list = s.listAnalyses(10);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'an_2'); // 最新在前
  assert.equal(s.getAnalysis('an_1').id, 'an_1');
});

test('feedback 过滤', async () => {
  const s = tmpStore();
  await s.addFeedback({ analysisId: 'an_1', projectId: 'pj_1', accuracy: 'match', intent: 'try' });
  await s.addFeedback({ analysisId: 'an_1', projectId: 'pj_2', accuracy: 'partial', intent: 'pass' });
  assert.equal(s.listFeedback('an_1').length, 2);
  assert.equal(s.listFeedback().length, 2);
});

test('锁：并发写入不丢数据', async () => {
  const s = tmpStore();
  const tasks = [];
  for (let i = 0; i < 20; i++) {
    tasks.push(s.mutateData((d) => { d.projects = d.projects || []; d.projects.push({ id: `p${i}` }); }));
  }
  await Promise.all(tasks);
  assert.equal(s.getProjects().length, 20);
});

test('token 生成且稳定', () => {
  const s = tmpStore();
  const t1 = s.token();
  const t2 = s.token();
  assert.equal(t1, t2);
  assert.ok(t1.length >= 24);
});

test('newId 前缀', () => {
  assert.ok(newId('pj').startsWith('pj_'));
});

test('defaultDataDir 支持 TECHCOMPASS_HOME', () => {
  assert.equal(defaultDataDir({ TECHCOMPASS_HOME: '/tmp/x' }), '/tmp/x');
});
