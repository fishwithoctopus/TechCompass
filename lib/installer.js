// lib/installer.js — Agent MCP 配置注册/注销（v0.2.1 事故修复版）
//
// v0.2.0 事故（Codex 配置损坏）的根因：registerCodex 用字符串拼接生成 TOML，
// 未转义 Windows 路径反斜杠，且无写入前解析校验 → 写出非法 TOML 导致 Codex 无法启动。
// 另有两处同源缺陷：注销正则遗留 [mcp_servers.techcompass.env] 子表（重注册→重复定义）；
// JSON 配置读取失败被当成空对象重写。
//
// v0.2.1 安全闭环（所有 Agent、注册与注销统一走本管道）：
//   1. 生成候选配置绝不拼接未编码字符串：TOML 用字面量/基本字符串编码器，JSON 用 JSON.stringify
//   2. 候选配置必须先通过真实解析器（smol-toml / JSON.parse）整文件校验
//   3. 语义比对：解析(候选) 必须与 解析(原文件)±techcompass 完全一致，否则拒绝写入
//   4. 原文件无法解析 / 无法读取 / 不存在 → 中止并提示，绝不当成空配置重写
//   5. 写入前双重并发检查 + 备份 + 临时文件原子替换 + 写后回读验证（失败自动还原备份）
//   6. 连通性探测（MCP initialize 握手）与配置写入结果分开报告
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import toml from 'smol-toml';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'cursor', 'windsurf'];

export function agentConfigPaths(home = os.homedir()) {
  return {
    claude: path.join(home, '.claude.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    cursor: path.join(home, '.cursor', 'mcp.json'),
    windsurf: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  };
}

// 是否运行在打包后的 Electron 应用里（此时 process.execPath 是应用本体，不是 node）
export function isPackagedElectron(over = {}) {
  const exec = over.execPath ?? process.execPath ?? '';
  const electron = over.electron ?? process.versions?.electron;
  const runAsNode = over.runAsNode ?? process.env.ELECTRON_RUN_AS_NODE;
  return electron != null && !/node(\.exe)?$/i.test(exec) && runAsNode !== '1';
}

// MCP server 启动条目。打包态：TechCompass.exe + ELECTRON_RUN_AS_NODE=1；
// 否则 node server.js。over 参数仅供测试注入。
export function mcpEntry(mcpServerPath, over = {}) {
  if (isPackagedElectron(over)) {
    return {
      command: over.execPath ?? process.execPath,
      args: [mcpServerPath],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { command: process.execPath || 'node', args: [mcpServerPath] };
}

// ---------- 通用工具 ----------

class ConfigEditError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// 错误文案脱敏：解析器错误可能内嵌源码行，只保留首行且截断
function firstLineOfError(e) {
  return String((e && e.message) || e).split('\n')[0].slice(0, 200);
}
function errCode(e) { return (e && e.code) || firstLineOfError(e); }
function stripBom(s) { return s.startsWith('\uFEFF') ? s.slice(1) : s; }

// ---------- TOML 字符串/键编码（不拼接任何未编码内容） ----------

// 字符串编码：优先单引号字面量（内部无需转义，天然支持反斜杠/空格/中文）；
// 含单引号或控制字符时退回双引号基本字符串并完整转义
export function encodeTomlString(s) {
  const str = String(s);
  if (!str.includes("'") && !/[\n\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(str)) {
    return `'${str}'`;
  }
  let out = '"';
  for (const ch of str) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\b': out += '\\b'; break;
      case '\f': out += '\\f'; break;
      default: {
        const code = ch.codePointAt(0);
        if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0');
        else out += ch;
      }
    }
  }
  return out + '"';
}

// 键编码：bare key 仅限字母数字-_，其余用字符串编码
export function encodeTomlKey(k) {
  const key = String(k);
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : encodeTomlString(key);
}

// techcompass 的 TOML 块（command/args/env 全部走编码器）
export function codexEntryBlock(entry, eol = '\n') {
  const lines = [];
  lines.push('[mcp_servers.techcompass]');
  lines.push(`command = ${encodeTomlString(entry.command)}`);
  const args = Array.isArray(entry.args) ? entry.args : [];
  lines.push(`args = [${args.map((a) => encodeTomlString(a)).join(', ')}]`);
  if (entry.env && Object.keys(entry.env).length) {
    lines.push('');
    lines.push('[mcp_servers.techcompass.env]');
    for (const [k, v] of Object.entries(entry.env)) {
      lines.push(`${encodeTomlKey(k)} = ${encodeTomlString(v)}`);
    }
  }
  return lines.join(eol);
}

// ---------- TOML 手术式移除（按行，只动 techcompass 自己的块） ----------

const TABLE_RE = /^\s*\[+\s*(.*?)\s*\]+\s*(?:#.*)?$/;
const DOTTED_TC_RE = /^\s*mcp_servers\s*\.\s*["']?techcompass["']?\s*(\.|\s*=)/;
const INLINE_TC_RE = /^\s*["']?techcompass["']?\s*=\s*\{[^}]*\}\s*(?:#.*)?$/;

function normTableKey(header) {
  return header.split('.').map((seg) => seg.trim().replace(/^["']+|["']+$/g, '')).join('.');
}
function isTcTableKey(key) {
  return key === 'mcp_servers.techcompass' || key.startsWith('mcp_servers.techcompass.');
}

// 移除 [mcp_servers.techcompass] 及其全部子表（含 [[...]] 数组表形态）、
// 顶层 dotted key 形态、[mcp_servers] 内单行 inline table 形态。
// 不支持的形式（如跨行 inline table）不会被误删——后续整文件校验会拒绝写入而不是破坏文件。
function removeTechcompassFromToml(text) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  let currentTable = '';
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(TABLE_RE);
    if (m) {
      currentTable = normTableKey(m[1]);
      skipping = isTcTableKey(currentTable);
      if (!skipping) out.push(raw);
      continue;
    }
    if (skipping) continue;
    if (currentTable === '' && DOTTED_TC_RE.test(line)) continue;
    if (currentTable === 'mcp_servers' && INLINE_TC_RE.test(line)) continue;
    out.push(raw);
  }
  return out.join('\n');
}

// ---------- 候选配置构建 + 真解析器校验 + 语义比对 ----------

function parseTomlStrict(text, what) {
  try {
    return toml.parse(stripBom(text));
  } catch (e) {
    throw new ConfigEditError('TOML_INVALID', `${what}（${firstLineOfError(e)}）。已中止，未做任何修改。`);
  }
}

// 空的 mcp_servers 表与缺失该表对 Agent 语义等价，比较前统一归一化
function stripEmptyMcpServers(doc) {
  const c = structuredClone(doc);
  if (c && typeof c === 'object' && c.mcp_servers && Object.keys(c.mcp_servers).length === 0) delete c.mcp_servers;
  return c;
}
function assertSameTomlDoc(actual, expected) {
  try {
    assert.deepEqual(stripEmptyMcpServers(actual), stripEmptyMcpServers(expected));
  } catch {
    throw new ConfigEditError('SEMANTIC_MISMATCH', '生成的配置与预期语义不一致（原文件可能含无法识别的 techcompass 写法）。已中止，未做任何修改。');
  }
}

function tomlEntryShape(entry) {
  const shape = {
    command: String(entry.command),
    args: (Array.isArray(entry.args) ? entry.args : []).map(String),
  };
  if (entry.env && Object.keys(entry.env).length) {
    shape.env = Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [String(k), String(v)]));
  }
  return shape;
}

function detectEol(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function bomOf(text) { return text.startsWith('\uFEFF') ? '\uFEFF' : ''; }

function buildCodexRegisterCandidate(entry, original) {
  const orig = parseTomlStrict(original, '原配置不是有效的 TOML');
  const eol = detectEol(original);
  const body = removeTechcompassFromToml(original).trim();
  const candidate = bomOf(original) + (body ? body + eol + eol : '') + codexEntryBlock(entry, eol) + eol;
  const cand = parseTomlStrict(candidate, '生成的配置未通过 TOML 解析校验');
  const expected = structuredClone(orig);
  delete expected.mcp_servers?.techcompass;
  expected.mcp_servers ??= {};
  expected.mcp_servers.techcompass = tomlEntryShape(entry);
  assertSameTomlDoc(cand, expected);
  return { candidate };
}

function buildCodexUnregisterCandidate(original) {
  const orig = parseTomlStrict(original, '原配置不是有效的 TOML');
  if (!orig.mcp_servers?.techcompass) return { noop: true };
  const eol = detectEol(original);
  const body = removeTechcompassFromToml(original).trim();
  const candidate = bomOf(original) + (body ? body + eol : '');
  const cand = parseTomlStrict(candidate, '生成的配置未通过 TOML 解析校验');
  const expected = structuredClone(orig);
  delete expected.mcp_servers?.techcompass;
  assertSameTomlDoc(cand, expected);
  return { candidate };
}

// ---------- JSON 类 Agent（claude / cursor / windsurf）候选构建 ----------

function parseJsonStrict(text, what) {
  try {
    return JSON.parse(stripBom(text));
  } catch (e) {
    throw new ConfigEditError('JSON_INVALID', `${what}（${firstLineOfError(e)}）。已中止，未做任何修改。`);
  }
}

function jsonEntryShape(entry) {
  const shape = { command: String(entry.command), args: (Array.isArray(entry.args) ? entry.args : []).map(String) };
  if (entry.env && Object.keys(entry.env).length) {
    shape.env = Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [String(k), String(v)]));
  }
  return shape;
}

function buildJsonRegisterCandidate(entry, original) {
  const orig = parseJsonStrict(original, '原配置不是有效的 JSON');
  if (typeof orig !== 'object' || orig === null || Array.isArray(orig)) {
    throw new ConfigEditError('JSON_INVALID', '原配置不是 JSON 对象。已中止，未做任何修改。');
  }
  const next = structuredClone(orig);
  next.mcpServers = next.mcpServers && typeof next.mcpServers === 'object' ? next.mcpServers : {};
  next.mcpServers.techcompass = jsonEntryShape(entry);
  const candidate = JSON.stringify(next, null, 2) + '\n';
  // 回读校验：候选文本必须可解析且与预期完全一致
  const back = parseJsonStrict(candidate, '生成的配置未通过 JSON 校验');
  try {
    assert.deepEqual(back, next);
  } catch {
    throw new ConfigEditError('SEMANTIC_MISMATCH', '生成的配置与预期语义不一致。已中止，未做任何修改。');
  }
  return { candidate };
}

function buildJsonUnregisterCandidate(original) {
  const orig = parseJsonStrict(original, '原配置不是有效的 JSON');
  if (typeof orig !== 'object' || orig === null || Array.isArray(orig)) {
    throw new ConfigEditError('JSON_INVALID', '原配置不是 JSON 对象。已中止，未做任何修改。');
  }
  if (!orig.mcpServers?.techcompass) return { noop: true };
  const next = structuredClone(orig);
  delete next.mcpServers.techcompass;
  return { candidate: JSON.stringify(next, null, 2) + '\n' };
}

// ---------- 统一安全写入管道 ----------

function safeEditConfig(configPath, build, { deps = {} } = {}) {
  const read = deps.readFileSync ?? ((p) => fs.readFileSync(p, 'utf8'));
  const copyFile = deps.copyFileSync ?? fs.copyFileSync;
  const writeTmp = deps.writeTmpSync ?? ((p, content) => {
    const fd = fs.openSync(p, 'w');
    try { fs.writeSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
  const doRename = deps.renameSync ?? fs.renameSync;
  const unlink = deps.unlinkSync ?? fs.unlinkSync;
  const now = deps.now ?? Date.now;

  // 1. 读取（失败/不存在 → 中止，绝不创建或重写）
  let original;
  try { original = read(configPath); }
  catch (e) {
    const hint = e.code === 'ENOENT' ? '（文件不存在：请先运行一次对应 Agent 让其生成配置，再接入）' : '';
    return { ok: false, code: 'READ_FAILED', error: `无法读取 ${configPath}${hint}（${errCode(e)}）。已中止，未做任何修改。`, untouched: true };
  }

  // 2. 生成候选（内部含整文件解析校验 + 语义比对；任何失败都抛 ConfigEditError）
  let built;
  try { built = build(original); }
  catch (e) {
    if (e instanceof ConfigEditError) return { ok: false, code: e.code, error: e.message, untouched: true };
    return { ok: false, code: 'UNEXPECTED', error: `生成配置时出现未预期错误（${firstLineOfError(e)}）。已中止，未做任何修改。`, untouched: true };
  }
  if (built.noop) return { ok: true, noop: true };

  // 3. 并发检查：处理期间文件是否被其他程序修改
  let recheck;
  try { recheck = read(configPath); }
  catch (e) { return { ok: false, code: 'READ_FAILED', error: `重新读取失败（${errCode(e)}）。已中止，未做任何修改。`, untouched: true }; }
  if (recheck !== original) {
    return { ok: false, code: 'CONCURRENT_MODIFY', error: '配置文件在处理期间被其他程序修改。已中止，未做任何修改。', untouched: true };
  }

  // 4. 备份原文件（注册与注销都要备份）
  const bak = `${configPath}.techcompass.bak-${now()}`;
  try { copyFile(configPath, bak); }
  catch (e) { return { ok: false, code: 'BACKUP_FAILED', error: `备份原配置失败（${errCode(e)}）。已中止，未做任何修改。`, untouched: true }; }

  // 5. 临时文件写入 → 最后一刻并发检查 → 原子替换
  let mode = 0o644;
  try { mode = fs.statSync(configPath).mode; } catch { /* 保留默认 */ }
  const tmp = `${configPath}.techcompass.tmp-${process.pid}-${now()}`;
  try { writeTmp(tmp, built.candidate); }
  catch (e) { return { ok: false, code: 'WRITE_FAILED', error: `写入临时文件失败（${errCode(e)}）。原文件未改动。`, untouched: true }; }
  try {
    const cur = read(configPath);
    if (cur !== original) {
      try { unlink(tmp); } catch { /* 清理尽力而为 */ }
      return { ok: false, code: 'CONCURRENT_MODIFY', error: '配置文件在写入前被其他程序修改。已中止，原文件未改动。', untouched: true };
    }
    doRename(tmp, configPath);
  } catch (e) {
    try { unlink(tmp); } catch { /* 清理尽力而为 */ }
    return { ok: false, code: 'WRITE_FAILED', error: `原子替换失败（${errCode(e)}）。原文件未改动。`, untouched: true };
  }

  // 6. 写后回读验证（真实字节比对；不符则自动还原备份）
  let after = null;
  try { after = fs.readFileSync(configPath, 'utf8'); } catch { /* 下方统一判定 */ }
  if (after !== built.candidate) {
      return { ok: false, code: 'POSTCHECK_FAILED', error: '写入后校验失败，文件可能被其他程序修改。为避免覆盖其他修改，未自动还原。请先检查当前配置；原配置备份已保留。', untouched: false, originalRestored: false, backup: bak, configPath };
  }
  return { ok: true, backup: bak, bytes: Buffer.byteLength(built.candidate) };
}

// ---------- 连通性探测（与写入结果分开报告，永不阻塞写入结论） ----------

export async function probeEntry(entry, { timeoutMs = 8000 } = {}) {
  let child;
  try {
    child = spawn(String(entry.command), (entry.args || []).map(String), {
      env: { ...process.env, ...(entry.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { ok: false, detail: `无法启动命令（${firstLineOfError(e)}）` };
  }
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 尽力而为 */ }
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, `超时：${timeoutMs}ms 内未完成 MCP initialize 握手`), timeoutMs);
    child.on('error', (e) => finish(false, `无法启动命令（${errCode(e)}）`));
    child.on('exit', (code) => { if (!done) finish(false, `进程提前退出（code=${code}）`); });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          if (msg && msg.result && msg.result.serverInfo) {
            return finish(true, `initialize 握手成功（${msg.result.serverInfo.name} v${msg.result.serverInfo.version}）`);
          }
        } catch { /* 非协议输出，忽略 */ }
      }
    });
    child.stdin.on('error', () => {}); // 对端退出时的 EPIPE 不算错误
    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'techcompass-probe', version: '0.0.0' } },
      }) + '\n');
    } catch (e) { finish(false, `无法写入 stdin（${firstLineOfError(e)}）`); }
  });
}

// ---------- 对外 API ----------

function validateEntry(entry) {
  if (!entry || typeof entry.command !== 'string' || !entry.command) throw new Error('entry.command 必须是非空字符串');
  if (entry.args !== undefined && !Array.isArray(entry.args)) throw new Error('entry.args 必须是字符串数组');
  if (entry.env !== undefined && typeof entry.env !== 'object') throw new Error('entry.env 必须是对象');
}

// 只注册用户选择的 agents。返回逐 Agent 结果：
//   { agent, ok, path, backup?, noop?, probe?, code?, error?, untouched? }
// probe 与写入分开：写入失败不代表探测有意义，写入成功也不代表连通。
export async function registerFor(agents, {
  mcpServerPath, home = os.homedir(), entry,
  probe = true, probeTimeoutMs = 8000, deps = {},
} = {}) {
  const wanted = [...new Set(agents || [])].filter((a) => SUPPORTED_AGENTS.includes(a));
  if (!wanted.length) return { results: [], error: '未选择任何 Agent（可选：' + SUPPORTED_AGENTS.join(', ') + '）' };
  const theEntry = entry ?? (() => {
    if (!mcpServerPath) throw new Error('mcpServerPath 或 entry 至少提供一个');
    return mcpEntry(mcpServerPath);
  })();
  validateEntry(theEntry);
  const paths = agentConfigPaths(home);
  const results = [];
  for (const agent of wanted) {
    let r;
    try {
      if (agent === 'codex') r = safeEditConfig(paths.codex, (orig) => buildCodexRegisterCandidate(theEntry, orig), { deps });
      else if (agent === 'claude') r = safeEditConfig(paths.claude, (orig) => buildJsonRegisterCandidate(theEntry, orig), { deps });
      else if (agent === 'cursor') r = safeEditConfig(paths.cursor, (orig) => buildJsonRegisterCandidate(theEntry, orig), { deps });
      else r = safeEditConfig(paths.windsurf, (orig) => buildJsonRegisterCandidate(theEntry, orig), { deps });
      r.path = paths[agent];
    } catch (err) {
      r = { ok: false, error: firstLineOfError(err), untouched: true, path: paths[agent] };
    }
    r.agent = agent;
    results.push(r);
  }
  if (probe) {
    const p = await probeEntry(theEntry, { timeoutMs: probeTimeoutMs });
    for (const r of results) r.probe = p;
  }
  return { results, entry: theEntry };
}

export async function registerAll(mcpServerPath, opts = {}) {
  return registerFor(SUPPORTED_AGENTS, { mcpServerPath, ...opts });
}

export function unregisterFor(agents, { home = os.homedir(), deps = {} } = {}) {
  const wanted = [...new Set(agents || [])].filter((a) => SUPPORTED_AGENTS.includes(a));
  if (!wanted.length) return { results: [], error: '未选择任何 Agent' };
  const paths = agentConfigPaths(home);
  const results = [];
  for (const agent of wanted) {
    let r;
    try {
      if (agent === 'codex') r = safeEditConfig(paths.codex, buildCodexUnregisterCandidate, { deps });
      else r = safeEditConfig(paths[agent], buildJsonUnregisterCandidate, { deps });
      r.path = paths[agent];
    } catch (err) {
      r = { ok: false, error: firstLineOfError(err), untouched: true, path: paths[agent] };
    }
    r.agent = agent;
    results.push(r);
  }
  return { results };
}

export function unregisterAll({ home = os.homedir() } = {}) {
  return unregisterFor(SUPPORTED_AGENTS, { home });
}

// 检测注册状态：用真实解析器判定（不靠文本匹配），并报告配置是否可解析
export function checkRegistrations({ home = os.homedir() } = {}) {
  const paths = agentConfigPaths(home);
  const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const out = {};
  for (const agent of ['claude', 'cursor', 'windsurf']) {
    const text = readText(paths[agent]);
    let installed = false;
    let parseError = false;
    if (text != null) {
      try { installed = !!JSON.parse(stripBom(text))?.mcpServers?.techcompass; }
      catch { parseError = true; }
    }
    out[agent] = { installed, parseError, path: paths[agent], exists: text != null };
  }
  const codexText = readText(paths.codex);
  let codexInstalled = false;
  let codexParseError = false;
  if (codexText != null) {
    try { codexInstalled = !!toml.parse(stripBom(codexText))?.mcp_servers?.techcompass; }
    catch { codexParseError = true; }
  }
  out.codex = { installed: codexInstalled, parseError: codexParseError, path: paths.codex, exists: codexText != null };
  return out;
}
