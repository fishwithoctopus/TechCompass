// assets/demo.js — 产品主页交互演示（静态 mock 数据，schema 与真实产品一致）
(() => {
  const publicDownloads = {
    'download/TechCompass-0.3.2-Windows.zip': 'https://github.com/fishwithoctopus/TechCompass/releases/download/v0.3.2/TechCompass-0.3.2-Windows.zip',
    'download/TechCompass-0.3.2-source.zip': 'https://github.com/fishwithoctopus/TechCompass/archive/refs/heads/main.zip',
    'download/START-HERE.md': 'https://github.com/fishwithoctopus/TechCompass#readme',
    'download/LICENSE.txt': 'https://github.com/fishwithoctopus/TechCompass/blob/main/LICENSE',
  };
  document.querySelectorAll('a[href]').forEach(a => {
    const target = publicDownloads[a.getAttribute('href')];
    if (target) { a.href = target; a.removeAttribute('download'); }
  });
  // 示例项目集（与页面提示一致）
  const DEMOS = {
    tauri: {
      input: 'Tauri 2.0',
      agent: 'claude',
      analysis: {
        terms: [{ term: 'Tauri 2.0', what: '用 Rust 构建桌面应用的框架，系统 WebView 替代 Chromium 内核。', solves: '解决 Electron 内存占用大、安装包大的问题，产物小一个量级。' }],
        projects: [
          { projectId: 'album', name: '拾光相册', relevance: 'high', verdict: 'try_now',
            reasoning: '拾光相册正是 Electron + React 的桌面壳，安装包 92MB、空载内存 380MB，Tauri 直接命中这两个痛点。',
            role: { fit: '替代现有 Electron 壳，React 代码基本复用', replaces: 'Electron 壳', complements: null, cost: '中：壳层重写 + 原生模块（相册缩略图）需适配' },
            tryAction: '拉一个 tauri 分支，用 2 小时把「照片网格」页面跑进 Tauri WebView，测安装包体积和内存基线。', futureTrigger: null },
          { projectId: 'bot', name: '技术周刊 Bot', relevance: 'low', verdict: 'ignore',
            reasoning: '周刊 Bot 是纯服务端 Node 项目，没有桌面端形态，Tauri 与它没有交集。',
            role: { fit: '当前没有适用位置。', replaces: null, complements: null, cost: null },
            tryAction: null, futureTrigger: '如果以后做 Bot 的桌面管理面板，再考虑用 Tauri。' },
          { projectId: 'site', name: '作品集网站', relevance: 'low', verdict: 'ignore',
            reasoning: '作品集是 Astro 静态站，部署在 Cloudflare Pages，浏览器即可访问，无需桌面形态。',
            role: { fit: '当前没有适用位置。', replaces: null, complements: null, cost: null },
            tryAction: null, futureTrigger: '若想把作品集打包成可分发的离线作品 U 盘应用，再评估。' },
        ],
        missing: [],
      },
    },
    'ai-sdk': {
      input: 'github.com/vercel/ai',
      agent: 'codex',
      analysis: {
        terms: [{ term: 'Vercel AI SDK', what: '给应用接入大模型的标准工具库（TypeScript）。', solves: '统一各模型的流式输出、工具调用、结构化生成接口，换模型不改业务代码。' }],
        projects: [
          { projectId: 'bot', name: '技术周刊 Bot', relevance: 'high', verdict: 'try_now',
            reasoning: '周刊 Bot 目前手写 fetch + 正则解析各模型响应，三家模型三套解析代码；AI SDK 的 streamText/generateObject 直接消掉这部分。',
            role: { fit: '替代手写的模型调用与解析层', replaces: '自写的 fetch+正则解析模块（约 400 行）', complements: null, cost: '低：纯库替换，一个下午' },
            tryAction: '在摘要功能上用 generateObject 生成结构化周刊条目，对比现有正则方案的健壮性。', futureTrigger: null },
          { projectId: 'album', name: '拾光相册', relevance: 'medium', verdict: 'later',
            reasoning: '相册里「智能分类」功能计划调用视觉模型，AI SDK 的多模态接口将来用得上，但该功能排在两个月后。',
            role: { fit: '用于规划中的 AI 分类功能', replaces: null, complements: '统一的多模态调用层', cost: '低：新增依赖' },
            tryAction: null, futureTrigger: '智能分类进入开发时，直接用 AI SDK 起步，不再自写调用层。' },
          { projectId: 'site', name: '作品集网站', relevance: 'low', verdict: 'ignore',
            reasoning: '静态站无任何模型调用场景。',
            role: { fit: '当前没有适用位置。', replaces: null, complements: null, cost: null },
            tryAction: null, futureTrigger: '如果作品集加「AI 导览」功能再评估。' },
        ],
        missing: [],
      },
    },
    news: {
      input: '截图示例：模型新闻',
      agent: 'claude',
      analysis: {
        terms: [
          { term: 'GLM-4.6', what: '新一代前沿模型，编程与推理能力提升。', solves: '更强的代码理解让 Agent 少改几轮就能跑对。' },
          { term: 'MCP', what: 'Model Context Protocol，连接 LLM 与外部工具/数据的开放协议。', solves: '解决每个工具为每个模型单独写集成的 N×M 问题。' },
        ],
        projects: [
          { projectId: 'bot', name: '技术周刊 Bot', relevance: 'high', verdict: 'try_now',
            reasoning: 'Bot 的摘要质量直接受益于更强模型；且周刊本身就该报道这条新闻，可作为本周选题。',
            role: { fit: '把摘要模型升级为 GLM-4.6，并作为选题素材', replaces: '现有摘要模型', complements: null, cost: '低：改一个环境变量' },
            tryAction: '同一批文章 A/B 两个模型的摘要质量，30 分钟出对比结论，顺便当本周刊内容。', futureTrigger: null },
          { projectId: 'album', name: '拾光相册', relevance: 'medium', verdict: 'later',
            reasoning: '智能分类目前依赖的视觉模型够用；等分类准确率成为痛点时再升级。',
            role: { fit: '智能分类功能的候选模型', replaces: null, complements: null, cost: '低' },
            tryAction: null, futureTrigger: '分类准确率低于 85% 或需要理解更复杂的照片语义时。' },
          { projectId: 'site', name: '作品集网站', relevance: 'low', verdict: 'ignore',
            reasoning: '纯静态站，无模型调用。',
            role: { fit: '当前没有适用位置。', replaces: null, complements: null, cost: null },
            tryAction: null, futureTrigger: '——' },
        ],
        missing: [],
      },
    },
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const VERDICT = { try_now: '现在值得尝试', later: '以后再看', ignore: '当前可以忽略' };
  const REL = { high: '高度相关', medium: '部分相关', low: '基本无关' };

  const resultEl = document.getElementById('dc-result');
  const statusEl = document.getElementById('dc-status');
  const inputEl = document.getElementById('dc-input');
  let activeTerm = 0;
  let timer = null;

  function renderTerm(demo) {
    const t = demo.analysis.terms[activeTerm];
    const multi = demo.analysis.terms.length > 1;
    return `
      ${multi ? `<div class="dc-terms">${demo.analysis.terms.map((x, i) =>
        `<button class="dc-term-tab${i === activeTerm ? ' active' : ''}" aria-pressed="${i === activeTerm}" data-term="${i}">${esc(x.term)}</button>`).join('')}</div>` : ''}
      <div class="dc-term-card">
        <b>${esc(t.term)}</b>
        <div><span class="lbl">是什么：</span>${esc(t.what)}</div>
        <div class="solves"><span class="lbl">解决什么：</span>${esc(t.solves)}</div>
      </div>`;
  }

  function renderProject(p, expanded) {
    const roleRows = [
      p.role.replaces ? `<div class="dc-kv"><span class="k">替代</span><span>${esc(p.role.replaces)}</span></div>` : '',
      p.role.complements ? `<div class="dc-kv"><span class="k">补充</span><span>${esc(p.role.complements)}</span></div>` : '',
      p.role.cost ? `<div class="dc-kv"><span class="k">成本</span><span>${esc(p.role.cost)}</span></div>` : '',
    ].join('');
    return `
      <div class="dc-proj${expanded ? ' open' : ''}" data-proj="${esc(p.projectId)}">
        <button class="dc-proj-head" aria-expanded="${expanded}">
          <span class="pname">${esc(p.name)}</span>
          <span class="b b-rel-${p.relevance}">${REL[p.relevance]}</span>
          <span class="b b-${p.verdict}">${VERDICT[p.verdict]}</span>
          <img class="chev" src="assets/icons/chevron-right.svg" alt="">
        </button>
        <div class="dc-proj-body">
          <div class="dc-sec"><div class="t">为什么</div><p>${esc(p.reasoning)}</p></div>
          <div class="dc-sec"><div class="t">它在项目里的位置</div><p>${esc(p.role.fit)}</p>${roleRows}</div>
          ${p.tryAction ? `<div class="dc-action"><b>验证动作</b>：${esc(p.tryAction)}</div>` : ''}
          ${p.futureTrigger && p.futureTrigger !== '——' ? `<div class="dc-trigger"><b>什么时候再看它</b>：${esc(p.futureTrigger)}</div>` : ''}
        </div>
      </div>`;
  }

  function render(demo) {
    resultEl.innerHTML = `
      ${renderTerm(demo)}
      <div class="dc-meta">预设示例 · 3 个虚构项目 · 对整条输入的综合判断，非实时分析</div>
      ${demo.analysis.projects.map((p, i) => renderProject(p, i === 0)).join('')}`;

    resultEl.querySelectorAll('.dc-term-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        activeTerm = Number(tab.dataset.term);
        render(demo); // 重渲染整个结果区（简单可靠）
      });
    });
    resultEl.querySelectorAll('.dc-proj-head').forEach((head) => {
      head.addEventListener('click', () => {const open=head.parentElement.classList.toggle('open');head.setAttribute('aria-expanded',String(open));});
    });
  }

  function play(key) {
    const demo = DEMOS[key];
    if (!demo) return;
    clearTimeout(timer);
    activeTerm = 0;
    inputEl.textContent = demo.input;
    statusEl.style.display = 'flex';
    statusEl.textContent = '正在展开预设示例…';
    resultEl.innerHTML = '';
    timer = setTimeout(() => {
      statusEl.style.display = 'none';
      render(demo);
    }, 100);
  }

  document.querySelectorAll('.dtab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.dtab').forEach((t) => {t.classList.remove('active');t.setAttribute('aria-pressed','false');});
      tab.classList.add('active');
      tab.setAttribute('aria-pressed','true');
      play(tab.dataset.q);
    });
  });

  // 首屏自动播第一个
  play('tauri');
})();
