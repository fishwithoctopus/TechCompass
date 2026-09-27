// test/ui.e2e.mjs — UI 逻辑端到端（jsdom 无浏览器方案）
// v0.2.0 流程：引导页 → 扫描 → 摘要确认 → 保存自动回主界面 → 分析 → 反馈 → 历史 → 设置/MCP 块。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from '/tmp/jt/node_modules/jsdom/lib/api.js';
import { startDaemon } from '../lib/server.js';

const UI_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'ui');
const APP_JS = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, step = 150, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${what}`);
    await sleep(step);
  }
}

test('卡片 UI 全流程（jsdom × 真实 daemon × mock 分析）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ui-'));
  const { port, token, stop } = await startDaemon({ dataDir });
  const base = `http://127.0.0.1:${port}`;
  t.after(() => stop());

  const dom = new JSDOM(fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'), {
    url: `${base}/ui/?token=${token}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = (p, opts) => fetch(new URL(p, base).href, opts);
  window.confirm = () => true;

  window.eval(APP_JS);
  const $ = (id) => window.document.getElementById(id);
  const visible = (id) => !$(id).classList.contains('hidden');

  // 1. boot：无项目 → 引导页（A/B 两条路径）
  await waitFor(() => $('result').textContent.includes('接入你的项目'), { what: 'boot: 引导页' });
  assert.ok($('result').textContent.includes('把当前项目注册进 techcompass'), '引导含 Agent 注册指令');
  assert.ok($('result').textContent.includes('选择本地文件夹'), '引导含备用路径');

  // 2. 项目表单：扫描 → 摘要「我理解你的项目是」→ 确认保存 → 自动回主界面
  $('nav-projects').click();
  $('btn-add-project').click();
  const fixture = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'sample-blog');
  $('pf-path').value = fixture;
  $('pf-scan').click();
  await waitFor(() => $('pf-summary').textContent.includes('我理解你的项目是'), { what: '扫描摘要' });
  await waitFor(() => !$('pf-save').disabled, { what: '保存按钮可用' });
  assert.ok($('pf-summary').textContent.includes('推断'), '推断内容有标注');
  assert.ok($('pf-details').open === false, '详细字段默认折叠');

  const hadProjects = S_projectsCount(window);
  $('pf-save').click();
  await waitFor(() => visible('view-main') && !$('ctx-strip').classList.contains('hidden'), { what: '保存后自动回主界面' });
  assert.ok($('ctx-strip').textContent.includes('sample-blog'), '主界面项目条可见');
  assert.ok(hadProjects === 0, '此前无项目');

  // 3. 分析（mock 引擎）
  $('input').value = 'Tauri 和 Bun 哪个值得看';
  $('btn-analyze').click();
  await waitFor(() => window.document.querySelector('.proj-card'), { timeout: 30000, what: '分析结果渲染' });
  assert.ok($('term-detail').textContent.length > 0, '核心词卡片有内容');
  const projCard = window.document.querySelector('.proj-card');
  assert.ok(projCard.textContent.includes('sample-blog'), '结论卡含项目名');
  assert.ok(projCard.querySelector('.b-try_now, .b-later, .b-ignore'), '有 verdict 徽章');
  assert.ok(projCard.textContent.includes('理解更新于'), '显示上下文更新时间');

  // 4. 展开/收起 + 反馈（首卡默认展开）
  assert.ok(projCard.classList.contains('open'), '首卡默认展开');
  projCard.querySelector('.proj-head').click();
  await waitFor(() => !projCard.classList.contains('open'), { what: '点击收起' });
  projCard.querySelector('.proj-head').click();
  await waitFor(() => projCard.classList.contains('open'), { what: '再次展开' });
  const accBtn = projCard.querySelector('.seg[data-role=acc] button[data-v=match]');
  const intBtn = projCard.querySelector('.seg[data-role=int] button[data-v=try]');
  accBtn.click(); intBtn.click();
  projCard.querySelector('.fb-row input').value = '判断挺准';
  projCard.querySelector('.fb-row button').click();
  await waitFor(() => projCard.querySelector('.fb-saved'), { what: '反馈保存' });

  // 5. 服务端确认反馈落库
  const fbRes = await fetch(`${base}/api/analyses`, { headers: { 'x-tc-token': token } }).then((r) => r.json());
  const fb = await fetch(`${base}/api/analyses/${fbRes.analyses[0].id}`, { headers: { 'x-tc-token': token } }).then((r) => r.json());
  assert.equal(fb.feedback.length, 1);
  assert.equal(fb.feedback[0].accuracy, 'match');
  assert.equal(fb.feedback[0].intent, 'try');
  assert.equal(fb.feedback[0].note, '判断挺准');

  // 6. 导航闭环：从项目/设置/历史页都能一键回「新分析」
  for (const nav of ['nav-projects', 'nav-history', 'nav-settings']) {
    $(nav).click();
    await waitFor(() => !visible(`view-${{ 'nav-projects': 'projects', 'nav-history': 'history', 'nav-settings': 'settings' }[nav]}`) === false, { what: `进入${nav}` });
    $('nav-main').click();
    await waitFor(() => visible('view-main'), { what: `${nav} → nav-main 回主界面` });
  }

  // 7. 历史视图：记录存在且可点开
  $('nav-history').click();
  await waitFor(() => window.document.querySelector('.hist-item'), { what: '历史渲染' });
  window.document.querySelector('.hist-item').click();
  await waitFor(() => visible('view-main') && window.document.querySelector('.proj-card'), { what: '历史点开回主界面并渲染' });

  // 8. 设置视图：MCP 接入块渲染（只读，不真正注册）
  $('nav-settings').click();
  await waitFor(() => $('settings-body').textContent.includes('数据目录'), { what: '设置渲染' });
  await waitFor(() => window.document.querySelector('#mcp-slot .mcp-block'), { what: 'MCP 块渲染' });
  assert.ok($('settings-body').textContent.includes('只修改勾选'), 'MCP 块有备份/选择性说明');

  // 9. 项目列表：来源与时间可见
  $('nav-projects').click();
  await waitFor(() => window.document.querySelector('.proj-item .src-note'), { what: '项目来源标注' });
  assert.ok(window.document.querySelector('.proj-item').textContent.includes('本地扫描'), '来源=本地扫描');

  // 收尾：静默 UI 后台网络活动，避免测试结束后悬挂 fetch 触发 unhandledRejection
  window.fetch = () => new Promise(() => {});
  await sleep(200);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

function S_projectsCount(window) {
  // 引导页存在即无项目
  return window.document.querySelector('.onboarding') ? 0 : 1;
}
