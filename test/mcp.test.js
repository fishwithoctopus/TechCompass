// test/mcp.test.js — MCP server stdio 协议全链路：
// initialize → tools/list → register_project → list_projects → get_analysis_rubric → save_analysis
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function startServer(home) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.js')], {
    env: { ...process.env, TECHCOMPASS_HOME: home, TC_MCP_TEST_MODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    buf += d.toString();
    for (let i = waiters.length - 1; i >= 0; i--) {
      const { id, resolve } = waiters[i];
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) { waiters.splice(i, 1); buf = buf.slice(buf.indexOf(line) + line.length); resolve(msg); return; }
        } catch { /* 半行 */ }
      }
    }
  });
  const errors = [];
  child.stderr.on('data', (d) => errors.push(d.toString()));
  let nextId = 1;
  return {
    send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); },
    async call(method, params) {
      const id = nextId++;
      const p = new Promise((resolve) => waiters.push({ id, resolve }));
      this.send({ jsonrpc: '2.0', id, method, params });
      return Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`MCP 调用超时: ${method}\nstderr: ${errors.join('')}`)), 20000)),
      ]);
    },
    notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); },
    close() { return new Promise((r) => { child.on('close', r); child.kill(); }); },
    errors,
  };
}

test('MCP stdio 全链路', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-'));
  const mcp = startServer(home);
  t.after(() => mcp.close());

  // 1. initialize
  const init = await mcp.call('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'tc-test', version: '0.0.1' },
  });
  assert.equal(init.result.serverInfo.name, 'techcompass');
  mcp.notify('notifications/initialized');

  // 2. tools/list
  const tools = await mcp.call('tools/list', {});
  const names = tools.result.tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['get_analysis_rubric', 'list_projects', 'register_project', 'save_analysis']);

  // 3. register_project（带 Agent 总结的 context）
  const reg = await mcp.call('tools/call', {
    name: 'register_project',
    arguments: {
      path: path.join(__dirname, 'fixtures', 'sample-blog'),
      context: { name: 'sample-blog', goal: '个人技术博客', stage: 'mvp', stack: ['Next.js', 'React'], focus: '加评论', constraints: ['单人维护'] },
    },
  });
  assert.ok(reg.result.content[0].text.includes('已注册项目'));

  // 4. list_projects
  const list = await mcp.call('tools/call', { name: 'list_projects', arguments: {} });
  const ctx = JSON.parse(list.result.content[0].text.split('\n\n')[0].replace(/^"|"$/g, '') || 'null');
  assert.ok(list.result.content[0].text.includes('sample-blog'));

  // 5. rubric
  const rubric = await mcp.call('tools/call', { name: 'get_analysis_rubric', arguments: { content: 'Tauri 值得用吗' } });
  const rubricObj = JSON.parse(rubric.result.content[0].text);
  assert.ok(rubricObj.input.text.includes('Tauri'));
  assert.equal(rubricObj.projects.length, 1);
  assert.ok(rubricObj.rules['2 逐项目判断'].includes('独立'));

  // 6. save_analysis（合法）
  const pid = rubricObj.projects[0].projectId;
  const good = await mcp.call('tools/call', {
    name: 'save_analysis',
    arguments: {
      content: 'Tauri 值得用吗',
      result: {
        terms: [{ term: 'Tauri', what: 'Rust 桌面框架', solves: '更小的桌面产物' }],
        projects: [{
          projectId: pid, relevance: 'low', verdict: 'ignore',
          reasoning: '博客是 Next.js Web 项目，无桌面端', role: { fit: '当前无适用位置' },
          futureTrigger: '博客要做桌面客户端时',
        }],
        missing: [],
      },
    },
  });
  assert.ok(good.result.content[0].text.includes('已保存'));

  // 7. save_analysis（缺 futureTrigger → 契约拒绝）
  const bad = await mcp.call('tools/call', {
    name: 'save_analysis',
    arguments: {
      content: 'x',
      result: {
        terms: [{ term: 'X', what: 'y', solves: 'z' }],
        projects: [{ projectId: pid, relevance: 'low', verdict: 'later', reasoning: 'r', role: { fit: 'f' } }],
      },
    },
  });
  assert.ok(bad.result.isError);
  assert.ok(bad.result.content[0].text.includes('futureTrigger'));

  // 8. 结果确实落到了共享存储（卡片可见同一份数据）
  const analyses = fs.readFileSync(path.join(home, 'analyses.jsonl'), 'utf8').trim().split('\n');
  assert.equal(analyses.length, 1);
  assert.equal(JSON.parse(analyses[0]).agentUsed, 'mcp-session');

  fs.rmSync(home, { recursive: true, force: true });
});
