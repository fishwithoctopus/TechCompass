// test/contracts.test.js — 契约校验的行为测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAnalysis, validateContext, sanitizeAnalysis, sanitizeContext, extractJson, STAGES,
} from '../lib/contracts.js';

const CTX = {
  projectId: 'pj_1', name: 'sample', goal: '一个博客', stage: 'prototype',
  stack: ['Next.js'], keyDeps: [{ name: 'react', why: 'UI' }], focus: '', constraints: [],
};

test('合法上下文通过校验', () => {
  assert.deepEqual(validateContext(CTX), []);
});

test('上下文：stage 非法被拒绝', () => {
  const errs = validateContext({ ...CTX, stage: '超级阶段' });
  assert.ok(errs.some((e) => e.includes('stage')));
});

test('上下文：goal 过长被拒绝', () => {
  const errs = validateContext({ ...CTX, goal: 'x'.repeat(400) });
  assert.ok(errs.some((e) => e.includes('goal')));
});

const GOOD = {
  terms: [{ term: 'Bun', what: 'JS 运行时', solves: '快' }],
  projects: [{
    projectId: 'pj_1', relevance: 'high', verdict: 'try_now', reasoning: '因为 X',
    role: { fit: '替代构建', replaces: 'npm', complements: null, cost: '低' },
    tryAction: '跑 quickstart', futureTrigger: null,
  }],
  missing: [],
};

test('合法分析通过校验', () => {
  assert.deepEqual(validateAnalysis(GOOD, ['pj_1']), []);
});

test('try_now 必须有 tryAction', () => {
  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.projects[0].tryAction = null;
  const errs = validateAnalysis(bad, ['pj_1']);
  assert.ok(errs.some((e) => e.includes('tryAction')));
});

test('later 必须有 futureTrigger', () => {
  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.projects[0].verdict = 'later';
  bad.projects[0].tryAction = null;
  const errs = validateAnalysis(bad, ['pj_1']);
  assert.ok(errs.some((e) => e.includes('futureTrigger')));
});

test('缺少项目的判断被拒绝', () => {
  const errs = validateAnalysis(GOOD, ['pj_1', 'pj_2']);
  assert.ok(errs.some((e) => e.includes('pj_2')));
});

test('relevance 与 verdict 独立：high+ignore 合法', () => {
  const ok = JSON.parse(JSON.stringify(GOOD));
  ok.projects[0].verdict = 'ignore';
  ok.projects[0].tryAction = null;
  ok.projects[0].futureTrigger = '当项目需要时';
  assert.deepEqual(validateAnalysis(ok, ['pj_1']), []);
});

test('sanitize 清洗越界字段', () => {
  const dirty = {
    terms: [{ term: 'X', what: 'y', solves: 'z', extra: 1 }],
    projects: [{ projectId: 'pj_1', relevance: '超高', verdict: 'later', reasoning: 'r', role: {}, tryAction: null, futureTrigger: 'f' }],
    missing: null,
  };
  const clean = sanitizeAnalysis(dirty);
  assert.equal(clean.projects[0].relevance, 'low');
  assert.equal(clean.projects[0].verdict, 'later');
  assert.deepEqual(clean.missing, []);
});

test('extractJson 处理围栏与前后杂讯', () => {
  const out = extractJson('好的，结果如下：\n```json\n{"terms": []}\n```\n希望有帮助');
  assert.deepEqual(out, { terms: [] });
  assert.equal(extractJson('完全不是 JSON'), null);
  assert.deepEqual(extractJson('前缀 {"a":1,} 后缀'), { a: 1 }); // 尾逗号修复
});

test('sanitizeContext 修正非法 stage', () => {
  const c = sanitizeContext({ ...CTX, stage: 'wrong' });
  assert.ok(STAGES.includes(c.stage));
});
