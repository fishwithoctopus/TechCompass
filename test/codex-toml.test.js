// test/codex-toml.test.js — Codex TOML 注册/注销安全回归（v0.2.0 事故修复验证）
// 分层：① 证明测试可检出旧版缺陷（legacy 逐字复制自 v0.2.0）② 证明修复后通过 ③ 故障注入
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import toml from 'smol-toml';
import { registerFor, unregisterFor, encodeTomlString, encodeTomlKey, codexEntryBlock } from '../lib/installer.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-toml-'));
const codexHome = (config) => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), config);
  return home;
};
const cfgOf = (h) => path.join(h, '.codex', 'config.toml');
const bytesOf = (h) => fs.readFileSync(cfgOf(h));
const plain = (o) => JSON.parse(JSON.stringify(o)); // smol-toml 返回 null 原型对象，归一化后再比较
const parseCfg = (h) => plain(toml.parse(fs.readFileSync(cfgOf(h), 'utf8')));

// 模拟 Windows 打包态真实条目（路径含反斜杠、空格、中文）
const WIN_ENTRY = {
  command: 'C:\\Users\\李明\\AppData\\Local\\Programs\\TechCompass 0.2\\TechCompass.exe',
  args: ['C:\\Users\\李明\\AppData\\Local\\Programs\\TechCompass 0.2\\resources\\mcp\\server.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};
const ORIG = 'model = "gpt-5"\n\n[mcp_servers.myown]\ncommand = "npx"\nargs = ["-y", "myown"]\n';

// 注册快捷方式（默认关 probe，专注写入语义）
const reg = (home, entry = WIN_ENTRY, deps) => registerFor(['codex'], { home, entry, probe: false, deps });
const unreg = (home, deps) => unregisterFor(['codex'], { home, deps });

const stripEmptyMcp = (doc) => { const c = structuredClone(doc); if (c.mcp_servers && !Object.keys(c.mcp_servers).length) delete c.mcp_servers; return c; };
const semEq = (a, b) => assert.deepEqual(stripEmptyMcp(a), stripEmptyMcp(b));

// ============================================================
// ① 事故回归：证明本套测试能检出 v0.2.0 的缺陷
// ============================================================

// 以下 legacy 函数逐字复制自 v0.2.0 lib/installer.js registerCodex 的拼接逻辑
function legacyCodexBlock(entry) {
  const argsToml = entry.args.map((a) => `"${a.replace(/\\/g, '/')}"`).join(', ');
  let block = `\n\n[mcp_servers.techcompass]\ncommand = "${entry.command}"\nargs = [${argsToml}]\n`;
  if (entry.env) {
    const envPairs = Object.entries(entry.env).map(([k, v]) => `${k} = "${v}"`).join('\n');
    block += `\n[mcp_servers.techcompass.env]\n${envPairs}\n`;
  }
  return block;
}
// v0.2.0 的移除正则（逐字复制）
const legacyRemove = (t) => t.replace(/\[mcp_servers\.techcompass\][\s\S]*?(?=\n\[\[|\n\[|\s*$)/g, '').trimEnd();

test('【事故回归】旧版拼接 + Windows 路径 → 真实解析器拒绝（测试可检出旧缺陷#1）', () => {
  const broken = ORIG + legacyCodexBlock(WIN_ENTRY);
  assert.throws(() => toml.parse(broken), undefined, '旧代码产出的 config.toml 必须被真实 TOML 解析器判为非法');
});

test('【事故回归】旧版注销正则遗留 env 子表 → 重注册重复定义（测试可检出旧缺陷#2）', () => {
  const goodEntry = { command: '/opt/tc/TechCompass.exe', args: ['/opt/tc/mcp/server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const once = ORIG + legacyCodexBlock(goodEntry);
  assert.doesNotThrow(() => toml.parse(once), '合法路径下旧代码首次写入本身有效');
  const removed = legacyRemove(once);
  assert.ok(removed.includes('[mcp_servers.techcompass.env]'), '旧注销正则会遗留 env 子表（缺陷实锤）');
  assert.throws(() => toml.parse(removed + legacyCodexBlock(goodEntry)), '遗留子表 + 重注册 = 重复定义，必须被检出');
});

// ============================================================
// ② 修复验证：编码器与写入语义
// ============================================================

test('encodeTomlString：反斜杠/空格/中文/引号/换行/控制字符全部可往返', () => {
  const cases = [
    'plain',
    'C:\\Users\\李明\\App Data\\TechCompass 0.2\\TechCompass.exe',
    "it's a 'quoted' path",
    'say "hi"',
    "both '\" and \\ mix",
    'line\nbreak\r\nreturn',
    'tab\there',
    'ctrl\u0001char',
    '',
  ];
  for (const s of cases) {
    assert.equal(toml.parse('x = ' + encodeTomlString(s)).x, s, `往返失败: ${JSON.stringify(s)}`);
  }
});

test('encodeTomlKey：bare 键不加引号，其余键加引号', () => {
  assert.equal(encodeTomlKey('ELECTRON_RUN_AS_NODE'), 'ELECTRON_RUN_AS_NODE');
  assert.equal(encodeTomlKey('a-b_9'), 'a-b_9');
  const doc = toml.parse(encodeTomlKey('含空格 键') + ' = 1');
  assert.equal(doc['含空格 键'], 1);
});

test('codexEntryBlock：command/args/env 全部走编码器（无裸拼接）', () => {
  const block = codexEntryBlock(WIN_ENTRY);
  assert.match(block, /command = 'C:\\Users/); // 字面量单引号（反斜杠原样）
  const doc = plain(toml.parse(block));
  assert.equal(doc.mcp_servers.techcompass.command, WIN_ENTRY.command);
  assert.deepEqual(doc.mcp_servers.techcompass.args, WIN_ENTRY.args);
  assert.deepEqual(doc.mcp_servers.techcompass.env, WIN_ENTRY.env);
});

test('注册：Windows 打包路径（反斜杠+空格+中文）→ 完整文件真解析通过 + 精确还原 + 语义保留', async () => {
  const home = codexHome(ORIG);
  const { results } = await reg(home);
  assert.ok(results[0].ok, '写入成功: ' + JSON.stringify(results[0].error || ''));
  const doc = parseCfg(home);
  assert.equal(doc.mcp_servers.techcompass.command, WIN_ENTRY.command, 'command 精确还原（含反斜杠）');
  assert.deepEqual(doc.mcp_servers.techcompass.args, WIN_ENTRY.args, 'args 精确还原（不改斜杠）');
  assert.deepEqual(doc.mcp_servers.techcompass.env, WIN_ENTRY.env);
  assert.equal(doc.model, 'gpt-5', '用户原有顶层设置保留');
  assert.deepEqual(doc.mcp_servers.myown, { command: 'npx', args: ['-y', 'myown'] }, '用户原有 MCP 保留');
});

test('注册：args/env 含引号/反斜杠/中文/空格键 → 全部转义正确', async () => {
  const nasty = {
    command: "C:\\O'Brien's \"Tools\"\\指南针 0.2\\TechCompass.exe",
    args: ['C:\\path with space\\李明的 文件\\server.js', "it's \"quoted\" \\ back"],
    env: { ELECTRON_RUN_AS_NODE: '1', '含空格 键': '值"引号"\\反斜杠', QUOTE: "single'inside" },
  };
  const home = codexHome(ORIG);
  const { results } = await reg(home, nasty);
  assert.ok(results[0].ok, results[0].error);
  const doc = parseCfg(home);
  assert.equal(doc.mcp_servers.techcompass.command, nasty.command);
  assert.deepEqual(doc.mcp_servers.techcompass.args, nasty.args);
  assert.deepEqual(doc.mcp_servers.techcompass.env, nasty.env);
});

test('连续注册两次 → 单条目、env 子表头唯一、全程可解析', async () => {
  const home = codexHome(ORIG);
  await reg(home);
  await reg(home);
  const text = fs.readFileSync(cfgOf(home), 'utf8');
  assert.equal((text.match(/\[mcp_servers\.techcompass\]/g) || []).length, 1, '主表头唯一');
  assert.equal((text.match(/\[mcp_servers\.techcompass\.env\]/g) || []).length, 1, 'env 子表头唯一（旧版此处会重复）');
  const doc = parseCfg(home);
  assert.deepEqual(doc.mcp_servers.techcompass.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('注册→注销→再注册：全程可解析；注销后语义=原配置；无任何 techcompass 残留', async () => {
  const home = codexHome(ORIG);
  await reg(home);
  const r1 = await unreg(home);
  assert.ok(r1.results[0].ok, r1.results[0].error);
  const afterUn = fs.readFileSync(cfgOf(home), 'utf8');
  assert.ok(!afterUn.includes('techcompass'), '注销后无残留（旧版会遗留 env 子表）');
  semEq(parseCfg(home), toml.parse(ORIG), '注销后语义等于原配置');
  const r2 = await reg(home);
  assert.ok(r2.results[0].ok, '再注册成功');
  const doc = parseCfg(home);
  assert.equal(doc.mcp_servers.techcompass.command, WIN_ENTRY.command);
  assert.deepEqual(doc.mcp_servers.myown, { command: 'npx', args: ['-y', 'myown'] });
});

test('原配置含其他 MCP + 嵌套表 + 注释 + CRLF：注册后其余内容语义不变、注释保留、CRLF 保留', async () => {
  const crlf = '# 顶部注释\r\nmodel = "gpt-5"\r\n\r\n[profiles.default]\r\nmodel = "o4"\r\n\r\n[mcp_servers.myown]\r\ncommand = "npx"\r\nargs = ["-y", "myown"]\r\n# 我的注释\r\n';
  const home = codexHome(crlf);
  const { results } = await reg(home);
  assert.ok(results[0].ok, results[0].error);
  const text = fs.readFileSync(cfgOf(home), 'utf8');
  assert.ok(text.includes('# 顶部注释') && text.includes('# 我的注释'), '注释保留');
  assert.ok(text.includes('[mcp_servers.techcompass]\r\n'), '新块沿用 CRLF');
  const doc = plain(toml.parse(text));
  assert.deepEqual(doc.profiles, { default: { model: 'o4' } }, '嵌套表语义保留');
  assert.deepEqual(doc.mcp_servers.myown, { command: 'npx', args: ['-y', 'myown'] });
});

test('注销：孤立 env 子表残留现场（v0.2.0 损坏后用户手动删主表）→ 一并清除且语义正确', async () => {
  const broken = ORIG + '\n[mcp_servers.techcompass.env]\nELECTRON_RUN_AS_NODE = "1"\n';
  const home = codexHome(broken);
  const { results } = await unreg(home);
  assert.ok(results[0].ok, results[0].error);
  assert.ok(!fs.readFileSync(cfgOf(home), 'utf8').includes('techcompass'), '孤立子表被清除');
  semEq(parseCfg(home), toml.parse(ORIG));
});

// ============================================================
// ③ 故障注入：失败绝不破坏宿主文件
// ============================================================

test('原配置 TOML 语法错误 → 中止 + 字节不变 + 不生成备份', async () => {
  const home = codexHome('model = "broken\nnot toml [');
  const before = bytesOf(home);
  const { results } = await reg(home);
  assert.ok(!results[0].ok, '必须失败');
  assert.match(results[0].error, /原配置不是有效的 TOML/);
  assert.deepEqual(bytesOf(home), before, '原文件字节不变');
  assert.equal(fs.readdirSync(path.join(home, '.codex')).filter((f) => f.includes('bak') || f.includes('tmp')).length, 0, '无备份/临时文件');
});

test('配置文件不存在 → 中止并给出指引，不创建任何文件', async () => {
  const home = tmp();
  const { results } = await reg(home);
  assert.ok(!results[0].ok);
  assert.match(results[0].error, /先运行一次/);
  assert.equal(fs.readdirSync(home).length, 0, '未创建任何文件/目录');
});

test('读取失败（路径是目录）→ 中止，不写任何内容', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.codex', 'config.toml'), { recursive: true }); // 目录模拟读取失败
  const { results } = await reg(home);
  assert.ok(!results[0].ok);
  assert.match(results[0].error, /无法读取/);
  assert.ok(fs.statSync(path.join(home, '.codex', 'config.toml')).isDirectory(), '未被写坏');
});

test('无法识别的 techcompass 写法（跨行 inline table）→ 候选校验失败，字节不变', async () => {
  const weird = 'model = "gpt-5"\n\n[mcp_servers]\ntechcompass = {\n  command = "old",\n}\n';
  const home = codexHome(weird);
  const before = bytesOf(home);
  const { results } = await reg(home);
  assert.ok(!results[0].ok, '安全网必须拒绝，而不是写出重复定义');
  assert.match(results[0].error, /中止|校验/);
  assert.deepEqual(bytesOf(home), before, '原文件字节不变');
});

test('处理期间文件被外部修改（读取序列 A,A,B）→ 写入前一刻中止，字节不变，无 tmp 残留', async () => {
  const home = codexHome(ORIG);
  let calls = 0;
  const deps = { readFileSync: () => { calls++; return calls <= 2 ? ORIG : ORIG + '# changed'; } };
  const { results } = await reg(home, WIN_ENTRY, deps);
  assert.ok(!results[0].ok);
  assert.match(results[0].error, /被其他程序修改/);
  assert.equal(bytesOf(home).toString('utf8'), ORIG, '原文件未被覆盖');
  assert.equal(fs.readdirSync(path.join(home, '.codex')).filter((f) => f.includes('.tmp-')).length, 0, '临时文件已清理');
});

test('处理早期文件被外部修改（读取序列 A,B）→ 立即中止，字节不变，无备份', async () => {
  const home = codexHome(ORIG);
  let calls = 0;
  const deps = { readFileSync: () => { calls++; return calls === 1 ? ORIG : ORIG + '# changed'; } };
  const { results } = await reg(home, WIN_ENTRY, deps);
  assert.ok(!results[0].ok);
  assert.match(results[0].error, /被其他程序修改/);
  assert.equal(bytesOf(home).toString('utf8'), ORIG);
  assert.equal(fs.readdirSync(path.join(home, '.codex')).filter((f) => f.includes('bak')).length, 0);
});

test('写入临时文件失败（模拟 EACCES）→ 原文件未改动', async () => {
  const home = codexHome(ORIG);
  const before = bytesOf(home);
  const deps = { writeTmpSync: () => { const e = new Error('模拟写入失败'); e.code = 'EACCES'; throw e; } };
  const { results } = await reg(home, WIN_ENTRY, deps);
  assert.ok(!results[0].ok);
  assert.match(results[0].error, /写入临时文件失败/);
  assert.deepEqual(bytesOf(home), before);
});

test('原子替换失败（模拟目标被占用）→ 原文件未改动，无 tmp 残留', async () => {
  const home = codexHome(ORIG);
  const before = bytesOf(home);
  const deps = { renameSync: () => { const e = new Error('目标被占用'); e.code = 'EPERM'; throw e; } };
  const { results } = await reg(home, WIN_ENTRY, deps);
  assert.ok(!results[0].ok);
  assert.match(results[0].error, /原子替换失败/);
  assert.deepEqual(bytesOf(home), before);
  assert.equal(fs.readdirSync(path.join(home, '.codex')).filter((f) => f.includes('.tmp-')).length, 0);
});

test('注销时无 techcompass → noop，字节不变，无备份无临时文件', async () => {
  const home = codexHome(ORIG);
  const before = bytesOf(home);
  const { results } = await unreg(home);
  assert.ok(results[0].ok);
  assert.ok(results[0].noop, 'no-op');
  assert.deepEqual(bytesOf(home), before);
  assert.equal(fs.readdirSync(path.join(home, '.codex')).filter((f) => f.includes('bak') || f.includes('.tmp-')).length, 0);
});

test('注册与注销都生成备份，备份内容=修改前原文件字节', async () => {
  const home = codexHome(ORIG);
  const r1 = await reg(home);
  assert.ok(r1.results[0].backup, '注册有备份');
  assert.equal(fs.readFileSync(r1.results[0].backup, 'utf8'), ORIG, '备份=原文件');
  const r2 = await unreg(home);
  assert.ok(r2.results[0].backup, '注销也有备份（v0.2.1 新行为）');
});
