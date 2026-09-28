import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startDaemon } from '../lib/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('HTTP MCP: authenticated SDK handshake, tools and shared project store; reject unsafe requests', async t => {
  const d = await startDaemon({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-http-test-')), port: 0 });
  t.after(d.stop);
  const base = `http://127.0.0.1:${d.port}`;
  assert.equal((await fetch(`${base}/api/mcp/connection`)).status, 401);
  const info = await (await fetch(`${base}/api/mcp/connection`, { headers: { 'x-tc-token': d.token } })).json();
  assert.notEqual(info.bearerToken, d.token);
  assert.equal((await fetch(info.url, { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${info.bearerToken}` };
  assert.equal((await fetch(info.url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(info.url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(info.url, { method: 'GET', headers })).status, 405);
  assert.equal((await fetch(info.url, { method: 'POST', headers, body: '{' })).status, 400);
  const client = new Client({ name: 'integration-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers } }));
  assert.equal((await client.listTools()).tools.length, 4);
  const registered = await client.callTool({ name: 'register_project', arguments: { path: path.resolve('test/fixtures/sample-blog') } });
  assert.ok(!registered.isError);
  assert.equal(d.app.store.getContexts().length, 1);
  assert.match(JSON.stringify(await client.callTool({ name: 'list_projects', arguments: {} })), /sample-blog/);
  const rubric = await client.callTool({ name: 'get_analysis_rubric', arguments: { content: 'unverified-test-term' } });
  assert.ok(!rubric.isError);
  const saved = await client.callTool({ name: 'save_analysis', arguments: { content: 'unverified-test-term', result: { identityStatus: 'unverified', terms: [{ term: 'unverified-test-term', what: '尚未确认', solves: '尚未确认' }], projects: [], missing: ['请补充来源'] } } });
  assert.ok(!saved.isError);
  assert.equal(d.app.store.listAnalyses().length, 1);
  const projectId = d.app.store.getContexts()[0].projectId;
  const comparison = { status:'supported', baseline:'Example 1（测试基准）', changes:['测试变化'], tradeoffs:'速度未验证', upgradeAdvice:'先验证', sources:['https://example.com/release'] };
  const modelSaved = await client.callTool({ name:'save_analysis', arguments:{ content:'Example 2（测试模型）', result:{
    identityStatus:'identified', terms:[{term:'Example 2',kind:'model',what:'测试模型',solves:'测试用途',applicationExample:'例如用于文档问答',comparison}],
    projects:[{projectId,relevance:'low',verdict:'ignore',reasoning:'当前项目不涉及模型调用',role:{fit:'无'},futureTrigger:'需要问答功能时'}],missing:[],
  } } });
  assert.ok(!modelSaved.isError, JSON.stringify(modelSaved));
  assert.deepEqual(d.app.store.listAnalyses()[0].result.terms[0].comparison, comparison);
});
