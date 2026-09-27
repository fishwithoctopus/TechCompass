// lib/server.js — 本地 HTTP 服务：卡片 UI 的唯一后端。
// 绑定 127.0.0.1，/api/* 需要 token（X-TC-Token 或 ?token=），静态 /ui 无敏感数据。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Store, newId } from './store.js';
import { Pipeline, PipelineError } from './pipeline.js';
import { Jobs } from './jobs.js';
import { createVault, validateProvider, runProvider, providerRunner } from './provider.js';
import { detectAgents, AGENT_INFO } from './agentbridge.js';
import { scanProject, draftContextFromScan } from './scanner.js';
import {
  validateContext, sanitizeContext, ACCURACY_OPTIONS, INTENT_OPTIONS, sanitizeAnalysis,
} from './contracts.js';
import { checkRegistrations, registerFor, unregisterFor, SUPPORTED_AGENTS, mcpEntry } from './installer.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_DIR = path.join(__dirname, '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};

export function createApp({ dataDir, uiDir = DEFAULT_UI_DIR, port: preferredPort, encryption } = {}) {
  const store = new Store(dataDir);
  const vault = createVault(store.dir, encryption);
  const pipeline = new Pipeline({ store, runner: providerRunner(store, vault) });
  const jobs = new Jobs();
  const token = store.token();
  const state = { version: VERSION, dataDir: store.dir };

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  function readBody(req, limit = 12 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch { reject(new Error('JSON 解析失败')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(res, urlPath) {
    const rel = urlPath.replace(/^\/ui\/?/, '') || 'index.html';
    const file = path.normalize(path.join(uiDir, rel));
    if (!file.startsWith(path.resolve(uiDir) + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  }

  const projectsPayload = () => {
    const { projects, contexts } = store.readData();
    return projects.map((p) => ({ ...p, context: contexts[p.id] || null }));
  };

  async function handleApi(req, res, pathname, query) {
    const method = req.method;

    // ---- 无需鉴权 ----
    if (method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, ...state });

    // ---- 鉴权 ----
    const gotToken = req.headers['x-tc-token'] || query.get('token');
    if (gotToken !== token) return json(res, 401, { error: '未授权（token 不匹配）' });

    if (method === 'GET' && pathname === '/api/state') {
      const settings = store.getSettings();
      return json(res, 200, {
        ...state, token, projects: projectsPayload(), analysesCount: store.listAnalyses(500).length,
        agents: { detected: detectAgents(), preferred: settings.preferredAgents, info: AGENT_INFO },
        mcp: { supported: SUPPORTED_AGENTS, registrations: checkRegistrations(), entry: mcpEntry(path.join(__dirname, '..', 'mcp', 'server.js')) },
        settings, apiKeyConfigured: vault.has(), apiKeyPersistent: vault.persistent,
      });
    }

    // ---- MCP 注册（只改用户勾选的 Agent，改前自动备份） ----
    if (method === 'GET' && pathname === '/api/mcp/status') {
      return json(res, 200, { supported: SUPPORTED_AGENTS, registrations: checkRegistrations() });
    }
    if (method === 'POST' && pathname === '/api/mcp/register') {
      const body = await readBody(req);
      const agents = Array.isArray(body.agents) ? body.agents.filter((a) => SUPPORTED_AGENTS.includes(a)) : [];
      if (!agents.length) return json(res, 400, { error: '未选择要接入的 Agent', supported: SUPPORTED_AGENTS });
      try {
        const { results } = await registerFor(agents, { mcpServerPath: path.join(__dirname, '..', 'mcp', 'server.js'), probe: body.probe !== false });
        return json(res, 200, {
          results,
          note: '写入前先校验并备份。请逐项查看写入、连通性以及备份状态；若写后校验失败，保留现场，不覆盖其他程序的修改。重启对应 Agent 后生效。',
        });
      } catch (err) {
        return json(res, 500, { error: `注册失败: ${err.message}` });
      }
    }
    if (method === 'POST' && pathname === '/api/mcp/unregister') {
      const body = await readBody(req);
      const agents = Array.isArray(body.agents) ? body.agents.filter((a) => SUPPORTED_AGENTS.includes(a)) : [];
      if (!agents.length) return json(res, 400, { error: '未选择 Agent', supported: SUPPORTED_AGENTS });
      const { results } = unregisterFor(agents);
      return json(res, 200, { results });
    }

    if (method === 'POST' && pathname === '/api/analyze') {
      const body = await readBody(req);
      const { type, value } = body.input || {};
      if (!['text', 'link', 'image'].includes(type) || !value) return json(res, 400, { error: 'input.type/value 不合法' });
      if (body.agentId && !['claude', 'codex', 'mock', 'api'].includes(body.agentId)) return json(res, 400, { error: '未知分析模型' });
      const agentId = body.agentId || undefined;
      const jobId = jobs.create(async (setStage) => {
        const r = await pipeline.analyze({ type, value, onStage: setStage }, { agentId, noCache: body.noCache });
        return r;
      });
      return json(res, 202, { jobId });
    }

    if (method === 'GET' && pathname.startsWith('/api/jobs/')) {
      const job = jobs.get(pathname.split('/').pop());
      if (!job) return json(res, 404, { error: '任务不存在（服务可能已重启），请重试' });
      const { id, status, stage, result, error, errors } = job;
      return json(res, 200, { id, status, stage, result, error, errors: errors || undefined });
    }

    if (method === 'GET' && pathname === '/api/analyses') {
      const limit = Math.min(Number(query.get('limit')) || 30, 100);
      return json(res, 200, { analyses: store.listAnalyses(limit) });
    }

    if (method === 'GET' && pathname.startsWith('/api/analyses/')) {
      const a = store.getAnalysis(pathname.split('/').pop());
      if (!a) return json(res, 404, { error: '分析不存在' });
      return json(res, 200, { analysis: a, feedback: store.listFeedback(a.id) });
    }

    if (method === 'POST' && pathname === '/api/feedback') {
      const body = await readBody(req);
      const { analysisId, projectId } = body;
      const accuracy = ACCURACY_OPTIONS.includes(body.accuracy) ? body.accuracy : null;
      const intent = INTENT_OPTIONS.includes(body.intent) ? body.intent : null;
      if (!analysisId || !projectId || !accuracy || !intent) return json(res, 400, { error: '参数不完整（analysisId/projectId/accuracy/intent）' });
      const analysis = store.getAnalysis(analysisId);
      if (!analysis) return json(res, 404, { error: '分析不存在' });
      const verdict = analysis.result.projects.find((p) => p.projectId === projectId)?.verdict || null;
      if (!verdict) return json(res, 400, { error: '此项目不属于该分析' });
      if (body.remember === true) {
        const context = store.getContexts().find(c => c.projectId === projectId);
        const note = String(body.note || '').trim().slice(0, 500);
        if (note.length > 190) return json(res, 400, { error: '需要记住的项目事实请控制在 190 字内' });
        if (!context || !note) return json(res, 400, { error: '请填写要记住的项目事实或约束，且项目仍需存在' });
        const constraint = `用户确认：${note}`;
        if (!(context.constraints || []).includes(constraint)) {
          if ((context.constraints || []).length >= 10) return json(res, 400, { error: '项目约束已达 10 条，请先在项目中整理后再记住新事实' });
          await store.saveContext({ ...context, constraints: [...(context.constraints || []), constraint] });
        }
      }
      await store.addFeedback({
        analysisId, projectId, accuracy, intent,
          note: String(body.note || '').slice(0, 500),
          remembered: body.remember === true,
        verdictAtAnalysis: verdict,
        createdAt: new Date().toISOString(),
      });
      return json(res, 200, { ok: true });
    }

    // ---- 项目 ----
    if (method === 'POST' && pathname === '/api/projects/scan') {
      const body = await readBody(req);
      let scan;
      try { scan = scanProject(String(body.path || '')); } catch (err) { return json(res, 400, { error: err.message }); }
      const condensed = {
        dir: scan.dir, name: scan.name, pkgJson: scan.pkgJson, files: scan.files,
        stackHints: scan.stackHints, gitLog: scan.gitLog ? scan.gitLog.split('\n').slice(0, 8).join('\n') : null,
        treePreview: (scan.tree || '').split('\n').slice(0, 15).join('\n'),
      };
      return json(res, 200, { scan: condensed, draft: draftContextFromScan(scan, '') });
    }

    if (method === 'POST' && pathname === '/api/projects/enhance') {
      const body = await readBody(req);
      let scan;
      try { scan = scanProject(String(body.path || '')); } catch (err) { return json(res, 400, { error: err.message }); }
      const jobId = jobs.create(async (setStage) => {
        setStage('读取项目并提取上下文');
        return pipeline.enhance(scan, { agentId: body.agentId });
      });
      return json(res, 202, { jobId });
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const body = await readBody(req);
      if (!body.path || !body.context) return json(res, 400, { error: 'path/context 必填' });
      const errs = validateContext({ ...body.context, projectId: 'x' }).filter((e) => !e.startsWith('context.projectId'));
      if (errs.length) return json(res, 400, { error: 'context 不合法', errors: errs });
      const { projects } = store.readData();
      let project = projects.find((p) => p.path === path.resolve(body.path));
      if (!project) {
        project = { id: newId('pj'), path: path.resolve(body.path), createdAt: new Date().toISOString() };
        await store.upsertProject(project);
      }
      const ctx = sanitizeContext({ ...body.context, projectId: project.id });
      await store.saveContext(ctx);
      return json(res, 200, { project, context: { ...store.readData().contexts[project.id] } });
    }

    if (method === 'GET' && pathname === '/api/projects') {
      return json(res, 200, { projects: projectsPayload() });
    }

    const pjMatch = pathname.match(/^\/api\/projects\/([^/]+)(\/refresh)?$/);
    if (pjMatch) {
      const pid = pjMatch[1];
      const project = store.getProjects().find((p) => p.id === pid);
      if (!project) return json(res, 404, { error: '项目不存在' });

      if (method === 'PUT' && !pjMatch[2]) {
        const body = await readBody(req);
        if (typeof body.enabled === 'boolean' && !body.context) {
          await store.upsertProject({ ...project, enabled: body.enabled });
          return json(res, 200, { ok: true });
        }
        const errs = validateContext({ ...body.context, projectId: pid });
        if (errs.length) return json(res, 400, { error: 'context 不合法', errors: errs });
        await store.saveContext(sanitizeContext({ ...body.context, projectId: pid }));
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && pjMatch[2] === '/refresh') {
        const body = await readBody(req);
        const jobId = jobs.create(async (setStage) => {
          setStage('重新扫描项目');
          const scan = scanProject(project.path);
          setStage('AI 提取上下文');
          const { draft, agentUsed } = await pipeline.enhance(scan, { agentId: body.agentId });
          const confirmed = (store.readData().contexts[pid]?.constraints || []).filter(c => c.startsWith('用户确认：'));
          draft.constraints = [...new Set([...confirmed, ...(draft.constraints || [])])].slice(0, 10);
          await store.saveContext(sanitizeContext({ ...draft, projectId: pid, name: draft.name || project.name, source: 'enhance' }));
          return { projectId: pid, agentUsed, context: store.readData().contexts[pid] };
        });
        return json(res, 202, { jobId });
      }
      if (method === 'DELETE') {
        await store.removeProject(pid);
        return json(res, 200, { ok: true });
      }
    }

    if (method === 'PUT' && pathname === '/api/settings') {
      const body = await readBody(req);
      const patch = {};
      if (Array.isArray(body.preferredAgents)) {
          const ok = body.preferredAgents.filter((a) => ['claude', 'codex', 'api'].includes(a));
        if (!ok.length) return json(res, 400, { error: 'preferredAgents 至少含一个合法 agent' });
        patch.preferredAgents = ok;
      }
      await store.updateSettings(patch);
        return json(res, 200, { settings: store.getSettings() });
      }

      if (pathname === '/api/provider' && method === 'PUT') {
        const body = await readBody(req);
        const provider = validateProvider(body);
        const previous = store.getSettings().apiProvider;
        if (previous?.baseUrl !== provider.baseUrl && !body.apiKey) return json(res, 400, { error: '更换 API 地址时必须重新填写 API Key，避免把旧密钥发送给新服务' });
        if (body.apiKey) vault.set(body.apiKey);
        if (!vault.has()) return json(res, 400, { error: '请填写 API Key' });
        await store.updateSettings({ apiProvider: { ...provider, revision: Date.now() } });
        return json(res, 200, { ok: true, persistent: vault.persistent });
      }
      if (pathname === '/api/provider' && method === 'DELETE') {
        vault.clear();
        await store.updateSettings({ apiProvider: null, preferredAgents: ['codex', 'claude'] });
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/provider/test' && method === 'POST') {
        await runProvider({ provider: store.getSettings().apiProvider, key: vault.get(), prompt: 'Reply with OK only.', timeoutMs: 20_000 });
        return json(res, 200, { ok: true });
      }

    return json(res, 404, { error: '接口不存在' });
  }

  function requestHandler(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const pathname = u.pathname;
    Promise.resolve()
      .then(() => {
        if (pathname.startsWith('/api/') || pathname === '/health') return handleApi(req, res, pathname, u.searchParams);
        if (pathname === '/') { res.writeHead(302, { location: '/ui/' }); res.end(); return; }
        if (pathname.startsWith('/ui')) return serveStatic(res, pathname);
        res.writeHead(404); res.end('Not Found');
      })
      .catch((err) => {
        if (err instanceof PipelineError) return json(res, 502, { error: err.message, errors: err.errors });
        json(res, 500, { error: err?.message || String(err) });
      });
  }

  return {
    store, pipeline, jobs, token,
    listen({ host = '127.0.0.1', port = preferredPort } = {}) {
      return new Promise((resolve, reject) => {
        const server = http.createServer(requestHandler);
        const tryPort = (p, attemptsLeft = 12) => {
          server.once('error', (err) => {
            if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryPort(p + 1, attemptsLeft - 1);
            else reject(err);
          });
          server.listen(p, host, () => resolve({ server, port: server.address().port }));
        };
        const settingsPort = port ?? store.getSettings().port;
        tryPort(settingsPort);
      });
    },
  };
}

  export async function startDaemon({ dataDir, uiDir, port, encryption } = {}) {
    const app = createApp({ dataDir, uiDir, port, encryption });
  const { server, port: actualPort } = await app.listen({});
  return { app, server, port: actualPort, token: app.token, stop: () => new Promise((r) => server.close(r)) };
}
