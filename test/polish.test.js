import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jobs } from '../lib/jobs.js';
import { Store } from '../lib/store.js';
import { Pipeline } from '../lib/pipeline.js';
import { runProcess } from '../lib/agentbridge.js';
import { runProvider } from '../lib/provider.js';
import { newGame, step } from '../ui/snake.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
test('cancelled jobs abort work and cannot become done', async () => {
  const jobs = new Jobs(); let stopped = false;
  const id = jobs.create(async (_, signal) => { signal.addEventListener('abort', () => { stopped = true; }); await sleep(25); return 'late'; });
  await sleep(5); jobs.cancel(id); await sleep(40);
  assert.equal(stopped, true); assert.equal(jobs.get(id).status, 'cancelled'); assert.equal(jobs.get(id).result, null);
});
test('CLI process cancellation terminates the spawned command', async () => {
  const ctrl = new AbortController();
  const promise = runProcess(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(new Error('test stop')), 100);
  await assert.rejects(promise, /test stop/);
});
test('API cancellation reaches fetch without masking reason', async () => {
  const ctrl = new AbortController();
  const promise = runProvider({ provider: { baseUrl: 'https://example.com/v1', model: 'test' }, key: 'fake-test-key', prompt: 'OK', signal: ctrl.signal, fetchImpl: async (_, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))) });
  ctrl.abort(new Error('test cancel'));
  await assert.rejects(promise, /test cancel/);
});
test('cancel during analysis does not persist a result or cache it', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cancel-')));
  const pipeline = new Pipeline({ store });
  const ctrl = new AbortController();
  const promise = pipeline.analyze({ type: 'text', value: 'Bun' }, { agentId: 'mock', signal: ctrl.signal });
  setTimeout(() => ctrl.abort(new Error('cancel analysis')), 50);
  await assert.rejects(promise, /cancel analysis/);
  assert.equal(store.listAnalyses().length, 0); assert.equal(pipeline.cache.size, 0);
});
test('later list survives restart, deduplicates and detects changed context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-later-'));
  const store = new Store(dir);
  await store.upsertProject({ id: 'p', path: '/test' });
  await store.saveContext({ projectId: 'p', name: 'Test' });
  await store.appendAnalysis({ id: 'a', contextsSnapshot: [{ projectId: 'p', name: 'Test', version: 1 }], result: { terms: [{ term: 'Bun' }], projects: [{ projectId: 'p', futureTrigger: '当启动速度成为瓶颈时' }] } });
  await store.saveDeferred('a', 'p'); await store.saveDeferred('a', 'p');
  assert.equal(new Store(dir).listDeferred().length, 1);
  // Simulate a legacy MCP writer that only knows projects/contexts/settings.
  const legacy = store.readData(); delete legacy.deferred;
  fs.writeFileSync(store.dataPath, JSON.stringify(legacy));
  assert.equal(new Store(dir).listDeferred().length, 1);
  assert.equal(store.listDeferred()[0].needsReview, false);
  await store.saveContext({ projectId: 'p', name: 'Test', focus: 'New focus' });
  assert.equal(store.listDeferred()[0].needsReview, true);
  await store.removeProject('p'); assert.equal(store.listDeferred()[0].projectMissing, true);
  await store.removeDeferred('a:p'); assert.deepEqual(store.listDeferred(), []);
});
test('snake moves, eats, and stops at walls', () => {
  const g = newGame(); step(g); assert.equal(g.body[0].x, 6);
  for (let i = 0; i < 6; i++) step(g, () => 0);
  assert.equal(g.score, 1); assert.equal(g.body.length, 4);
  for (let i = 0; i < 20; i++) step(g);
  assert.equal(g.over, true);
});
