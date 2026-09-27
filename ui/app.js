// ui/app.js — TechCompass 卡片逻辑（无框架、无构建）
// v0.2.0：常驻「新分析」入口；保存项目后回主界面；表单改为「扫描→摘要确认」流；
//        MCP 接入界面（只改勾选项，自动备份）；项目来源与更新时间可见。
import { mountSnake } from './snake.js';
const $ = (id) => document.getElementById(id);
const icon = name => `<span class="icon" data-icon="${name}" aria-hidden="true"></span>`;

// ---------- token ----------
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) localStorage.setItem('tc_token', urlToken);
const TOKEN = localStorage.getItem('tc_token') || '';
const HAS_ELECTRON = !!window.electronAPI?.pickFolder;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-tc-token': TOKEN, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

// ---------- 状态 ----------
const S = {
  projects: [], agents: [], settings: {}, mcp: null, image: null, jobTimer: null,
  analysis: null, feedback: {}, editingProjectId: null, activeTerm: 0,
  busy: false, jobId: null, currentProject: localStorage.getItem('tc_current_project') || '',
  form: { draft: null, dirty: false, source: 'manual' },
};

const LABELS = {
  verdict: { try_now: '现在值得尝试', later: '以后再看', ignore: '当前可以忽略' },
  relevance: { high: '高度相关', medium: '部分相关', low: '基本无关' },
  stage: { idea: '想法', prototype: '原型', mvp: 'MVP', growth: '增长', mature: '成熟', maintenance: '维护' },
  agentName: { claude: 'Claude Code', codex: 'Codex', api: '自定义 API 模型', mock: '演示引擎', 'mcp-session': 'Agent 会话' },
  src: { scan: '本地扫描', agent: 'Agent 注册', manual: '手动填写', enhance: 'AI 提炼' },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function timeago(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------- 视图切换 ----------
function switchView(name) {
  for (const v of ['view-main', 'view-projects', 'view-history', 'view-settings']) {
    $(v).classList.toggle('hidden', v !== `view-${name}`);
  }
  document.body.classList.toggle('on-main', name === 'main');
  for (const key of ['main', 'projects', 'history', 'settings']) {
    const nav = $(`nav-${key}`);
    if (key === name) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  snake.pause();
  if (name === 'projects') renderProjectList();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'main') refreshMain();
}

// 主界面状态刷新（保存项目 / Agent 注册后回到主界面时都会重拉）
async function refreshMain() {
  try {
    const st = await api('/api/state');
    S.projects = st.projects; S.settings = st.settings; S.agents = st.agents; S.mcp = st.mcp;
    $('foot-dir').textContent = st.dataDir;
    renderAgentSelect();
    renderCtxStrip();
    if (!S.projects.length && !S.busy && !S.analysis) renderOnboarding();
    else if (S.projects.length && $('result').querySelector('.onboarding')) $('result').innerHTML = '<div class="hint-card">项目已准备好。输入技术词、链接或图片，开始第一条判断。</div>';
    const { items } = await api('/api/later');
    const count = items.filter(x => x.needsReview && !x.projectMissing).length;
    $('review-notice').classList.toggle('hidden', !count);
    $('review-notice').textContent = `${count} 条「以后看」的项目资料已更新，点此复看`;
  } catch (e) {
    $('result').innerHTML = `<div class="error-box">连接失败：${esc(e.message)}</div>`;
  }
}

// 主界面：已关联项目一览（让"项目状态可见"）
function renderCtxStrip() {
  const strip = $('ctx-strip');
  const active = S.projects.filter(p => p.enabled !== false);
  if (!active.length) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  strip.innerHTML = `
    <span class="ctx-label">结合判断的项目</span>
    ${active.slice(0, 4).map((p) => `<button class="ctx-chip" aria-pressed="${p.id === S.currentProject}" data-pid="${esc(p.id)}" title="优先展示此项目 · ${esc(p.path)}">${esc(p.context?.name || p.id)}</button>`).join('')}
    ${active.length > 4 ? `<span class="ctx-more">+${active.length - 4}</span>` : ''}
    <button class="ctx-manage" id="ctx-manage">管理</button>`;
  strip.querySelectorAll('.ctx-chip').forEach((c) => {
    c.onclick = () => { S.currentProject = c.dataset.pid; localStorage.setItem('tc_current_project', S.currentProject); renderCtxStrip(); if (S.analysis) renderAnalysis(S.analysis); toast('该项目的判断将优先展示'); };
  });
  $('ctx-manage').onclick = () => switchView('projects');
}

// 首次使用引导：两条接入路径（Agent 带入 = 首选；本地文件夹 = 备用）
function renderOnboarding() {
  const detected = (S.agents.detected || []).map(id => LABELS.agentName[id]).join('、');
  $('result').innerHTML = `
    <div class="hint-card onboarding">
      <div class="big">让判断和你正在做的事有关</div>
      <div class="ob-row">
        <div class="ob-no">1</div>
        <div class="ob-body">
          <b>确认分析模型</b>
          <p>${detected ? `已找到 ${esc(detected)}，登录和额度仍需测试。` : '尚未找到本地 CLI，可在设置中添加 API 模型。'}</p>
          <button class="ghost small" id="ob-model">打开设置并测试连接</button>
        </div>
      </div>
      <div class="ob-row">
        <div class="ob-no">2</div>
        <div class="ob-body">
          <b>选择本地文件夹</b>
          <p>TechCompass 读取该目录的 README、依赖清单和 git 记录，生成项目理解后由你确认。</p>
          <button class="primary small" id="ob-folder">选择项目文件夹</button>
        </div>
      </div>
      <p>3 · 确认项目目标和当前重点，然后输入想了解的技术。</p>
      <p>也可从 Agent 会话注册项目：在设置中展开 MCP 接入。MCP 不是分析模型。</p>
    </div>`;
  $('ob-folder').onclick = () => { switchView('projects'); openProjectForm(null); };
  $('ob-model').onclick = () => switchView('settings');
}

// ---------- MCP 接入块（引导页与设置页共用） ----------
async function renderMcpBlock(container) {
  const st = await api('/api/mcp/status');
  const names = { claude: 'Claude Code', codex: 'Codex CLI', cursor: 'Cursor', windsurf: 'Windsurf' };
  const stateLabel = (id) => {
    const r = st.registrations[id];
    if (!r) return '';
    if (r.parseError) return `<span class="mcp-state warn">⚠ 配置解析失败</span>`;
    return r.installed ? `<span class="mcp-state on">✓ 已写入</span>` : '';
  };
  container.innerHTML = `
    <div class="mcp-block">
      <div class="mcp-title">注册 MCP：只修改勾选的 Agent，写入前校验并备份。请查看逐项结果；写后异常时保留现场和备份。</div>
      ${Object.entries(names).map(([id, name]) => `
        <label class="mcp-item">
          <input type="checkbox" value="${id}" ${['claude', 'codex'].includes(id) ? 'checked' : ''}>
          <span>${name}</span>
          ${stateLabel(id)}
        </label>`).join('')}
      <button class="primary small" id="mcp-do-register">注册</button>
      <p class="mcp-note">注册后在 Agent 会话里说「把当前项目注册进 techcompass」，项目就会同步到这张卡片。重启对应 Agent 后生效。</p>
      <div class="mcp-result" id="mcp-result"></div>
      <details class="mcp-export"><summary>其他 Agent：复制接入配置</summary>
        <p class="mcp-note">适用于这台电脑上支持 stdio MCP 的客户端。不是网页链接；不同 Agent 的配置格式可能不同。复制不会修改任何配置。</p>
        <button class="ghost" id="mcp-copy-guide">复制给 Agent 的接入说明</button>
        <button class="ghost" id="mcp-copy-json">复制 JSON 配置</button>
        <pre id="mcp-export-preview"></pre>
      </details>
    </div>`;
  const copyMcp = async (guide) => {
    try {
      const { mcp } = await api('/api/state');
      const config = JSON.stringify({ mcpServers: { techcompass: mcp.entry } }, null, 2);
      const text = guide ? `请帮我在当前客户端接入本机 TechCompass 的 stdio MCP。先确认客户端支持本地 MCP；以下是这台电脑的启动配置，请转换为客户端要求的格式，不要覆盖其他服务。修改前备份并校验，路径不存在时停止并询问我，不要猜测替代路径。完成后验证 MCP 握手与工具列表，再告诉我是否需要重启。不要自动注册或上传项目。\n\n${config}` : config;
      container.querySelector('#mcp-export-preview').textContent = text;
      await navigator.clipboard.writeText(text);
      toast('已复制；交给目标 Agent 确认接入');
    } catch (e) { toast('复制失败；如配置已显示，可选中文字手动复制'); }
  };
  container.querySelector('#mcp-copy-guide').onclick = () => copyMcp(true);
  container.querySelector('#mcp-copy-json').onclick = () => copyMcp(false);
  container.querySelector('#mcp-do-register').onclick = async (e) => {
    const agents = [...container.querySelectorAll('.mcp-item input:checked')].map((i) => i.value);
    if (!agents.length) { toast('先勾选至少一个 Agent'); return; }
    e.target.disabled = true; e.target.textContent = '注册中…';
    container.querySelector('#mcp-result').innerHTML = '';
    try {
      const r = await api('/api/mcp/register', { method: 'POST', body: JSON.stringify({ agents }) });
      const lines = r.results.map((x) => {
        if (!x.ok) return `✗ ${names[x.agent] || x.agent}：${x.error}`;
        let s = `✓ ${names[x.agent] || x.agent} 配置已写入（解析校验通过${x.backup ? '，原文件已备份' : ''}）`;
        if (x.probe) s += x.probe.ok
          ? `<br>　连通性 ✓ ${x.probe.detail}`
          : `<br>　连通性 ✗ ${x.probe.detail}（与写入结果无关，请检查命令是否可执行）`;
        return s;
      });
      container.querySelector('#mcp-result').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
      const failed = r.results.filter((x) => !x.ok).length;
      toast(failed ? `${failed} 项失败，请查看逐项错误与备份状态` : '✓ 全部写入成功');
      await refreshMain();
      renderMcpBlock(container);
    } catch (err) { toast(`注册失败：${err.message}`); e.target.disabled = false; e.target.textContent = '注册'; }
  };
}

// ---------- 启动 ----------
async function boot() {
  document.body.classList.add('on-main');
  $('nav-main').setAttribute('aria-current', 'page');
  try {
    await refreshMain();
  } catch (e) {
    if (e.message?.includes('未授权')) {
      location.href = '/ui/?token=' + TOKEN; // 无效 token 时重试一次
    }
    $('result').innerHTML = `<div class="error-box">连接失败：${esc(e.message)}</div>`;
  }
}

function renderAgentSelect() {
  const sel = $('agent-select');
  const previous = sel.value;
  const detected = new Set(S.agents.detected);
  const opts = [`<option value="">自动（${S.agents.preferred.filter((a) => a !== 'mock').map((a) => LABELS.agentName[a] || a).join(' → ') || '演示引擎'}）</option>`];
  for (const a of ['codex', 'claude', 'api', 'mock']) {
    const label = LABELS.agentName[a] + (a === 'api' ? (S.settings.apiProvider ? '' : '（在设置中添加）') : a !== 'mock' && !detected.has(a) ? '（未检测到）' : '');
    opts.push(`<option value="${a}">${esc(label)}</option>`);
  }
  sel.innerHTML = opts.join('');
  if ([...sel.options].some(o => o.value === previous)) sel.value = previous;
}

// ---------- 图片：选择、拖入、粘贴共用校验 ----------
let imageReadVersion = 0;
function clearImage() {
  imageReadVersion++;
  S.image = null; $('img-chip').classList.add('hidden');
  $('img-preview').removeAttribute('src'); $('img-file').value = '';
}
function readImage(file) {
  if (!file) return;
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)) { toast('请选择 PNG、JPEG、WebP 或 GIF 图片'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('图片超过 8 MB，请缩小后重试'); return; }
  const version = ++imageReadVersion;
  const reader = new FileReader();
  reader.onerror = () => toast('图片读取失败，请重新选择');
  reader.onload = () => {
    if (version !== imageReadVersion) return;
    S.image = String(reader.result); $('img-preview').src = S.image;
    $('img-name').textContent = file.name || '截图';
    $('img-chip').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}
$('img-clear').onclick = clearImage;
$('img-pick').onclick = () => $('img-file').click();
$('img-file').onchange = e => readImage(e.target.files[0]);
document.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type?.startsWith('image/'));
  if (item && !$('view-main').classList.contains('hidden')) { e.preventDefault(); readImage(item.getAsFile()); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  if (!$('view-main').classList.contains('hidden')) readImage(e.dataTransfer?.files?.[0]);
});

// ---------- 分析 ----------
async function analyze() {
  if (S.busy) return;
  const text = $('input').value.trim();
  let input;
  if (S.image) input = { type: 'image', value: S.image };
  else if (text) input = { type: /^https?:\/\//i.test(text) ? 'link' : 'text', value: text };
  else { toast('先输入技术词、链接，或选择一张图片'); return; }

  const agentId = $('agent-select').value || undefined;
  S.busy = true; S.jobId = null;
  const started = Date.now();
  $('wait-controls').classList.remove('hidden');
  $('btn-cancel').disabled = true;
  $('elapsed').textContent = '已等待 0 秒';
  const elapsedTimer = setInterval(() => { $('elapsed').textContent = `已等待 ${Math.floor((Date.now() - started) / 1000)} 秒`; }, 1000);
  $('btn-analyze').disabled = true;
  $('result').innerHTML = '';
  $('status').classList.remove('hidden');
  $('status-text').textContent = '提交中…';
  try {
    const { jobId } = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ input, agentId }) });
    S.jobId = jobId; $('btn-cancel').disabled = false;
    const r = await pollJob(jobId, (stage) => { $('status-text').textContent = stage || '分析中…'; });
    // 取完整记录（含项目快照与已有反馈）再渲染
    const full = await api(`/api/analyses/${r.analysisId}`);
    renderAnalysis({ ...full.analysis, cached: r.cached }, full.feedback);
  } catch (e) {
    if (e.message === '分析已取消') $('result').innerHTML = '<div class="hint-card">已取消本次分析。已发生的模型用量可能仍计费。</div>';
    else showError(e);
  } finally {
    S.busy = false; S.jobId = null;
    clearInterval(elapsedTimer); snake.pause();
    $('snake-panel').open = false;
    $('wait-controls').classList.add('hidden');
    $('btn-analyze').disabled = false;
    $('status').classList.add('hidden');
  }
}

async function pollJob(jobId, onStage) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const job = await api(`/api/jobs/${jobId}`);
        onStage?.(job.stage);
        if (job.status === 'done') { resolve(job.result); return; }
        if (job.status === 'cancelled') { reject(new Error('分析已取消')); return; }
        if (job.status === 'error') { reject(Object.assign(new Error(job.error), { data: { errors: job.errors } })); return; }
        S.jobTimer = setTimeout(tick, 1200);
      } catch (e) { reject(e); }
    };
    tick();
  });
}

function showError(e) {
  const errs = e.data?.errors?.length ? `<ul>${e.data.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  $('result').innerHTML = `<div class="error-box"><b>分析失败</b>：${esc(e.message)}${errs}</div>`;
  const retry = document.createElement('button'); retry.className = 'ghost'; retry.textContent = '重试本次输入'; retry.onclick = analyze;
  $('result').appendChild(retry);
}

// ---------- 渲染分析结果 ----------
const REL_ORDER = { high: 0, medium: 1, low: 2 };
const VERDICT_ORDER = { try_now: 0, later: 1, ignore: 2 };
function identityUnresolved(a) {
  return ['unverified', 'ambiguous'].includes(a.result?.identityStatus) || a.research?.status === 'no_results' || a.research?.ambiguous;
}

function renderAnalysis(analysis, feedback = []) {
  const { result } = analysis;
  const unresolved = identityUnresolved(analysis);
  const hasProjects = (analysis.contextsSnapshot || []).length > 0;
  S.analysis = analysis;
  S.feedback = Object.fromEntries(feedback.map((f) => [f.projectId, f]));
  S.activeTerm = 0;
  const ctxById = Object.fromEntries((analysis.contextsSnapshot || []).map((c) => [c.projectId, c]));
  const projs = [...(unresolved ? [] : result.projects)].sort((a, b) =>
    (Number(b.projectId === S.currentProject) - Number(a.projectId === S.currentProject)) || (VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]) || (REL_ORDER[a.relevance] - REL_ORDER[b.relevance]));

  const termsHtml = result.terms.length > 1
    ? `<div class="terms" id="terms-tabs">${result.terms.map((t, i) => `<div class="term-tab${i === 0 ? ' active' : ''}" data-i="${i}">${esc(t.term)}</div>`).join('')}</div>` : '';

  $('result').innerHTML = `
    <div class="analysis">
      <div class="meta-row">
        <span>${timeago(analysis.createdAt)}</span>
        <span>·</span><span>${esc(LABELS.agentName[analysis.agentUsed] || analysis.agentUsed)}</span>
        ${analysis.cached ? '<span class="badge-cache">· 复用上方时间的结果，未重新调用模型</span>' : ''}
      </div>
      ${analysis.agentUsed === 'mock' ? '<div class="warn-banner">离线演示：不是模型分析，请勿据此决策。</div>' : analysis.fellBack ? '<div class="warn-banner">首选模型未完成，已使用上方标注的备用模型。</div>' : ''}
      ${termsHtml}
      <div id="term-detail"></div>
      ${analysis.research ? `<details class="hint-card"><summary>${analysis.research.status === 'provided_link' ? '输入链接来源' : analysis.research.status === 'no_results' ? '已搜索，暂无可靠来源' : '联网检索来源'}${analysis.research.ambiguous ? ' · 存在多个候选' : ''}</summary><p>检索与项目分析分开；以下为检索模型引用的来源，请核对原文。</p>${(analysis.research.sources || []).filter(s => /^https?:\/\//i.test(s.url)).map(s => `<p><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></p>`).join('')}${analysis.research.searchedAt ? `<p>检索时间：${esc(new Date(analysis.research.searchedAt).toLocaleString())}（同一输入最多复用 30 分钟）</p>` : ''}</details>` : ''}
      <div id="missing-slot"></div>
      <div id="proj-list"></div>
    </div>`;

  renderTermDetail();
  if (analysis.research?.ambiguous && analysis.research.status !== 'no_results' && result.terms.length > 1) {
    const choices = document.createElement('div'); choices.className = 'hint-card';
    choices.innerHTML = `<b>先确认你指的是哪一个</b><p>${esc(analysis.research.summary)}</p>`;
    for (const term of result.terms) {
      const button = document.createElement('button'); button.className = 'ghost'; button.textContent = `分析「${term.term}」`;
      button.onclick = () => { $('input').value = `${term.term}：${term.what}`; clearImage(); analyze(); };
      choices.appendChild(button);
    }
    $('missing-slot').before(choices);
  }
  if (result.terms.length > 1) {
    $('terms-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.term-tab');
      if (!tab) return;
      S.activeTerm = Number(tab.dataset.i);
      document.querySelectorAll('.term-tab').forEach((t) => t.classList.toggle('active', Number(t.dataset.i) === S.activeTerm));
      renderTermDetail();
    });
  }
  renderMissing(result.missing || []);
  const list = $('proj-list');
  if (unresolved) {
    const notice = document.createElement('div'); notice.className = 'hint-card identity-notice';
    notice.innerHTML = '<b>暂时无法确认技术身份</b><p>尚不能判断项目相关性。缺少可靠资料不代表它不存在，请检查拼写，或补充链接、截图、用途。</p>';
    $('term-detail').before(notice);
  }
  if (!hasProjects) {
    const ready = S.projects.some(p => p.enabled !== false);
    list.innerHTML = `<div class="hint-card"><b>${ready ? '项目已关联，可以继续判断' : '关联项目，再看看它和你有什么关系'}</b><p>${unresolved ? '确认名词身份后，可结合项目继续判断。' : '上面是名词解释。结合项目后，可以进一步判断适用位置和是否值得现在尝试。'}</p><button class="primary small" id="result-add-project">${ready ? '结合项目重新分析' : '关联项目'}</button></div>`;
    $('result-add-project').onclick = () => {
      if (!ready) { switchView('projects'); openProjectForm(null); return; }
      if (!$('input').value.trim() && analysis.input?.type !== 'image') $('input').value = analysis.input?.value || analysis.normalized?.ref || '';
      analyze();
    };
    return;
  }
  if (unresolved) return;
  projs.forEach((p) => list.appendChild(projCard(p, ctxById[p.projectId], false)));
}

function renderTermDetail() {
  const t = S.analysis.result.terms[S.activeTerm] || S.analysis.result.terms[0];
  if (!t) { $('term-detail').innerHTML = ''; return; }
  $('term-detail').innerHTML = `
    <div class="term-card">
      <h3>${esc(t.term)}</h3>
      <div class="what"><span class="lbl">是什么：</span>${esc(t.what)}</div>
      <div class="solves"><span class="lbl">解决什么：</span>${esc(t.solves)}</div>
    </div>`;
}

function renderMissing(missing) {
  const slot = $('missing-slot');
  if (!missing?.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = `
    <div class="missing-panel">
      <h4>还差一点信息</h4>
      <ul>${missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      <textarea id="missing-answer" placeholder="补充说明（可选）…"></textarea>
      <div style="margin-top:6px"><button class="ghost" id="btn-reanalyze">补充后重新分析</button></div>
    </div>`;
  $('btn-reanalyze').onclick = () => {
    const ans = $('missing-answer').value.trim();
    const orig = S.analysis.input?.value || S.analysis.normalized?.ref || '';
    $('input').value = `${orig}\n（补充：${ans}）`.trim();
    S.image = null; $('img-chip').classList.add('hidden');
    analyze();
  };
}

function projCard(p, ctx, expanded) {
  const el = document.createElement('div');
  el.className = 'proj-card' + (expanded ? ' open' : '');
  el.dataset.verdict = p.verdict;
  const name = ctx?.name || p.projectId;
  const role = p.role || {};
  const roleRows = [];
  if (role.replaces) roleRows.push(`<div class="kv"><span class="k">替代</span><span class="v">${esc(role.replaces)}</span></div>`);
  if (role.complements) roleRows.push(`<div class="kv"><span class="k">补充</span><span class="v">${esc(role.complements)}</span></div>`);
  if (role.cost) roleRows.push(`<div class="kv"><span class="k">成本</span><span class="v">${esc(role.cost)}</span></div>`);
  const ctxMeta = ctx?.updatedAt ? `<span class="ctx-meta">理解更新于 ${timeago(ctx.updatedAt)}</span>` : '';

  el.innerHTML = `
    <button class="proj-head" aria-expanded="${expanded}">
      <div class="proj-head-main">
        <span class="proj-name">${esc(name)}</span>
        <span class="b b-rel-${p.relevance}">${LABELS.relevance[p.relevance]}</span>
        <span class="b b-${p.verdict}">${LABELS.verdict[p.verdict]}</span>
      </div>
      <span class="chev">${icon('chevron-right')}</span>
    </button>
    ${ctxMeta}
    <p class="decision-reason">${esc(p.reasoning)}</p>
    ${p.tryAction ? `<div class="action-box"><b>最小验证</b>：${esc(p.tryAction)}</div>` : ''}
    ${p.futureTrigger ? `<div class="trigger-box"><b>什么时候再看</b>：${esc(p.futureTrigger)}</div><button class="ghost save-later">加入以后看</button>` : ''}
    <div class="proj-body">
      <div class="sec"><div class="sec-title">它在项目里的位置</div><p>${esc(role.fit || '—')}</p>${roleRows.join('')}</div>

    </div>`;

  el.querySelector('.proj-head').onclick = e => { const open = el.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(open)); };
  const analysisId = S.analysis.id;
  const save = el.querySelector('.save-later');
  if (save) save.onclick = async () => {
    save.disabled = true;
    try { await api('/api/later', { method: 'POST', body: JSON.stringify({ analysisId, projectId: p.projectId }) }); save.textContent = '已加入 · 在历史中查看'; }
    catch(e) { save.disabled = false; toast(e.message); }
  };
  return el;
}

// ---------- 项目视图 ----------
function renderProjectList() {
  api('/api/projects').then(({ projects }) => {
    S.projects = projects;
    if (!$('project-access').dataset.initialized) {
      $('project-access').open = projects.length === 0;
      $('project-access').dataset.initialized = 'true';
    }
    const list = $('project-list');
    if (!projects.length) {
      list.innerHTML = '<p class="project-empty">还没有项目。用上面的会话指令注册，或从本地文件夹关联；不需要从空白表单开始。</p>';
      return;
    }
    list.innerHTML = '';
    for (const p of projects) {
      const c = p.context;
      const el = document.createElement('details');
      el.className = 'proj-item';
      const srcLabel = c ? `来自${LABELS.src[c.source] || '手动填写'}${c.updatedAt ? ` · ${timeago(c.updatedAt)}` : ''}` : '';
      el.innerHTML = `
        <summary class="project-summary"><span class="row1">
          <span class="pname">${esc(c?.name || p.id)}</span>
          <span class="tag">${p.enabled === false ? '已暂停' : '参与分析'}</span>
        </span><span class="project-one-line">${esc(c?.goal || '尚无摘要，点击查看与完善')}</span><span class="project-expand">查看详情</span></summary>
        <div class="project-expanded">
          ${srcLabel ? `<span class="src-note">${esc(srcLabel)}</span>` : ''}
          ${c ? `<span class="tag stage-tag">${esc(LABELS.stage[c.stage] || c.stage)}</span>` : ''}
        <div class="ppath" title="${esc(p.path)}">${esc(p.path)}</div>
        ${c?.goal ? `<div class="pgoal">${esc(c.goal)}</div>` : ''}
        <div class="pgoal">当前重点：${esc(c?.focus || '尚未确认，建议补充')}</div>
        <div class="ptags">${(c?.stack || []).map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>
        <div class="pactions">
          <button class="ghost" data-act="edit">查看 / 纠正</button>
          <button class="ghost" data-act="refresh">重新提炼</button>
          <button class="ghost" data-act="toggle">${p.enabled === false ? '加入分析' : '暂停参与分析'}</button>
          <button class="ghost danger-text" data-act="del">移除关联</button>
        </div></div>`;
      el.querySelector('[data-act=edit]').onclick = () => openProjectForm(p);
      el.querySelector('[data-act=refresh]').onclick = () => refreshProject(p);
      el.querySelector('[data-act=toggle]').onclick = async () => {
        try {
          await api(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify({enabled:p.enabled === false}) });
          renderProjectList();
          await refreshMain();
          toast(p.enabled === false ? '已加入分析' : '已暂停，不会删除项目或历史');
        } catch(e) { toast(e.message); }
      };
      el.querySelector('[data-act=del]').onclick = async () => {
        if (!confirm(`移除「${c?.name || p.path}」的关联？不会删除本地项目文件，分析历史也会保留。`)) return;
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        renderProjectList(); toast('已删除');
      };
      list.appendChild(el);
    }
  }).catch(e => { $('project-list').textContent = `项目读取失败：${e.message}。请点击「刷新列表」重试。`; });
}

// ---------- 项目表单：扫描 → 摘要确认流 ----------
function projFormShell() {
  return `
    <div class="pf-step">
      <h3 class="pf-step-title">${S.editingProjectId ? '查看与纠正项目理解' : '从本地文件夹关联'}</h3>
      <p class="scan-note">${S.editingProjectId ? '只修改这份项目摘要，不会修改你的项目文件。' : '先选目录，自动生成摘要；你只需确认或纠正，不用逐项手填。'}</p>
      ${HAS_ELECTRON
        ? `<button class="primary" id="pf-pick">选择文件夹…</button>`
        : `<div class="path-row"><input type="text" id="pf-path" aria-label="本地项目文件夹路径" placeholder="项目绝对路径，如 D:\\code\\my-app"><button class="ghost" id="pf-scan">扫描</button></div>`}
      <div class="scan-note" id="pf-note">只读取所选目录内的 README、依赖清单、目录结构和 git log，不访问其他位置</div>
    </div>
    <div class="pf-step hidden" id="pf-confirm-step">
      <div class="pf-step-title">2 · 确认理解</div>
      <div id="pf-summary" class="pf-summary"><div class="sum-empty">选好文件夹后，这里会给出 TechCompass 对项目的理解，由你确认或纠正。</div></div>
      <div class="field"><label for="pf-goal">项目目标（一句话）</label><textarea id="pf-goal"></textarea></div>
      <div class="field"><label for="pf-focus">你现在最想推进什么？</label><textarea id="pf-focus" placeholder="例如：先验证核心流程，暂不迁移技术栈"></textarea></div>
      <div class="field"><label for="pf-stage">当前阶段</label><select id="pf-stage">${Object.entries(LABELS.stage).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <details id="pf-details" class="pf-details">
        <summary>更多项目资料（可选）</summary>
        <div class="pf-fields">
          <div class="field"><label for="pf-name">项目名</label><input type="text" id="pf-name"></div>
          <div class="field"><label for="pf-stack">技术栈（逗号分隔）</label><input type="text" id="pf-stack"></div>
          <div class="field"><label for="pf-deps">关键依赖（每行一个）</label><textarea id="pf-deps"></textarea></div>
          <div class="field"><label for="pf-cons">项目约束（可选，每行一条）</label><textarea id="pf-cons"></textarea></div>
        </div>
      </details>
    </div>
      <div class="form-actions">
        <button class="primary" id="pf-save" disabled>确认并保存</button>
        <button class="ghost" id="pf-enhance" disabled>让 AI 提炼得更准</button>
        <button class="ghost" id="pf-cancel">取消</button>
      </div>
    `;
}

function fillProjFields(d) {
  $('pf-name').value = d.name || '';
  $('pf-goal').value = d.goal || '';
  $('pf-stage').value = d.stage || 'prototype';
  $('pf-stack').value = (d.stack || []).join(', ');
  $('pf-deps').value = (d.keyDeps || []).map((x) => `${x.name}${x.why ? '：' + x.why : ''}`).join('\n');
  $('pf-focus').value = d.focus || '';
  $('pf-cons').value = (d.constraints || []).join('\n');
}

function readProjFields() {
  return {
    name: $('pf-name').value.trim() || '未命名项目',
    goal: $('pf-goal').value.trim(),
    stage: $('pf-stage').value,
    stack: $('pf-stack').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    keyDeps: $('pf-deps').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, ...why] = l.split(/[：:]/);
      return { name: name.trim(), why: why.join('：').trim() };
    }),
    focus: $('pf-focus').value.trim(),
    constraints: $('pf-cons').value.split('\n').map((l) => l.trim()).filter(Boolean),
  };
}

// 摘要卡：「我理解你的项目是…」——推断内容明确标注
function renderSummary(d) {
  const inferred = d.source !== 'manual';
  const srcTxt = `来源：${LABELS.src[d.source] || d.source || '手动填写'}${inferred ? '（推断，待确认）' : '（你确认过）'}`;
  $('pf-summary').innerHTML = `
    <div class="sum-head">我理解你的项目是——</div>
    <div class="sum-name">「${esc(d.name)}」<span class="tag inf-tag">${inferred ? '推断' : '已确认'}</span></div>
    ${d.goal ? `<div class="sum-goal">${esc(d.goal)}${inferred ? ' <span class="tag inf-tag">推断</span>' : ''}</div>` : ''}
    <div class="sum-row"><span class="sum-k">阶段</span><span>${LABELS.stage[d.stage] || d.stage}${inferred ? ' <span class="tag inf-tag">推断</span>' : ''}</span></div>
    ${d.stack?.length ? `<div class="sum-row"><span class="sum-k">技术栈</span><span class="sum-chips">${d.stack.slice(0, 8).map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</span></div>` : ''}
    ${d.keyDeps?.length ? `<div class="sum-row"><span class="sum-k">依赖</span><span>${d.keyDeps.slice(0, 6).map((x) => esc(x.name)).join('、')}${d.keyDeps.length > 6 ? ` 等 ${d.keyDeps.length} 个` : ''}</span></div>` : ''}
    ${d.focus ? `<div class="sum-row"><span class="sum-k">当前重点</span><span>${esc(d.focus)}</span></div>` : ''}
    <div class="sum-src">${esc(srcTxt)}${d.updatedAt ? ` · 更新于 ${esc(new Date(d.updatedAt).toLocaleString())}` : ''} · 请在下方确认目标与当前重点</div>`;
}

function openProjectForm(project = null) {
  S.editingProjectId = project?.id || null;
  S.form = { draft: null, dirty: false, source: 'manual' };
  const form = $('project-form');
  form.classList.remove('hidden');
  $('view-projects').classList.add('editing-project');
  form.innerHTML = projFormShell();
  form.scrollIntoView?.({ behavior: 'smooth' });

  const startScan = async (folderPath) => {
    $('pf-note').textContent = '扫描中…';
    try {
      const { draft } = await api('/api/projects/scan', { method: 'POST', body: JSON.stringify({ path: folderPath }) });
      acceptDraft(draft, '本地扫描完成，确认理解或让 AI 提炼');
      if (!HAS_ELECTRON) $('pf-path').value = folderPath;
    } catch (e) { $('pf-note').textContent = `扫描失败：${e.message}`; }
  };

  if (HAS_ELECTRON) {
    $('pf-pick').onclick = async () => {
      const dir = await window.electronAPI.pickFolder();
      if (dir) { S.form.path = dir; startScan(dir); }
    };
  } else {
    $('pf-scan').onclick = () => {
      const path = $('pf-path').value.trim();
      if (!path) { toast('先填项目目录'); return; }
      S.form.path = path;
      startScan(path);
    };
  }

  function acceptDraft(draft, note) {
    $('pf-confirm-step').classList.remove('hidden');
    S.form.draft = draft; S.form.dirty = false; S.form.source = draft.source || 'scan';
    if (S.editingProjectId) S.form.path = S.form.path || project.path;
    fillProjFields(draft);
    renderSummary(draft);
    $('pf-save').disabled = false;
    $('pf-enhance').disabled = false;
    $('pf-note').textContent = note;
  }

  // 编辑已有项目：直接展示当前理解
  if (project?.context) acceptDraft(project.context, '当前保存的理解，可直接确认或调整');

  // 手动调整 = 用户改字段 → 来源转 manual
  form.oninput = () => {
    S.form.dirty = true;
    renderSummary({ ...readProjFields(), source: 'manual', updatedAt: project?.context?.updatedAt });
  };
  form.onchange = () => {
    S.form.dirty = true;
    renderSummary({ ...readProjFields(), source: 'manual', updatedAt: project?.context?.updatedAt });
  };

  $('pf-enhance').onclick = async () => {
    const path = S.form.path || S.projects.find((p) => p.id === S.editingProjectId)?.path;
    if (!path) { toast('先选择项目文件夹'); return; }
    $('pf-note').textContent = 'AI 读取并提炼项目上下文…（可能需要 30–60 秒）';
    $('pf-enhance').disabled = true;
    try {
      const { jobId } = await api('/api/projects/enhance', { method: 'POST', body: JSON.stringify({ path }) });
      const { draft } = await pollJob(jobId, (s) => { $('pf-note').textContent = `${s}…`; });
      acceptDraft({ ...draft, source: 'enhance' }, '✓ AI 已提炼，确认后保存');
    } catch (e) { $('pf-note').textContent = `增强失败：${e.message}`; }
    $('pf-enhance').disabled = false;
  };

  $('pf-cancel').onclick = () => { form.classList.add('hidden'); $('view-projects').classList.remove('editing-project'); S.editingProjectId = null; };
  $('pf-save').onclick = async () => {
    const path = S.form.path || S.projects.find((p) => p.id === S.editingProjectId)?.path;
    if (!path) { toast('先选择项目文件夹'); return; }
    const context = S.form.dirty || !S.form.draft
      ? readProjFields()
      : S.form.draft;
    const source = S.form.dirty ? 'manual' : (S.form.draft?.source || 'manual');
    try {
      if (S.editingProjectId) {
        await api(`/api/projects/${S.editingProjectId}`, { method: 'PUT', body: JSON.stringify({ context: { ...context, source } }) });
      } else {
        await api('/api/projects', { method: 'POST', body: JSON.stringify({ path, context: { ...context, source } }) });
      }
      form.classList.add('hidden'); S.editingProjectId = null;
      $('view-projects').classList.remove('editing-project');
      $('project-access').open = false;
      const wasFirst = !S.projects.length;
      await refreshMain();
      switchView('main');
      if (S.analysis) renderAnalysis(S.analysis);
      toast('✓ 项目已关联，现在输入一个技术词试试');
      if (wasFirst) $('input').focus();
    } catch (e) { toast(`保存失败：${e.message}`); }
  };
}

async function refreshProject(p) {
  toast('重新提炼中，需要几十秒…');
  try {
    const { jobId } = await api(`/api/projects/${p.id}/refresh`, { method: 'POST', body: JSON.stringify({}) });
    await pollJob(jobId);
    renderProjectList();
    await refreshMain();
    toast('✓ 项目理解已刷新');
  } catch (e) { toast(`刷新失败：${e.message}`); }
}

// ---------- 历史视图 ----------
async function renderDeferred() {
  const list = $('later-list');
  try {
    const { items } = await api('/api/later');
    list.innerHTML = '<h3>以后看</h3><p class="connection-note">按触发条件留待需要时再看，不自动监控项目。</p>';
    if (!items.length) list.innerHTML += '<p class="connection-note">在分析结果中点「加入以后看」，即可保留技术与项目的对应关系。</p>';
    for (const item of items.slice().reverse()) {
      const el = document.createElement('div'); el.className = 'later-item';
      el.innerHTML = `<b>${esc(item.term)}</b><p>${esc(item.projectName)}${item.projectMissing ? ' · 项目已移除' : item.needsReview ? ' · 项目资料已更新，建议复看（不代表条件已满足）' : ''}</p><p>${esc(item.futureTrigger)}</p><button class="ghost later-open">查看原判断</button> <button class="ghost later-remove">移出清单</button>`;
      el.querySelector('.later-open').onclick = async () => { try { const full = await api(`/api/analyses/${item.analysisId}`); switchView('main'); renderAnalysis(full.analysis); } catch(e) { toast(e.message); } };
      el.querySelector('.later-remove').onclick = async () => { try { await api('/api/later', { method: 'DELETE', body: JSON.stringify({ id: item.id }) }); await renderDeferred(); } catch(e) { toast(e.message); } };
      list.appendChild(el);
    }
    list.insertAdjacentHTML('beforeend', '<h3>全部分析</h3>');
  } catch(e) { list.textContent = `清单读取失败：${e.message}`; }
}

function groupHistory(analyses) {
  const groups = new Map();
  for (const a of analyses) {
    const raw = String(a.input?.value || a.normalized?.ref || '').trim();
    let key;
    // Conservative matching: never merge screenshots or merely similar model-generated titles.
    if (a.input?.type === 'image' || !raw) key = `record:${a.id}`;
    else {
      let value = raw.replace(/\s+/g, ' ').toLowerCase();
      try { const url = new URL(raw); if (/^https?:$/.test(url.protocol)) {
        url.hash = ''; url.hostname = url.hostname.toLowerCase();
        value = url.href; // Preserve case-sensitive paths and query strings.
      } } catch {}
      key = `${a.input?.type || 'text'}:${value}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return [...groups.values()];
}

async function renderHistory() {
  await renderDeferred();
  const { analyses } = await api('/api/analyses?limit=100');
  const list = $('history-list');
  if (!analyses.length) {
    list.innerHTML = `<div class="hint-card">还没有分析记录。<br><button class="primary small" style="margin-top:8px" onclick="document.getElementById('nav-main').click()">去输入第一个技术词</button></div>`;
    return;
  }
  list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', '<p class="connection-note">最近 100 条按相同输入分组；每次判断与当时项目资料均保留。</p>');
  for (const records of groupHistory(analyses)) {
    const a = records[0];
    const el = document.createElement('details');
    el.className = 'hist-item';
    const ref = a.normalized?.title || a.normalized?.ref || a.input?.value || '(无标题)';
    el.innerHTML = `
      <summary><span class="hist-row1"><span class="hist-ref">${esc(String(ref).slice(0, 60))}</span><span class="hist-time">${records.length} 次分析</span></span><span class="connection-note">最近 ${timeago(a.createdAt)} · 展开查看</span></summary>
      <div class="history-versions"></div>`;
    for (const record of records) {
      const button = document.createElement('button'); button.className = 'history-version ghost';
      const projects = (record.contextsSnapshot || []).map(p => p.name || p.context?.name).filter(Boolean).join('、');
      button.textContent = `${new Date(record.createdAt).toLocaleString()} · ${LABELS.agentName[record.agentUsed] || record.agentUsed || '分析记录'}${projects ? ' · ' + projects : ''}${identityUnresolved(record) ? ' · 身份待确认' : ''}`;
      button.onclick = async () => {
        try {
          const full = await api(`/api/analyses/${record.id}`);
          switchView('main'); renderAnalysis(full.analysis, full.feedback);
        } catch(e) { toast(`读取失败：${e.message}`); }
      };
      el.querySelector('.history-versions').appendChild(button);
    }
    list.appendChild(el);
  }
}

// ---------- 设置视图 ----------
async function renderSettings() {
  const st = await api('/api/state');
  S.mcp = st.mcp;
  const body = $('settings-body');
  const detected = st.agents.detected.map((a) => LABELS.agentName[a]).join('、') || '未检测到';
  body.innerHTML = `
    <div class="settings-row"><span class="sk">首选 Agent</span>
      <select id="set-agent">
        <option value="claude">Claude Code</option>
        <option value="codex">Codex CLI</option>
        <option value="api">自定义 API 模型</option>
      </select>
    </div>
    <div class="settings-row"><span class="sk">已检测到的 Agent</span><span class="sv">${esc(detected)}</span></div>
    <p class="connection-note">找到程序 ≠ 已登录可用。下面发送一条最小测试，不含项目内容，可能使用少量额度；不验证联网搜索。</p>
    <button class="ghost" id="cli-test">测试所选模型响应</button><p id="cli-status" role="status"></p>
    <div class="settings-row"><span class="sk">数据目录</span><span class="sv">${esc(st.dataDir)}</span></div>
    <div class="settings-row"><span class="sk">版本</span><span class="sv">TechCompass v${esc(st.version)}</span></div>
    <div class="settings-row"><span class="sk">分析总数</span><span class="sv">${st.analysesCount}</span></div>
    <div class="settings-block">
      <h3>自定义分析模型</h3>
      <p>Codex 模式一次完成联网检索和项目判断，搜索只使用技术关键词，不应包含项目私密信息。其他模型仍先借助 Codex 检索，再分析。需要 Codex 登录和额度；直接链接读取原文。</p>
      <p>兼容 OpenAI Chat Completions 的服务。项目摘要和输入会发送到你填写的服务；由该服务计费。</p>
      <label>API 地址（含 /v1 等前缀）<input id="api-url" type="url" placeholder="https://服务地址/v1" value="${esc(st.settings.apiProvider?.baseUrl || '')}"></label>
      <label>模型名称<input id="api-model" placeholder="服务商提供的模型 ID" value="${esc(st.settings.apiProvider?.model || '')}"></label>
      <label>API Key<input id="api-key" type="password" autocomplete="off" placeholder="${st.apiKeyConfigured ? '已保存，留空保持不变' : '填写你的 API Key'}"></label>
      <p>${st.apiKeyPersistent ? '密钥由 Windows 本机加密保存，不会显示或打包进源码。' : '当前环境无法加密持久保存，密钥仅本次运行有效。'}</p>
      <button id="api-save" class="primary">保存 API 模型</button>
      <button id="api-test" class="ghost">测试连接</button>
      <button id="api-remove" class="ghost">移除</button>
      <p id="api-status" role="status"></p>
    </div>
    <div class="settings-block">
      <h3>MCP 接入（Agent 会话 ↔ 卡片同步）</h3>
      <div id="mcp-slot"></div>
    </div>
    <div style="margin-top:10px;color:var(--dim);font-size:11.5px">
      项目来源与分析模型是两回事：MCP 同步 Agent 提供的项目摘要；本地 CLI 或 API 负责本次分析。不会自动读取所有会话。自动模式只尝试真实模型，不会降级为演示。CLI 使用原账号额度，并非免费。
    </div>`;
  const sel = $('set-agent');
  $('cli-test').onclick = async e => {
    e.currentTarget.disabled = true; $('cli-status').textContent = '测试中…';
    try {
      const { jobId } = await api('/api/agent/test', { method: 'POST', body: JSON.stringify({ agentId: sel.value }) });
      await pollJob(jobId); $('cli-status').textContent = '本次响应成功。联网搜索在实际分析时另行验证。';
    } catch(e) { $('cli-status').textContent = `${e.message}。请检查对应 CLI 的登录/额度，或配置 API。`; }
    finally { if ($('cli-test')) $('cli-test').disabled = false; }
  };
  sel.value = st.agents.preferred[0] || 'codex';
  sel.onchange = async () => {
    const order = sel.value === 'api' ? ['api'] : sel.value === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ preferredAgents: order }) });
    S.settings.preferredAgents = order;
    toast('已保存');
    await refreshMain();
  };
  renderMcpBlock($('mcp-slot'));
  const providerAction = async (button, action) => {
    button.disabled = true;
    $('api-status').textContent = '处理中…';
    try { await action(); } catch (e) { $('api-status').textContent = e.message; }
    finally { button.disabled = false; }
  };
  $('api-save').onclick = e => providerAction(e.target, async () => {
    await api('/api/provider', { method: 'PUT', body: JSON.stringify({ baseUrl: $('api-url').value, model: $('api-model').value, apiKey: $('api-key').value }) });
    $('api-key').value = '';
    $('api-status').textContent = '已保存。点击测试连接，分析时选择自定义 API 模型。';
    await refreshMain();
  });
  $('api-test').onclick = e => providerAction(e.target, async () => {
    await api('/api/provider/test', { method: 'POST', body: '{}' });
    $('api-status').textContent = '连接成功。测试请求也可能产生少量费用。';
  });
  $('api-remove').onclick = e => providerAction(e.target, async () => {
    await api('/api/provider', { method: 'DELETE' });
    await renderSettings();
    await refreshMain();
  });
}

// ---------- 事件绑定 ----------
const snake = mountSnake($('snake-canvas'), $('snake-score'));
$('snake-start').onclick = () => { if (S.busy) snake.start(); };
$('snake-panel').ontoggle = () => { if (!$('snake-panel').open) snake.pause(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) snake.pause(); });
$('review-notice').onclick = () => switchView('history');
$('btn-cancel').onclick = async () => {
  if (!S.jobId) return;
  $('btn-cancel').disabled = true;
  try { await api(`/api/jobs/${S.jobId}/cancel`, { method: 'POST', body: '{}' }); }
  catch(e) { toast(`取消未确认：${e.message}`); $('btn-cancel').disabled = false; }
};
$('btn-analyze').onclick = analyze;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); analyze(); }
});
$('nav-main').onclick = () => switchView('main');
$('nav-projects').onclick = () => switchView('projects');
$('nav-history').onclick = () => switchView('history');
$('nav-settings').onclick = () => switchView('settings');
window.addEventListener('focus', () => { if (!$('view-main').classList.contains('hidden')) refreshMain(); });
document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => switchView('main'); });
$('btn-add-project').onclick = () => openProjectForm(null);
$('project-mcp-settings').onclick = () => switchView('settings');
$('project-refresh-list').onclick = () => renderProjectList();
$('copy-register-command').onclick = async () => {
  try { await navigator.clipboard.writeText($('agent-register-command').textContent); toast('已复制，请粘贴到打开项目的 Agent 会话'); }
  catch { toast('无法自动复制，请选中上方指令后复制'); }
};
$('btn-collapse').onclick = toggleCollapse;

function toggleCollapse() {
  snake.pause();
  document.body.classList.toggle('collapsed');
  const collapsed = document.body.classList.contains('collapsed');
  $('btn-collapse').innerHTML = icon(collapsed ? 'plus' : 'minus');
  window.electronAPI?.setCollapsed(collapsed);
}
// Electron 托盘 / 快捷键触发的收起展开
window.electronAPI?.onCollapseToggle?.(() => toggleCollapse());

boot();
