// lib/agentbridge.js — 统一的 Agent 调用层。
// claude / codex 适配器按各家 headless CLI 的公开用法实现；
// mock 适配器用于离线演示与自动化测试（沙箱/CI 里没有真实 Agent CLI）。
import spawn from 'cross-spawn';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { macAgentCandidates, agentEnvironment } from './platform.js';

export const AGENT_INFO = {
  claude: { id: 'claude', name: 'Claude Code', supportsImage: true },
  codex: { id: 'codex', name: 'Codex CLI', supportsImage: true },
  mock: { id: 'mock', name: '演示引擎（离线）', supportsImage: false },
  api: { id: 'api', name: '自定义 API 模型', supportsImage: true },
};

export function resolveAgent(id) {
  if (!['claude', 'codex'].includes(id)) return null;
  try {
    const output = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [id], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const found = output.trim().split(/\r?\n/).find(p => fs.existsSync(p));
    if (found) return found;
  } catch { /* GUI 启动环境可能不包含 CLI 所在目录。 */ }
  const home = os.homedir();
  const candidates = [path.join(home, '.local', 'bin', `${id}${process.platform === 'win32' ? '.exe' : ''}`)];
  if (process.platform === 'darwin') candidates.push(...macAgentCandidates(id, home));
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', `${id}.cmd`));
    if (id === 'codex') {
      const base = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
      try {
        const dirs = fs.readdirSync(base).map(name => path.join(base, name)).filter(p => fs.statSync(p).isDirectory()).sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        candidates.push(...dirs.map(p => path.join(p, 'codex.exe')));
      } catch { /* 未安装桌面版 */ }
    }
  }
  return candidates.find(p => fs.existsSync(p)) || null;
}

export function detectAgents() {
  return ['claude', 'codex'].filter(id => resolveAgent(id));
}

export function runProcess(cmd, args, { cwd, timeoutMs = 180_000, input = '', signal, onStage }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: agentEnvironment(process.env, process.platform, os.homedir()) });
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }); } catch { child.kill(); }
      } else child.kill('SIGKILL');
    };
    const abort = () => { if (settled) return; settled = true; clearTimeout(timer); stop(); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('close', () => signal?.removeEventListener('abort', abort));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { stop(); } catch { /* 已退出 */ }
        reject(new Error(`${cmd} 执行超时（${Math.round(timeoutMs / 1000)}s），已终止`));
      }
    }, timeoutMs);
    let pending = '', searches = 0;
    child.stdout?.on('data', (d) => {
      stdout = (stdout + d).slice(-2_000_000);
      pending += d;
      const lines = pending.split('\n'); pending = lines.pop().slice(-200000);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'item.started' && ev.item?.type === 'web_search') onStage?.('正在检索公开资料');
          if (ev.type === 'item.completed' && ev.item?.type === 'web_search') onStage?.(`已完成 ${++searches} 次检索，正在整理判断`);
        } catch { /* Other CLI output is not a progress event. */ }
      }
    });
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-20_000); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error(`无法启动 ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---- Claude Code headless: claude -p "<prompt>" --output-format json ----
async function runClaude(prompt, { cwd, timeoutMs, signal }) {
  const cmd = resolveAgent('claude');
  if (!cmd) throw new Error('未找到 Claude Code CLI。请先安装并登录，或在设置中配置 API 模型。');
  const { stdout, stderr, code } = await runProcess(cmd, ['-p', '--output-format', 'json', '--tools', ''], { cwd, timeoutMs, input: prompt, signal });
  if (code !== 0) throw new Error(`Claude Code 执行失败（${code}）：${stderr.slice(-500) || '请检查登录状态'}`);
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) throw new Error('Claude 分析未完成，请检查登录、额度与权限');
    const text = parsed.result ?? stdout;
    return String(text);
  } catch (err) {
    if (err instanceof SyntaxError) {
      if (!stdout.trim() && stderr.trim()) throw new Error(`claude 执行失败: ${stderr.trim().slice(0, 300)}`);
      return stdout; // 非 JSON 输出，按纯文本处理
    }
    throw err;
  }
}

// ---- Codex headless: codex exec --json --skip-git-repo-check "<prompt>" ----
async function runCodex(prompt, { cwd, timeoutMs, imagePath, search = false, signal, onStage }) {
  const cmd = resolveAgent('codex');
  if (!cmd) throw new Error('未找到 Codex CLI。请先安装并登录，或在设置中配置 API 模型。');
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'model_reasoning_effort="low"'];
  if (search) args.push('-c', 'web_search="live"');
  if (imagePath) args.push('-i', imagePath);
  args.push('-');
  const { stdout, stderr, code } = await runProcess(cmd, args, { cwd, timeoutMs, input: prompt, signal, onStage });
  if (code !== 0) throw new Error(`Codex 执行失败（${code}）：${stderr.slice(-500) || '请检查登录状态与额度'}`);
  // 宽松解析 JSONL：取最后一条 assistant 消息
  let lastText = '';
  let searchCount = 0;
  for (const line of stdout.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(l); } catch { continue; }
    if (ev.type === 'item.completed' && ev.item?.type === 'web_search') searchCount++;
    const candidates = ev.type === 'item.completed' && ev.item?.type === 'agent_message' ? [ev.item.text] : [];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) { lastText = c; break; }
    }
  }
  if (lastText) return { text: lastText, searchCount };
  if (code !== 0 && !stdout.trim()) throw new Error(`codex 执行失败: ${stderr.trim().slice(0, 300) || `exit ${code}`}`);
  throw new Error('Codex 未返回最终分析消息，请检查 CLI 登录状态与输出。');
}

// ---- Mock：离线演示引擎，按启发式生成结构化结论 ----
const TECH_DICT = {
  bun: { what: 'Bun 是一个一体化的 JavaScript 运行时和工具链', solves: '解决 Node 启动慢、装依赖慢的问题，内置打包器和测试器', tag: 'runtime' },
  deno: { what: 'Deno 是一个默认安全的 TypeScript 运行时', solves: '解决 Node 生态配置碎片化问题，开箱支持 TS 和权限控制', tag: 'runtime' },
  'node.js': { what: 'Node.js 是最主流的 JS 服务端运行时', solves: '让 JavaScript 可以写服务端和工具链', tag: 'runtime' },
  tauri: { what: 'Tauri 是用 Rust 构建桌面应用的框架', solves: '解决 Electron 内存占用大的问题，产物体积小一个量级', tag: 'desktop' },
  electron: { what: 'Electron 是用 Web 技术构建跨平台桌面应用的框架', solves: '让前端技能直接产出桌面应用，生态最成熟', tag: 'desktop' },
  mcp: { what: 'MCP（Model Context Protocol）是连接 LLM 与外部工具/数据的开放协议', solves: '解决每个工具都要为每个模型单独写集成的 N×M 问题', tag: 'agent' },
  llm: { what: 'LLM 是大规模语言模型', solves: '用自然语言驱动通用任务处理', tag: 'ai' },
  rag: { what: 'RAG 是检索增强生成技术', solves: '解决模型不知道私有/最新数据的问题', tag: 'ai' },
  vite: { what: 'Vite 是新一代前端构建工具', solves: '解决 Webpack 冷启动慢的问题', tag: 'frontend' },
  react: { what: 'React 是主流 UI 库', solves: '用组件化方式构建交互界面', tag: 'frontend' },
  svelte: { what: 'Svelte 是编译时框架', solves: '减少运行时开销，产物更小', tag: 'frontend' },
  htmx: { what: 'htmx 让 HTML 直接具备局部刷新等交互能力', solves: '不用写 JS 也能做出动态页面', tag: 'frontend' },
  supabase: { what: 'Supabase 是开源的 Firebase 替代品', solves: '快速获得数据库、认证和实时订阅', tag: 'backend' },
  docker: { what: 'Docker 是容器化标准', solves: '解决环境一致性与部署问题', tag: 'infra' },
  kubernetes: { what: 'Kubernetes 是容器编排系统', solves: '大规模容器的调度、扩缩容与自愈', tag: 'infra' },
  rust: { what: 'Rust 是无 GC 的系统级语言', solves: '内存安全 + 高性能', tag: 'language' },
  'ai agent': { what: 'AI Agent 指能自主规划并调用工具完成任务的智能体', solves: '把多步任务交给模型自动执行', tag: 'agent' },
};

// 技术类别归类：mock 的相关性判断靠类别重叠，而不是字面词命中
const STACK_CATS = {
  electron: ['desktop'], tauri: ['desktop'], qt: ['desktop'], wpf: ['desktop'],
  react: ['frontend'], vue: ['frontend'], svelte: ['frontend'], 'next.js': ['frontend'],
  nextjs: ['frontend'], nuxt: ['frontend'], astro: ['frontend'], vite: ['frontend'],
  webpack: ['frontend'], 'tailwind css': ['frontend'], tailwindcss: ['frontend'], htmx: ['frontend'],
  typescript: ['language'], javascript: ['language'], rust: ['language'], go: ['language'],
  python: ['language'],
  express: ['backend'], fastify: ['backend'], nestjs: ['backend'], django: ['backend'],
  fastapi: ['backend'], flask: ['backend'], supabase: ['backend'], postgresql: ['backend'],
  postgres: ['backend'], mongodb: ['backend'], 'prisma orm': ['backend'], typeorm: ['backend'],
  redis: ['infra'], docker: ['infra'], 'docker compose': ['infra'], kubernetes: ['infra'],
  bun: ['runtime'], deno: ['runtime'], 'node.js': ['runtime'],
};

function stackCategories(stack = [], deps = []) {
  const cats = new Set();
  for (const item of [...stack, ...deps.map((d) => d.name)]) {
    const k = String(item).toLowerCase().trim();
    for (const c of STACK_CATS[k] || []) cats.add(c);
  }
  return cats;
}

function mockTerms(normalized) {
  const text = `${normalized.ref} ${normalized.text} ${normalized.meta?.title || ''}`.toLowerCase();
  if (normalized.type === 'image') {
    return {
      terms: [{ term: '截图中的技术（演示）', what: '演示引擎无法真正识别截图内容，这条结果仅用于展示界面与分析结构。', solves: '安装 Claude Code 或 Codex 后，截图将由真实模型识别。' }],
      tags: [],
    };
  }
  const hits = Object.keys(TECH_DICT).filter((k) => text.includes(k)).slice(0, 3);
  if (hits.length) {
    return {
      terms: hits.map((k) => ({
        term: TECH_DICT[k].what.match(/[A-Za-z][A-Za-z.]*|[\u4e00-\u9fa5]+/)[0],
        what: TECH_DICT[k].what,
        solves: TECH_DICT[k].solves,
      })),
      tags: [...new Set(hits.map((k) => TECH_DICT[k].tag))],
    };
  }
  // 没命中词典：取输入里最像技术名词的词组
  const quoted = normalized.text.match(/[`«"“]([^`»"”]{2,30})[`»"”]/);
  const fallback = quoted ? quoted[1] : (normalized.ref || normalized.text).split(/[\s,，。.]+/).filter((w) => w.length >= 2).slice(0, 3).join(' ');
  const term = (fallback || '未知技术').slice(0, 40);
  return {
    terms: [{ term, what: `「${term}」是演示引擎未收录的对象。`, solves: '安装真实 Agent CLI 后可获得准确解释。' }],
    tags: [],
  };
}

function mockAnalysis({ normalized, contexts }) {
  const { terms, tags } = mockTerms(normalized);
  const projects = contexts.map((c) => {
    const cats = stackCategories(c.stack, c.keyDeps);
    const text = `${c.goal} ${c.focus} ${c.stack.join(' ')} ${c.keyDeps.map((d) => d.name).join(' ')} ${c.name}`.toLowerCase();
    const termWords = terms.flatMap((t) => t.term.toLowerCase().split(/\s+/)).filter((w) => w.length >= 3);
    const wordHits = termWords.filter((w) => text.includes(w));
    const catOverlap = [...cats].filter((x) => tags.includes(x));
    const stackHit = c.stack.some((s) => terms.some((t) => s.toLowerCase().includes(t.term.toLowerCase()) || t.term.toLowerCase().includes(s.toLowerCase())));
    const rel = (catOverlap.length > 0 || stackHit || wordHits.length >= 2) ? 'high' : wordHits.length === 1 ? 'medium' : 'low';
    const verdict = rel === 'high' ? 'try_now' : rel === 'medium' ? 'later' : 'ignore';
    const name = c.name || c.projectId;
    return {
      projectId: c.projectId,
      relevance: rel,
      verdict,
      reasoning: rel === 'low'
        ? `「${terms[0].term}」与「${name}」（${c.stack.slice(0, 3).join('/') || '技术栈未知'}）没有直接交集，${c.goal ? `项目目标是「${c.goal.slice(0, 60)}」` : '暂无明确目标描述'}，当前引入只会增加心智负担。`
        : `「${terms[0].term}」与「${name}」的技术栈（${c.stack.slice(0, 4).join('/') || '未识别'}）存在重叠${catOverlap.length ? `，同属「${catOverlap.join('/')}」方向` : wordHits.length ? `，命中的关键词：${wordHits.join('、')}` : ''}。`,
      role: {
        fit: rel === 'low' ? `当前「${name}」里没有它的适用位置。` : `可以用在「${name}」的${stackHit ? '现有技术栈升级' : '构建/工具链环节'}。`,
        replaces: rel === 'high' ? `可能替代「${name}」现有的部分构建或运行时组件` : null,
        complements: rel !== 'low' ? '补充工具链能力' : null,
        cost: rel === 'high' ? '低成本：新增依赖，可在分支验证' : rel === 'medium' ? '中等：需要调研后评估' : null,
      },
      tryAction: verdict === 'try_now' ? `在「${name}」里开一个分支，用 30 分钟跑通「${terms[0].term}」官方的 quickstart，判断是否值得进入正式评估。` : null,
      futureTrigger: verdict !== 'try_now' ? `当「${name}」${rel === 'medium' ? '遇到相关性能/工程痛点，或现有工具链明显不足' : '扩展到与此相关的场景（如桌面端/后端/基础设施）'}时，再评估「${terms[0].term}」。` : null,
    };
  });
  return {
    terms,
    projects,
    missing: [],
  };
}

function mockEnhance({ scan }) {
  const s = scan || '';
  const name = s.match(/^项目名:\s*(.+)$/m)?.[1]?.trim() || '未命名项目';
  const desc = s.match(/^描述:\s*(.+)$/m)?.[1]?.trim() || '';
  const stack = (s.match(/^检测到的技术栈:\s*(.+)$/m)?.[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const deps = (s.match(/^依赖:\s*(.+)$/m)?.[1] || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6);
  const readmeHead = (s.match(/README 节选:\n([\s\S]{0,300})/)?.[1] || '').replace(/[#*`>\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    name,
    goal: desc || readmeHead || '（未能从扫描中提取目标，请手动补充）',
    stage: 'prototype',
    stack,
    keyDeps: deps.map((n) => ({ name: n, why: '' })),
    focus: '',
    constraints: [],
  };
}

export async function runAgentPrompt({ agentId, prompt, cwd, timeoutMs, meta = {}, signal, onStage }) {
  signal?.throwIfAborted();
  if (agentId === 'claude') {
    if (meta.normalized?.type === 'image') throw new Error('Claude Code 当前适配器尚未验证图片传入，请改用 Codex 或支持图片的 API 模型。');
    return { text: await runClaude(prompt, { cwd, timeoutMs, signal }), agentId };
  }
  if (agentId === 'codex') return { ...await runCodex(prompt, { cwd, timeoutMs, signal, onStage, search: ['research', 'analysis_search'].includes(meta.purpose), imagePath: meta.normalized?.type === 'image' ? meta.normalized.meta.path : undefined }), agentId };
  if (agentId === 'mock') {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 500)); // 模拟真实延迟
    signal?.throwIfAborted();
    if (meta.purpose === 'enhance') return { text: JSON.stringify(mockEnhance(meta)), agentId };
    return { text: JSON.stringify(mockAnalysis(meta)), agentId };
  }
  throw new Error(`未知 agent: ${agentId}`);
}

// 按优先级跑一条 agent 链：真实 agent 失败自动降级，链尾是 mock
export async function runAgentChain(chain, { prompt, cwd, timeoutMs, meta, signal, onStage }) {
  const errors = [];
  for (let i = 0; i < chain.length; i++) {
    const agentId = chain[i];
    try {
      const r = await runAgentPrompt({ agentId, prompt, cwd, timeoutMs, meta, signal, onStage });
      return { ...r, fellBack: i > 0 };
    } catch (err) {
      signal?.throwIfAborted();
      errors.push(`[${agentId}] ${err.message}`);
    }
  }
  throw new Error(`所有 agent 尝试失败：\n${errors.join('\n')}`);
}
