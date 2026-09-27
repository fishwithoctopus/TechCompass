// lib/store.js — 本地存储。设计取舍：
// - 纯 JS、零 native 依赖（Electron/Windows 打包无 native 模块风险）
// - data.json（项目+设置，原子写）+ analyses.jsonl（追加）+ feedback.jsonl（追加）
// - 跨进程（daemon 与 MCP server 同时写）用 O_EXCL 文件锁串行化，写入量极小，够用
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function defaultDataDir(env = process.env) {
  if (env.TECHCOMPASS_HOME) return env.TECHCOMPASS_HOME;
  return path.join(os.homedir(), '.techcompass');
}

const LOCK_STALE_MS = 30_000;
const LOCK_MAX_WAIT_MS = 15_000;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.dataPath = path.join(dir, 'data.json');
    this.lockPath = path.join(dir, '.lock');
    this.analysesPath = path.join(dir, 'analyses.jsonl');
    this.feedbackPath = path.join(dir, 'feedback.jsonl');
    this.tmpDir = path.join(dir, 'tmp');
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  // ---------- 锁 ----------
  async withLock(fn) {
    const start = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeSync(fd, String(process.pid));
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // 陈锁检测
        try {
          const st = fs.statSync(this.lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) fs.rmSync(this.lockPath, { force: true });
        } catch { /* 锁刚好被释放 */ }
        if (Date.now() - start > LOCK_MAX_WAIT_MS) throw new Error('存储锁等待超时');
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    try {
      return await fn();
    } finally {
      try { fs.rmSync(this.lockPath, { force: true }); } catch { /* 尽力而为 */ }
    }
  }

  // ---------- data.json ----------
  readData() {
    try {
      const raw = fs.readFileSync(this.dataPath, 'utf8');
      const d = JSON.parse(raw);
      return {
        projects: Array.isArray(d.projects) ? d.projects : [],
        contexts: d.contexts && typeof d.contexts === 'object' ? d.contexts : {},
        settings: d.settings && typeof d.settings === 'object' ? d.settings : {},
      };
    } catch {
      return { projects: [], contexts: {}, settings: {} };
    }
  }

  async mutateData(fn) {
    return this.withLock(async () => {
      const data = this.readData();
      const result = fn(data);
      const next = result !== undefined ? result : data;
      const tmp = this.dataPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tmp, this.dataPath);
      return next;
    });
  }

  // ---------- 项目 ----------
  async upsertProject(p) {
    return this.mutateData((d) => {
      const i = d.projects.findIndex((x) => x.id === p.id);
      if (i >= 0) d.projects[i] = { ...d.projects[i], ...p };
      else d.projects.push(p);
      return d;
    });
  }

  async removeProject(id) {
    return this.mutateData((d) => {
      d.projects = d.projects.filter((x) => x.id !== id);
      delete d.contexts[id];
      return d;
    });
  }

  async saveContext(ctx) {
    return this.mutateData((d) => {
      d.contexts[ctx.projectId] = { ...ctx, version: (d.contexts[ctx.projectId]?.version || 0) + 1, updatedAt: new Date().toISOString() };
      return d;
    });
  }

  getContexts() {
    const { projects, contexts } = this.readData();
    return projects.filter(p => p.enabled !== false).map((p) => contexts[p.id] || null).filter(Boolean);
  }

  getProjects() {
    return this.readData().projects;
  }

  getSettings() {
    const d = this.readData();
    return {
      port: 47423,
      preferredAgents: ['claude', 'codex'],
      ...d.settings,
    };
  }

  async updateSettings(patch) {
    return this.mutateData((d) => {
      d.settings = { ...d.settings, ...patch };
      return d;
    });
  }

  // ---------- analyses ----------
  async appendAnalysis(row) {
    return this.withLock(async () => {
      fs.appendFileSync(this.analysesPath, JSON.stringify(row) + '\n', 'utf8');
      // 只保留最近 500 条
      try {
        const lines = fs.readFileSync(this.analysesPath, 'utf8').split('\n').filter(Boolean);
        if (lines.length > 500) fs.writeFileSync(this.analysesPath, lines.slice(-500).join('\n') + '\n', 'utf8');
      } catch { /* 忽略 */ }
      return row.id;
    });
  }

  listAnalyses(limit = 30) {
    try {
      const lines = fs.readFileSync(this.analysesPath, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).reverse().map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  getAnalysis(id) {
    return this.listAnalyses(500).find((a) => a.id === id) || null;
  }

  // ---------- feedback ----------
  async addFeedback(row) {
    return this.withLock(async () => {
      fs.appendFileSync(this.feedbackPath, JSON.stringify(row) + '\n', 'utf8');
      return true;
    });
  }

  listFeedback(analysisId = null) {
    try {
      const lines = fs.readFileSync(this.feedbackPath, 'utf8').split('\n').filter(Boolean);
      let rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (analysisId) rows = rows.filter((r) => r.analysisId === analysisId);
      return rows;
    } catch { return []; }
  }

  // ---------- token ----------
  token() {
    const p = path.join(this.dir, 'token');
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch { /* 生成新的 */ }
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(p, t, { encoding: 'utf8', mode: 0o600 });
    return t;
  }
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}
