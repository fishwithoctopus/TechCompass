import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysis, sanitizeAnalysis } from '../lib/contracts.js';
import { buildAnalysisPrompt } from '../lib/prompt.js';

const result = () => ({ identityStatus: 'identified', terms: [{
  term: 'Example Model 2', kind: 'model', what: '测试用虚构模型', solves: '测试展示',
  applicationExample: '例如，做文档问答时，验证长文引用是否更准确。',
  comparison: { status: 'supported', baseline: 'Example Model 1，测试基准', changes: ['测试变化及影响'],
    tradeoffs: '速度未测', upgradeAdvice: '先用相同任务验证，不直接迁移', sources: ['https://example.com/release'] },
}], projects: [], missing: [] });
test('model comparison survives validation and persistence sanitization', () => {
  const out = result();
  assert.deepEqual(validateAnalysis(out, []), []);
  assert.deepEqual(sanitizeAnalysis(out).terms[0], out.terms[0]);
});
test('model cannot claim supported comparison without sources or omit comparison', () => {
  const out = result(); out.terms[0].comparison.sources = [];
  assert.ok(validateAnalysis(out, []).some(e => e.includes('sources')));
  out.terms[0].comparison = null;
  assert.ok(validateAnalysis(out, []).some(e => e.includes('comparison')));
});
test('insufficient evidence has no fabricated changes, rejects unsafe source links', () => {
  const out = result(); out.terms[0].comparison.status = 'insufficient';
  assert.ok(validateAnalysis(out, []).some(e => e.includes('changes')));
  out.terms[0].comparison.changes = []; out.terms[0].comparison.sources = [];
  assert.deepEqual(validateAnalysis(out, []), []);
  out.terms[0].comparison.sources = ['javascript:alert(1)'];
  assert.ok(validateAnalysis(out, []).some(e => e.includes('sources')));
});
test('unknown model strips comparison and legacy terms remain supported', () => {
  const out = result(); out.identityStatus = 'unverified';
  assert.equal(sanitizeAnalysis(out).terms[0].comparison, null);
  assert.deepEqual(validateAnalysis({ terms: [{ term: 'Bun', what: '运行时', solves: '运行 JS' }], projects: [] }, []), []);
});
test('prompt covers model baselines, uncertainty and relevance display policy', () => {
  const prompt = buildAnalysisPrompt({ normalized: { type: 'text', text: '一个新模型' }, contexts: [] });
  for (const text of ['同系列直接前代', '不编造提升百分比', 'applicationExample', 'low 不展示', 'status=insufficient']) assert.ok(prompt.includes(text));
});
