// test/installer.test.js — MCP 注册安全管道：JSON 类 Agent、连通性探测、状态检测、条目生成
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerFor, unregisterFor, checkRegistrations, mcpEntry, isPackagedElectron } from '../lib/installer.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-inst-'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = path.join(ROOT, 'mcp', 'server.js');

const WIN_PATH_ENTRY = {
  command: 'C:\\Users\\李明\\AppData\\Local\\Programs\\TechCompass 0.2\\TechCompass.exe',
  args: ['C:\\Users\\李明\\AppData\\Local\\Programs\\TechCompass 0.2\\resources\\mcp\\server.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

test('registerFor：只修改所选 Agent，未选的配置不动', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { myown: { command: 'foo' } }, other: 1 }));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'bar' } } }));

  const { results } = await registerFor(['claude'], { home, entry: WIN_PATH_ENTRY, probe: false });
  assert.ok(results.every((r) => r.agent === 'claude' && r.ok));

  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(claude.mcpServers.techcompass.command, WIN_PATH_ENTRY.command, '中文/空格/反斜杠路径精确写入');
  assert.deepEqual(claude.mcpServers.myown, { command: 'foo' }, '用户原有 MCP 保留');
  assert.equal(claude.other, 1, '其余字段保留');

  const baks = fs.readdirSync(home).filter((f) => f.startsWith('.claude.json.techcompass.bak-'));
  assert.equal(baks.length, 1, '已生成备份');
  assert.equal(fs.readFileSync(path.join(home, baks[0]), 'utf8'), JSON.stringify({ mcpServers: { myown: { command: 'foo' } }, other: 1 }), '备份内容=原文件');

  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(!cursor.mcpServers.techcompass, '未选择的 Agent 未被注册');
  assert.deepEqual(cursor.mcpServers.keep, { command: 'bar' });
  assert.ok(!fs.existsSync(path.join(home, '.codeium', 'windsurf', 'mcp_config.json')));
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'config.toml')));
});

test('claude：连续注册两次只留单条目', async () => {
  const home = tmp();
  const cfg = path.join(home, '.claude.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { myown: { command: 'foo' } } }));
  await registerFor(['claude'], { home, entry: WIN_PATH_ENTRY, probe: false });
  await registerFor(['claude'], { home, entry: WIN_PATH_ENTRY, probe: false });
  const doc = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.ok(doc.mcpServers.techcompass);
  assert.deepEqual(doc.mcpServers.myown, { command: 'foo' });
  assert.equal(Object.keys(doc.mcpServers).length, 2, '无重复条目');
});

test('claude：注销移除 techcompass 且有备份；无条目时注销为 noop', async () => {
  const home = tmp();
  const cfg = path.join(home, '.claude.json');
  const orig = JSON.stringify({ mcpServers: { myown: { command: 'foo' } }, other: 1 });
  fs.writeFileSync(cfg, orig);
  await registerFor(['claude'], { home, entry: WIN_PATH_ENTRY, probe: false });
  const r = await unregisterFor(['claude'], { home });
  assert.ok(r.results[0].ok && r.results[0].backup, '注销也备份');
  const doc = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(doc, JSON.parse(orig), '注销后语义=原配置');

  const r2 = await unregisterFor(['claude'], { home });
  assert.ok(r2.results[0].ok && r2.results[0].noop, '无条目 → noop');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), JSON.parse(orig), 'noop 不改文件');
});

test('claude：原配置 JSON 语法错误 → 中止 + 字节不变（不当空配置重写）', async () => {
  const home = tmp();
  const cfg = path.join(home, '.claude.json');
  const broken = '{ "mcpServers": { BROKEN';
  fs.writeFileSync(cfg, broken);
  const { results } = await registerFor(['claude'], { home, entry: WIN_PATH_ENTRY, probe: false });
  assert.ok(!results[0].ok);
  assert.match(results[0].error, /原配置不是有效的 JSON/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), broken, '字节不变');
});

test('claude：配置文件不存在 → 中止并给出指引', async () => {
  const home = tmp();
  const { results } = await registerFor(['claude'], { home, entry: WIN_PATH_ENTRY, probe: false });
  assert.ok(!results[0].ok);
  assert.match(results[0].error, /先运行一次/);
  assert.equal(fs.readdirSync(home).length, 0, '不创建文件');
});

test('cursor / windsurf：注册与注销均安全', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'bar' } } }));
  fs.mkdirSync(path.join(home, '.codeium', 'windsurf'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), JSON.stringify({ mcpServers: { keep2: { command: 'baz' } } }));

  const r = await registerFor(['cursor', 'windsurf'], { home, entry: WIN_PATH_ENTRY, probe: false });
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results.map((x) => x.error)));
  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  const ws = JSON.parse(fs.readFileSync(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'));
  assert.ok(cursor.mcpServers.techcompass && cursor.mcpServers.keep);
  assert.ok(ws.mcpServers.techcompass && ws.mcpServers.keep2);

  const u = await unregisterFor(['cursor', 'windsurf'], { home });
  assert.ok(u.results.every((x) => x.ok));
  assert.ok(!JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.techcompass);
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.keep);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8')).mcpServers.techcompass);
});

test('MCP 连通性探测：真实 stdio initialize 握手（与写入分开报告，两者均真）', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n');
  const entry = {
    command: process.execPath,
    args: [MCP_SERVER],
    env: { TECHCOMPASS_HOME: path.join(home, 'store') },
  };
  const { results } = await registerFor(['claude'], { home, entry, probe: true, probeTimeoutMs: 15000 });
  const r = results[0];
  assert.ok(r.ok, '写入成功: ' + (r.error || ''));
  assert.equal(r.probe.ok, true, '连通性握手成功: ' + (r.probe.detail || ''));
  assert.match(r.probe.detail, /techcompass/);
});

test('MCP 连通性探测失败不影响写入结论（分开报告）', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n');
  const badEntry = { command: '/nonexistent/techcompass-probe-fail', args: [] };
  const { results } = await registerFor(['claude'], { home, entry: badEntry, probe: true, probeTimeoutMs: 3000 });
  const r = results[0];
  assert.ok(r.ok, '写入仍成功');
  assert.equal(r.probe.ok, false, '探测如实失败');
});

test('probe:false → 不探测，结果里无 probe 字段', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n');
  const { results } = await registerFor(['claude'], { home, entry: WIN_PATH_ENTRY, probe: false });
  assert.ok(results[0].ok);
  assert.equal(results[0].probe, undefined);
});

test('checkRegistrations：解析判定而非文本匹配；损坏配置标记 parseError', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  // 注释里的表头不该被当成已注册（v0.2.0 是文本 includes 判定）
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '# [mcp_servers.techcompass]\nmodel = "gpt-5"\n');
  let st = checkRegistrations({ home });
  assert.equal(st.codex.installed, false, '注释里的表头不算已注册');
  assert.equal(st.codex.parseError, false);

  await registerFor(['codex'], { home, entry: WIN_PATH_ENTRY, probe: false });
  st = checkRegistrations({ home });
  assert.equal(st.codex.installed, true);
  assert.equal(st.codex.parseError, false);

  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'broken [ [');
  st = checkRegistrations({ home });
  assert.equal(st.codex.installed, false);
  assert.equal(st.codex.parseError, true, '损坏配置被标记（UI 可提示用户）');
});

test('registerFor：空选择报错，不写任何文件', async () => {
  const home = tmp();
  const { results, error } = await registerFor([], { mcpServerPath: '/x/s.js', home });
  assert.ok(error);
  assert.equal(results.length, 0);
  assert.equal(fs.readdirSync(home).length, 0);
});

test('mcpEntry：打包 Electron 态带 ELECTRON_RUN_AS_NODE，node 态不带', () => {
  const plain = mcpEntry('/x/mcp/server.js');
  assert.equal(plain.env, undefined);
  assert.deepEqual(plain.args, ['/x/mcp/server.js']);

  const packed = mcpEntry('/x/mcp/server.js', { execPath: 'C:\\Apps\\TechCompass.exe', electron: '33.4.11' });
  assert.equal(packed.command, 'C:\\Apps\\TechCompass.exe');
  assert.deepEqual(packed.env, { ELECTRON_RUN_AS_NODE: '1' }, '必须带 as-node env，否则 Agent 调起的是 GUI');
  assert.ok(isPackagedElectron({ execPath: 'C:\\Apps\\TechCompass.exe', electron: '33.4.11' }));
  assert.ok(!isPackagedElectron({ execPath: 'C:\\Apps\\TechCompass.exe', electron: '33.4.11', runAsNode: '1' }));
  assert.ok(!isPackagedElectron({ execPath: '/usr/local/bin/node', electron: '33.4.11' }), 'node 执行器不算');
});
