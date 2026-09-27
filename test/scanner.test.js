// test/scanner.test.js — 项目扫描与草稿上下文
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject, draftContextFromScan, scanSummaryForPrompt } from '../lib/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-blog');

test('扫描夹具项目', () => {
  const scan = scanProject(FIXTURE);
  assert.equal(scan.name, 'sample-blog');
  assert.ok(scan.pkgJson.deps.includes('next'));
  assert.ok(scan.readmeExcerpt.includes('个人技术博客'));
  assert.ok(scan.tree.includes('src/'));
  assert.ok(scan.stackHints.includes('Next.js'));
  assert.equal(scan.files['package.json'], true);
});

test('草稿上下文从扫描推导', () => {
  const scan = scanProject(FIXTURE);
  const draft = draftContextFromScan(scan, 'pj_x');
  assert.equal(draft.projectId, 'pj_x');
  assert.equal(draft.name, 'sample-blog');
  assert.ok(draft.goal.includes('博客'));
  assert.ok(draft.stack.length >= 1);
});

test('不存在的目录抛错', () => {
  assert.throws(() => scanProject(path.join(FIXTURE, 'nope')));
});

test('prompt 摘要包含关键信息', () => {
  const scan = scanProject(FIXTURE);
  const summary = scanSummaryForPrompt(scan);
  assert.ok(summary.includes('sample-blog'));
  assert.ok(summary.includes('next'));
});
