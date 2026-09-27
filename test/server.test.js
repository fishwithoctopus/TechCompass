// test/server.test.js — HTTP 服务端到端（mock 引擎）：扫描→保存项目→分析任务→反馈→历史
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../lib/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-blog');

async function post(base, p, body, token) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tc-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function put(base, p, body, token) {
  const res = await fetch(base + p, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-tc-token': token }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(base, p, token) {
  const res = await fetch(base + p, { headers: { 'x-tc-token': token } });
  return { status: res.status, data: await res.json() };
}

async function waitJob(base, jobId, token, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const { data } = await get(base, `/api/jobs/${jobId}`, token);
    if (data.status === 'done') return data.result;
    if (data.status === 'error') throw new Error(data.error);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('job 超时');
}

test('daemon E2E：完整用户流程', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-server-'));
  const { app, port, token, stop } = await startDaemon({ dataDir });
  const base = `http://127.0.0.1:${port}`;
  t.after(() => stop());

  // health 无需鉴权
  const h = await fetch(base + '/health').then((r) => r.json());
  assert.equal(h.ok, true);

  // 未授权被拒
  const unauthorized = await fetch(base + '/api/state');
  assert.equal(unauthorized.status, 401);

  // state
  const st = (await get(base, '/api/state', token)).data;
  assert.equal(st.projects.length, 0);

  // 1. 扫描项目
  const scan = await post(base, '/api/projects/scan', { path: FIXTURE }, token);
  assert.equal(scan.status, 200);
  assert.equal(scan.data.draft.name, 'sample-blog');
  assert.ok(scan.data.draft.stack.includes('Next.js'));

  // 2. 保存项目（带用户修正）
  const saved = await post(base, '/api/projects', {
    path: FIXTURE,
    context: { ...scan.data.draft, focus: '正在加评论系统' },
  }, token);
  assert.equal(saved.status, 200);
  const pid = saved.data.project.id;

  // 3. 分析（任务化）
  const an = await post(base, '/api/analyze', { agentId: 'mock', input: { type: 'text', value: 'Electron 有啥新东西' } }, token);
  assert.equal(an.status, 202);
  const result = await waitJob(base, an.data.jobId, token);
  assert.equal(result.result.projects.length, 1);
  assert.equal(result.result.projects[0].projectId, pid);
  assert.ok(['high', 'medium', 'low'].includes(result.result.projects[0].relevance));

  // 4. 反馈
  const fb = await post(base, '/api/feedback', {
    analysisId: result.analysisId, projectId: pid, accuracy: 'match', intent: 'later', note: '先不急',
  }, token);
  assert.equal(fb.status, 200);
  const fbRead = (await get(base, `/api/analyses/${result.analysisId}`, token)).data;
  assert.equal(fbRead.feedback.length, 1);
  assert.equal(fbRead.feedback[0].accuracy, 'match');

  // 5. 历史列表
  const hist = (await get(base, '/api/analyses', token)).data;
  assert.equal(hist.analyses.length, 1);

  // 6. 编辑项目上下文
  const upd = await put(base, `/api/projects/${pid}`, {
    context: { ...fbRead.analysis.contextsSnapshot[0], focus: '改做文章搜索' },
  }, token);
  assert.equal(upd.status, 200);
  assert.equal((await get(base, '/api/projects', token)).data.projects[0].context.focus, '改做文章搜索');

  // 7. 刷新项目（mock）
  const rf = await post(base, `/api/projects/${pid}/refresh`, { agentId: 'mock' }, token);
  assert.equal(rf.status, 202);
  const rfRes = await waitJob(base, rf.data.jobId, token);
  assert.equal(rfRes.projectId, pid);

  // 8. 设置
  const set = await put(base, '/api/settings', { preferredAgents: ['codex', 'claude'] }, token);
  assert.deepEqual(set.data.settings.preferredAgents, ['codex', 'claude']);

  // 9. 静态 UI 可访问
  const ui = await fetch(base + '/ui/');
  assert.equal(ui.status, 200);
  assert.ok((await ui.text()).includes('TechCompass'));

  // 10. 删除项目
  const del = await fetch(`${base}/api/projects/${pid}`, { method: 'DELETE', headers: { 'x-tc-token': token } });
  assert.equal(del.status, 200);
  assert.equal((await get(base, '/api/projects', token)).data.projects.length, 0);

  // 清理临时图片目录等
  fs.rmSync(dataDir, { recursive: true, force: true });
});
