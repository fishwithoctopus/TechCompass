import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { startDaemon } from '../lib/server.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 160; i++) { if (fn()) return; await sleep(50); } throw new Error('UI wait timeout'); }
test('desktop UI: navigation, project correction, later list, game focus and cancellation', async t => {
  const { port, token, stop } = await startDaemon({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ui-polish-')), port: 0 });
  t.after(stop);
  const base = `http://127.0.0.1:${port}`;
  const dom = new JSDOM(fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8'), { url: `${base}/ui/?token=${token}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => { dom.window.document.getElementById('snake-panel').ontoggle = null; dom.window.close(); });
  const w = dom.window, $ = id => w.document.getElementById(id);
  let restoreCollapse;
  w.electronAPI = { setCollapsed() {}, onCollapseState(cb) { restoreCollapse = cb; } };
  w.fetch = (p, opts) => fetch(new URL(p, base), opts);
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillRect() {} });
  w.eval(fs.readFileSync(new URL('../ui/theme.js', import.meta.url), 'utf8'));
  const snake = fs.readFileSync(new URL('../ui/snake.js', import.meta.url), 'utf8').replaceAll('export function', 'function');
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8').replace("import { mountSnake } from './snake.js';", '');
  w.eval(snake + '\n' + app);
  $('btn-collapse').click();
  assert.ok(w.document.body.classList.contains('collapsed'));
  assert.equal($('btn-collapse').getAttribute('aria-expanded'), 'false');
  restoreCollapse(false);
  assert.equal(w.document.body.classList.contains('collapsed'), false);
  assert.equal($('btn-collapse').getAttribute('aria-expanded'), 'true');
  assert.equal(w.eval(`groupHistory([
    {id:'a',input:{type:'text',value:' Bun '}},
    {id:'b',input:{type:'text',value:'bun'}},
    {id:'c',input:{type:'text',value:'Bun 2'}},
    {id:'d',input:{type:'image',value:'same'}},
    {id:'e',input:{type:'image',value:'same'}}
  ]).length`), 4);
  assert.equal(w.eval(`groupHistory([{id:'a',input:{type:'link',value:'https://example.com/A'}},{id:'b',input:{type:'link',value:'https://example.com/a'}}]).length`), 2);
  await until(() => $('ob-folder'));
  const matching = { id: 'matching', contextsSnapshot: [{projectId:'a',name:'相关项目'}, {projectId:'b',name:'无关项目'}], result: {
    identityStatus: 'identified', terms: [{ term:'示例工具', what:'工具', solves:'处理文档', applicationExample:'例如，做文档检索时用于索引。' }], missing: [],
    projects: [
      { projectId:'a', relevance:'medium', verdict:'ignore', reasoning:'弱相关但当前无须采用', role:{fit:'辅助文档检索'}, futureTrigger:'文档增加时' },
      { projectId:'b', relevance:'low', verdict:'ignore', reasoning:'无关联', role:{fit:'无'}, futureTrigger:'以后' },
    ] } };
  w.eval(`renderAnalysis(${JSON.stringify(matching)})`);
  assert.equal(w.document.querySelectorAll('.proj-card').length, 1);
  assert.ok($('proj-list').textContent.includes('相关项目'));
  assert.equal($('proj-list').textContent.includes('无关项目'), false);
  matching.result.projects[0].relevance = 'low';
  w.eval(`renderAnalysis(${JSON.stringify(matching)})`);
  assert.equal(w.document.querySelectorAll('.proj-card').length, 0);
  assert.ok($('proj-list').textContent.includes('暂无匹配'));
  assert.ok($('term-detail').textContent.includes('例如，做文档检索'));
  matching.result.terms[0] = { term:'Example 2', kind:'model', what:'测试模型', solves:'测试任务', comparison:{status:'supported',baseline:'Example 1',changes:['引用更准确（测试数据）'],tradeoffs:'速度未核实',upgradeAdvice:'先小规模验证',sources:['https://example.com/release']} };
  w.eval(`renderAnalysis(${JSON.stringify(matching)})`);
  assert.ok($('term-detail').textContent.includes('和旧版有什么不同'));
  assert.ok($('term-detail').textContent.includes('Example 1'));
  assert.equal($('term-detail').querySelector('.comparison-sources a').href, 'https://example.com/release');
  matching.result.terms[0].comparison.status = 'insufficient';
  w.eval(`renderAnalysis(${JSON.stringify(matching)})`);
  assert.ok($('term-detail').textContent.includes('暂时无法可靠比较'));
  assert.equal($('term-detail').textContent.includes('引用更准确'), false);
  // Legacy records must not continue showing low/ignore after this UI update.
  const unknown = { id: 'legacy-unknown', contextsSnapshot: [{ projectId: 'p', name: '测试项目' }], research: { status: 'no_results', ambiguous: true, sources: [] }, result: { terms: [{ term: '虚构词', what: '无法确认', solves: '未知' }], projects: [{ projectId: 'p', relevance: 'low', verdict: 'ignore' }], missing: ['请补充链接'] } };
  w.eval(`renderAnalysis(${JSON.stringify(unknown)})`);
  assert.ok($('result').textContent.includes('尚不能判断项目相关性'));
  assert.equal(w.document.querySelector('.proj-card'), null);
  assert.equal($('result').textContent.includes('基本无关'), false);
  assert.equal($('result').textContent.includes('当前可以忽略'), false);
  const definition = { id: 'definition', contextsSnapshot: [], result: { identityStatus: 'identified', terms: [{ term: 'Bun', what: 'JavaScript 工具链', solves: '安装、测试和打包' }], projects: [], missing: [] } };
  w.eval(`renderAnalysis(${JSON.stringify(definition)})`);
  assert.ok($('term-detail').textContent.includes('JavaScript 工具链'));
  $('result-add-project').click();
  assert.equal($('project-form').classList.contains('hidden'), false);
  assert.equal($('pf-confirm-step').classList.contains('hidden'), true);
  assert.equal($('pf-cancel').disabled, false);
  assert.equal($('view-projects').classList.contains('editing-project'), true);
  $('pf-cancel').click();
  assert.equal($('view-projects').classList.contains('editing-project'), false);
  assert.ok($('project-access').textContent.includes('把当前项目注册进 techcompass'));
  assert.ok($('btn-add-project').textContent.includes('从文件夹关联'));
  let copied = '';
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  $('copy-register-command').click();
  await until(() => copied.length > 0);
  assert.equal(copied, '把当前项目注册进 techcompass');
  w.eval('renderOnboarding(); switchView("main");');
  await until(() => $('ob-folder'));
  assert.equal($('nav-main').getAttribute('aria-current'), 'page');
  for (const view of ['history', 'projects', 'settings', 'main']) {
    $(`nav-${view}`).click();
    assert.equal(w.document.querySelectorAll('[aria-current="page"]').length, 1);
    assert.equal($(`nav-${view}`).getAttribute('aria-current'), 'page');
    await sleep(80);
  }
  $('ob-folder').click();
  $('pf-path').value = path.resolve('test/fixtures/sample-blog'); $('pf-scan').click();
  await until(() => !$('pf-save').disabled);
  assert.equal($('pf-confirm-step').classList.contains('hidden'), false);
  assert.equal($('pf-goal').closest('details'), null);
  assert.equal($('pf-focus').closest('details'), null);
  $('pf-focus').value = '先完善阅读体验，之后调研 Tauri'; $('pf-focus').dispatchEvent(new w.Event('input', { bubbles: true }));
  $('pf-save').click();
  await until(() => !$('view-main').classList.contains('hidden') && $('ctx-strip').textContent.includes('sample-blog'));
  $('nav-projects').click();
  await until(() => w.document.querySelector('details.proj-item'));
  const projectCard = w.document.querySelector('details.proj-item');
  assert.equal(projectCard.open, false);
  projectCard.open = true;
  assert.ok(projectCard.querySelector('[data-act=edit]'));
  $('nav-settings').click();
  await until(() => $('mcp-slot').querySelector('#mcp-copy-json'));
  $('set-theme').value = 'light'; $('set-theme').dispatchEvent(new w.Event('change'));
  assert.equal(w.document.documentElement.dataset.theme, 'light');
  assert.equal(w.localStorage.getItem('tc_theme'), 'light');
  w.eval(fs.readFileSync(new URL('../ui/theme.js', import.meta.url), 'utf8'));
  assert.equal(w.document.documentElement.dataset.theme, 'light');
  $('set-theme').value = 'dark'; $('set-theme').dispatchEvent(new w.Event('change'));
  assert.equal(w.document.documentElement.dataset.theme, 'dark');
  $('mcp-slot').querySelector('#mcp-copy-json').click();
  await until(() => copied.includes('mcpServers'));
  assert.ok(JSON.parse(copied).mcpServers.techcompass.command);
  assert.equal(copied.includes('x-tc-token'), false);
  $('nav-main').click();
  await sleep(100);
  $('agent-select').value = 'mock'; $('input').value = 'Tauri'; $('btn-analyze').click();
  await until(() => w.document.querySelector('.save-later'));
  const card = w.document.querySelector('.proj-card');
  assert.equal(card.classList.contains('open'), false);
  assert.ok(card.querySelector('.decision-reason').textContent.length);
  card.querySelector('.proj-head').click(); assert.equal(card.querySelector('.proj-head').getAttribute('aria-expanded'), 'true');
  card.querySelector('.save-later').click();
  await until(() => card.querySelector('.save-later').textContent.includes('已加入'));
  $('nav-history').click(); await until(() => $('later-list').textContent.includes('Tauri'));
  await until(() => w.document.querySelector('details.hist-item'));
  assert.equal(w.document.querySelector('details.hist-item').open, false);
  assert.ok(w.document.querySelector('.history-version'));
  $('nav-main').click(); await sleep(150);
  $('input').value = 'Bun new cancellation'; $('agent-select').value = 'mock'; $('btn-analyze').click();
  await until(() => !$('btn-cancel').disabled);
  $('snake-panel').open = true;
  $('input').focus(); assert.equal(w.document.activeElement.id, 'input');
  $('snake-start').click(); assert.equal(w.document.activeElement.id, 'snake-canvas');
  $('btn-cancel').click();
  await until(() => $('result').textContent.includes('已取消本次分析'));
  assert.equal($('snake-panel').open, false);
  assert.equal($('wait-controls').classList.contains('hidden'), true);
});
