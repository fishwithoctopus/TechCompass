import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvidenceGate, validateAnalysis, sanitizeAnalysis } from '../lib/contracts.js';
const raw = { terms: [{ term: 'MadeUp', what: '无法确认身份', solves: '用途未知' }], projects: [{ projectId: 'p', relevance: 'low', verdict: 'ignore', reasoning: '不应保留的推断', role: { fit: '无关' }, futureTrigger: '不应保留的条件' }], missing: ['请补充链接'] };
test('无搜索证据时清除项目判断，保留独立未知状态', () => {
  const result = applyEvidenceGate(raw, { status: 'no_results', ambiguous: true }, [{ projectId: 'p' }]);
  assert.equal(result.identityStatus, 'unverified'); assert.deepEqual(result.projects, []);
  assert.deepEqual(validateAnalysis(result, ['p']), []);
  assert.equal(sanitizeAnalysis(result).identityStatus, 'unverified');
});
test('有来源但身份歧义也不能直接判无关', () => {
  const result = applyEvidenceGate(raw, { status: 'searched', ambiguous: true }, [{ projectId: 'p' }]);
  assert.equal(result.identityStatus, 'ambiguous'); assert.deepEqual(result.projects, []);
});
test('未知身份带项目建议时契约拒绝；明确无关仍是合法结论', () => {
  assert.ok(validateAnalysis({ ...raw, identityStatus: 'unverified' }, ['p']).length);
  assert.deepEqual(validateAnalysis({ ...raw, identityStatus: 'identified' }, ['p']), []);
});
test('没有项目时保留解释并去掉模型擅自生成的项目', () => {
  const result = applyEvidenceGate(raw, { status: 'searched' }, []);
  assert.equal(result.identityStatus, 'identified'); assert.deepEqual(result.projects, []);
  assert.deepEqual(result.terms, raw.terms);
});
