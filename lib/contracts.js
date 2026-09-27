// lib/contracts.js — TechCompass 的两份核心契约：项目上下文 & 分析输出
// 这两个 schema 是产品的心脏：卡片、daemon、MCP、prompt 全部围绕它们工作。

export const CONTEXT_VERSION = 1;
export const PROMPT_VERSION = 'v2-identity';

export const STAGES = ['idea', 'prototype', 'mvp', 'growth', 'mature', 'maintenance'];
export const STAGE_LABELS = {
  idea: '想法', prototype: '原型', mvp: 'MVP', growth: '增长', mature: '成熟', maintenance: '维护',
};
export const RELEVANCE_LEVELS = ['high', 'medium', 'low'];
export const VERDICTS = ['try_now', 'later', 'ignore'];
export const VERDICT_LABELS = { try_now: '现在值得尝试', later: '以后再看', ignore: '当前可以忽略' };
export const RELEVANCE_LABELS = { high: '高度相关', medium: '部分相关', low: '基本无关' };
export const ACCURACY_OPTIONS = ['match', 'partial', 'mismatch'];
export const ACCURACY_LABELS = { match: '符合项目', partial: '部分符合', mismatch: '理解有误' };
export const INTENT_OPTIONS = ['try', 'later', 'pass'];
export const INTENT_LABELS = { try: '想尝试', later: '以后再说', pass: '不考虑' };

// ---------- 校验工具 ----------

class ErrList {
  constructor() { this.items = []; }
  add(path, msg) { this.items.push(`${path}: ${msg}`); }
  get ok() { return this.items.length === 0; }
}

function vStr(e, obj, key, path, { required = true, maxLen = 600, allowEmpty = false } = {}) {
  const v = obj?.[key];
  if (v == null || v === '') {
    if (required && !allowEmpty) e.add(`${path}.${key}`, '缺失或为空');
    return;
  }
  if (typeof v !== 'string') { e.add(`${path}.${key}`, '应为字符串'); return; }
  const t = v.trim();
  if (!t && !allowEmpty) { e.add(`${path}.${key}`, '不能为空白'); return; }
  if (t.length > maxLen) e.add(`${path}.${key}`, `过长（>${maxLen} 字）`);
}

function vEnum(e, obj, key, path, values, { required = true } = {}) {
  const v = obj?.[key];
  if (v == null) { if (required) e.add(`${path}.${key}`, '缺失'); return; }
  if (!values.includes(v)) e.add(`${path}.${key}`, `应为 ${values.join('/')} 之一，实际为 ${JSON.stringify(v)}`);
}

function vStrArray(e, obj, key, path, { required = true, maxItems = 20, maxLen = 200 } = {}) {
  const v = obj?.[key];
  if (v == null) { if (required) e.add(`${path}.${key}`, '缺失'); return; }
  if (!Array.isArray(v)) { e.add(`${path}.${key}`, '应为数组'); return; }
  if (v.length === 0 && required) { e.add(`${path}.${key}`, '不能为空数组'); return; }
  if (v.length > maxItems) e.add(`${path}.${key}`, `条目过多（>${maxItems}）`);
  v.forEach((item, i) => {
    if (typeof item !== 'string' || !item.trim()) e.add(`${path}.${key}[${i}]`, '应为非空字符串');
    else if (item.trim().length > maxLen) e.add(`${path}.${key}[${i}]`, `过长（>${maxLen} 字）`);
  });
}

// ---------- 项目上下文契约 ----------

export function validateContext(ctx) {
  const e = new ErrList();
  if (!ctx || typeof ctx !== 'object') return ['context: 应为对象'];
  vStr(e, ctx, 'projectId', 'context');
  vStr(e, ctx, 'name', 'context', { maxLen: 80 });
  vStr(e, ctx, 'goal', 'context', { maxLen: 300 });
  vEnum(e, ctx, 'stage', 'context', STAGES);
  vStrArray(e, ctx, 'stack', 'context', { maxItems: 15 });
  const deps = ctx.keyDeps;
  if (deps == null) e.add('context.keyDeps', '缺失');
  else if (!Array.isArray(deps)) e.add('context.keyDeps', '应为数组');
  else {
    if (deps.length > 10) e.add('context.keyDeps', '条目过多（>10）');
    deps.forEach((d, i) => {
      if (!d || typeof d !== 'object') { e.add(`context.keyDeps[${i}]`, '应为对象'); return; }
      vStr(e, d, 'name', `context.keyDeps[${i}]`, { maxLen: 80 });
      vStr(e, d, 'why', `context.keyDeps[${i}]`, { maxLen: 150, required: false, allowEmpty: true });
    });
  }
  vStr(e, ctx, 'focus', 'context', { maxLen: 300, required: false, allowEmpty: true });
  vStrArray(e, ctx, 'constraints', 'context', { required: false, maxItems: 10 });
  return e.items;
}

export function sanitizeContext(ctx) {
  const SOURCE = ['scan', 'agent', 'manual', 'enhance'];
  return {
    projectId: String(ctx.projectId),
    name: String(ctx.name || '未命名项目').slice(0, 80),
    goal: String(ctx.goal || '').slice(0, 300),
    stage: STAGES.includes(ctx.stage) ? ctx.stage : 'prototype',
    stack: (Array.isArray(ctx.stack) ? ctx.stack : []).map(String).slice(0, 15),
    keyDeps: (Array.isArray(ctx.keyDeps) ? ctx.keyDeps : []).filter(Boolean).slice(0, 10)
      .map((d) => ({ name: String(d.name || '').slice(0, 80), why: String(d.why || '').slice(0, 150) })),
    focus: String(ctx.focus || '').slice(0, 300),
    constraints: (Array.isArray(ctx.constraints) ? ctx.constraints : []).map(String).slice(0, 10),
    // 来源标注：推断/扫描的内容不能伪装成用户确认过的事实
    source: SOURCE.includes(ctx.source) ? ctx.source : 'manual',
  };
}

// ---------- 分析输出契约 ----------

export function validateAnalysis(out, projectIds = null) {
  const e = new ErrList();
  if (!out || typeof out !== 'object') return ['analysis: 应为 JSON 对象'];
  const unresolved = ['unverified', 'ambiguous'].includes(out.identityStatus);
  if (out.identityStatus != null) vEnum(e, out, 'identityStatus', 'analysis', ['identified', 'unverified', 'ambiguous']);
  // terms: 1..3
  const terms = out.terms;
  if (!Array.isArray(terms) || terms.length === 0) e.add('terms', '缺失或为空');
  else {
    if (terms.length > 3) e.add('terms', '核心词过多（>3）');
    terms.forEach((t, i) => {
      const p = `terms[${i}]`;
      if (!t || typeof t !== 'object') { e.add(p, '应为对象'); return; }
      vStr(e, t, 'term', p, { maxLen: 60 });
      vStr(e, t, 'what', p, { maxLen: 200 });
      vStr(e, t, 'solves', p, { maxLen: 200 });
    });
  }
  // projects: 每个已注册项目恰好一条
  const ps = out.projects;
  if (!Array.isArray(ps)) e.add('projects', '缺失或非数组');
  else {
    if (unresolved && ps.length) e.add('projects', '技术身份未确认时不得给出项目判断');
    if (projectIds && !unresolved) {
      const got = new Set(ps.map((p) => p?.projectId));
      for (const id of projectIds) if (!got.has(id)) e.add('projects', `缺少项目 ${id} 的判断`);
    }
    ps.forEach((p, i) => {
      const base = `projects[${i}]`;
      if (!p || typeof p !== 'object') { e.add(base, '应为对象'); return; }
      vStr(e, p, 'projectId', base, { maxLen: 60 });
      vEnum(e, p, 'relevance', base, RELEVANCE_LEVELS);
      vEnum(e, p, 'verdict', base, VERDICTS);
      vStr(e, p, 'reasoning', base, { maxLen: 600 });
      // role: fit 必填；无适用位置时 fit 要明说
      const r = p.role;
      if (!r || typeof r !== 'object') e.add(`${base}.role`, '缺失或非对象');
      else {
        vStr(e, r, 'fit', `${base}.role`, { maxLen: 300 });
        for (const k of ['replaces', 'complements', 'cost']) {
          vStr(e, r, k, `${base}.role`, { required: false, allowEmpty: true, maxLen: 300 });
        }
      }
      // 业务规则：建议与动作/触发条件必须配套
      if (p.verdict === 'try_now' && !p.tryAction) e.add(`${base}.tryAction`, 'verdict=try_now 时必须给出验证动作');
      if ((p.verdict === 'later' || p.verdict === 'ignore') && !p.futureTrigger) {
        e.add(`${base}.futureTrigger`, `verdict=${p.verdict} 时必须给出未来适用情境`);
      }
      if (p.tryAction && String(p.tryAction).length > 600) e.add(`${base}.tryAction`, '过长（>600 字）');
      if (p.futureTrigger && String(p.futureTrigger).length > 600) e.add(`${base}.futureTrigger`, '过长（>600 字）');
    });
  }
  // missing: 可选，最多 5 条
  if (out.missing != null) {
    vStrArray(e, out, 'missing', 'analysis', { required: false, maxItems: 5, maxLen: 200 });
  }
  return e.items;
}

export function sanitizeAnalysis(out) {
  return {
    identityStatus: ['unverified', 'ambiguous'].includes(out.identityStatus) ? out.identityStatus : 'identified',
    terms: (out.terms || []).slice(0, 3).map((t) => ({
      term: String(t.term || '').slice(0, 60),
      what: String(t.what || '').slice(0, 200),
      solves: String(t.solves || '').slice(0, 200),
    })),
    projects: (out.projects || []).map((p) => ({
      projectId: String(p.projectId || ''),
      relevance: RELEVANCE_LEVELS.includes(p.relevance) ? p.relevance : 'low',
      verdict: VERDICTS.includes(p.verdict) ? p.verdict : 'later',
      reasoning: String(p.reasoning || '').slice(0, 600),
      role: {
        fit: String(p.role?.fit || '').slice(0, 300),
        replaces: p.role?.replaces ? String(p.role.replaces).slice(0, 300) : null,
        complements: p.role?.complements ? String(p.role.complements).slice(0, 300) : null,
        cost: p.role?.cost ? String(p.role.cost).slice(0, 300) : null,
      },
      tryAction: p.tryAction ? String(p.tryAction).slice(0, 600) : null,
      futureTrigger: p.futureTrigger ? String(p.futureTrigger).slice(0, 600) : null,
    })),
    missing: (out.missing || []).map(String).slice(0, 5),
  };
}

// Evidence gates run before validation/persistence, not merely as a visual disclaimer.
export function applyEvidenceGate(out, research, contexts) {
  if (!out || typeof out !== 'object') return out;
  const identityStatus = research?.status === 'no_results' ? 'unverified'
    : research?.ambiguous ? 'ambiguous'
    : ['unverified', 'ambiguous'].includes(out.identityStatus) ? out.identityStatus : 'identified';
  return { ...out, identityStatus, projects: identityStatus !== 'identified' || contexts.length === 0 ? [] : out.projects };
}

// ---------- 从 LLM 输出中提取 JSON ----------

export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  // 去掉 markdown 代码围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  // 找最外层配对的大括号（从第一个 { 到最后一个 }）
  for (const src of candidates) {
    const start = src.indexOf('{');
    const end = src.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    const body = src.slice(start, end + 1);
    try { return JSON.parse(body); } catch { /* 尝试修复常见问题后重试 */ }
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { /* 下一个 */ }
  }
  return null;
}
