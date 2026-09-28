// mcp/server.js — TechCompass MCP Server（stdio）
// 四个工具，供 Claude Code / Codex / Cursor / Windsurf 等会话内调用：
//   register_project  Agent 自己读项目后总结注册（它有文件权限，上下文质量更高）
//   list_projects     列出已关联项目与上下文
//   get_analysis_rubric  归一化输入 + 项目上下文 + 评分契约（host Agent 自己推理）
//   save_analysis     校验并保存分析结果（卡片历史同步可见）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Store, newId, defaultDataDir } from '../lib/store.js';
import { scanProject, scanSummaryForPrompt, draftContextFromScan } from '../lib/scanner.js';
import { normalizeInput } from '../lib/normalizer.js';
import { MODEL_GUIDANCE } from '../lib/prompt.js';
import {
  validateContext, sanitizeContext, sanitizeAnalysis, PROMPT_VERSION, RELEVANCE_LEVELS, VERDICTS, STAGES,
} from '../lib/contracts.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMcpServer(store = new Store(defaultDataDir())) {
const server = new McpServer({ name: 'techcompass', version: VERSION });

const ContextShape = z.object({
  name: z.string().optional(),
  goal: z.string().optional(),
  stage: z.enum(STAGES).optional(),
  stack: z.array(z.string()).optional(),
  keyDeps: z.array(z.object({ name: z.string(), why: z.string().optional() })).optional(),
  focus: z.string().optional(),
  constraints: z.array(z.string()).optional(),
}).describe('项目上下文。建议你先读项目文件再总结；也可以不传，由本地扫描生成草稿。');

server.tool(
  'register_project',
  '把一个项目注册进 TechCompass（ TechCompass 会用它的上下文做新技术判断）。建议流程：你先读取该项目的 README / 依赖清单 / 近期提交，总结出 context 再传入。',
  { path: z.string().describe('项目绝对路径'), context: ContextShape.optional() },
  async ({ path: dir, context }) => {
    let scan;
    try { scan = scanProject(dir); } catch (err) { return { content: [{ type: 'text', text: `扫描失败: ${err.message}` }], isError: true }; }
    const { projects } = store.readData();
    let project = projects.find((p) => p.path === path.resolve(dir));
    if (!project) {
      project = { id: newId('pj'), path: path.resolve(dir), createdAt: new Date().toISOString() };
      await store.upsertProject(project);
    }
    const draft = context
      ? sanitizeContext({ ...draftContextFromScan(scan, project.id), ...context, source: 'agent', projectId: project.id })
      : draftContextFromScan(scan, project.id);
    const errs = validateContext(draft);
    if (errs.length) return { content: [{ type: 'text', text: `context 不合法:\n${errs.join('\n')}` }], isError: true };
    await store.saveContext(draft);
    return { content: [{ type: 'text', text: `已注册项目「${draft.name}」。\n当前上下文:\n${JSON.stringify(store.readData().contexts[project.id], null, 2)}\n\n用户可在卡片里查看、纠正或刷新这份理解。` }] };
  },
);

server.tool(
  'list_projects',
  '列出用户已关联的所有项目及上下文',
  {},
  async () => {
    const ctxs = store.getContexts();
    if (!ctxs.length) return { content: [{ type: 'text', text: '还没有关联项目。可用 register_project 注册。' }] };
    return { content: [{ type: 'text', text: ctxs.map((c) => JSON.stringify(c)).join('\n\n') }] };
  },
);

server.tool(
  'get_analysis_rubric',
  '拿到一次「新技术 × 我的项目」分析所需的全部材料：归一化后的输入、用户项目上下文、评分契约。由你（会话中的 Agent）直接完成分析，然后把结果传给 save_analysis 保存。',
  { content: z.string().describe('要分析的内容：技术名词 / 链接 / 描述。链接会自动抓取。') },
  async ({ content }) => {
    let normalized;
    try {
      normalized = await normalizeInput({ type: 'text', value: content }, { tmpDir: store.tmpDir });
    } catch (err) {
      return { content: [{ type: 'text', text: `输入归一化失败: ${err.message}` }], isError: true };
    }
    const contexts = store.getContexts();
    const rubric = {
      input: normalized,
      projects: contexts,
      rules: {
        '1 提取核心词': '1~3 个，各配 what（它是什么）/ solves（它解决什么问题），各一两句话',
        '2 逐项目判断': '对每个项目输出 relevance(high/medium/low，内容相关度) 和 verdict(try_now/later/ignore，现在是否值得投入)。两者独立：相关不等于值得用。',
        '3 reasoning 引用项目具体内容': '技术栈/依赖/当前任务/约束；禁止“因为热门”。无关项目直接 low/ignore 并说明。',
        '4 role': 'fit=适用位置（没有适用位置必须明说）；replaces/complements/cost 可为 null。',
        '5 动作与情境': 'try_now 必给 tryAction（半天内可完成的验证动作）；later/ignore 必给 futureTrigger（什么需求/阶段出现才值得再看）。',
        '6 missing': '信息不足时列出要问用户的问题（≤5 条），不要瞎猜。',
        '7 克制': '「当前可以忽略」是有价值的结论，不要把每条输入都变成学习任务。',
        '8 技术身份': 'identityStatus=identified/unverified/ambiguous。无法确认身份或存在歧义时 projects=[]，不得用 low/ignore 代替未知；missing 可请求拼写、链接或用途。没有项目时正常解释名词，projects=[]，无需索要项目信息。',
        '9 模型比较': MODEL_GUIDANCE + '已确认模型 kind=model，必须返回 comparison，证据不足时 status=insufficient 且 changes=[]，不要编造升级结论。普通技术或身份未确认时 comparison=null。',
        '10 展示筛选': '每个已确认名词提供 applicationExample，举一个具体假设应用场景。完整评估所有项目，界面只显示 high/medium，不显示 low，禁止为进入列表而抬高相关性。',
      },
      outputSchema: {
        identityStatus: 'identified|unverified|ambiguous',
        terms: [{ term: 'string', what: 'string', solves: 'string', kind: 'technology|model', applicationExample: '具体假设应用场景', comparison: { status: 'supported|insufficient', baseline: '对比型号及选择理由', changes: ['具体变化及实际影响，最多3条'], tradeoffs: '代价和未核实维度', upgradeAdvice: '值得换与不必换的条件', sources: ['实际查阅的 http(s) URL，supported 时必填'] } }],
        projects: [{
          projectId: '必须与上面 projects 的 projectId 完全一致',
          relevance: 'high|medium|low', verdict: 'try_now|later|ignore',
          reasoning: 'string',
          role: { fit: 'string', replaces: 'string|null', complements: 'string|null', cost: 'string|null' },
          tryAction: 'string|null', futureTrigger: 'string|null',
        }],
        missing: ['string'],
      },
      note: '分析完成后，把完整 JSON 作为 result 参数调用 save_analysis。',
    };
    return { content: [{ type: 'text', text: JSON.stringify(rubric, null, 2) }] };
  },
);

server.tool(
  'save_analysis',
  '保存一次分析结果（需通过契约校验），保存后用户在 TechCompass 卡片的历史里可见，并可对判断提交反馈。',
  {
    content: z.string().describe('用户原始输入（用于归档与缓存键）'),
    result: z.object({
      identityStatus: z.enum(['identified', 'unverified', 'ambiguous']).optional(),
      terms: z.array(z.object({
        term: z.string(), what: z.string(), solves: z.string(),
        kind: z.enum(['technology', 'model']).optional(),
        applicationExample: z.string().max(400).optional(),
        comparison: z.object({
          status: z.enum(['supported', 'insufficient']), baseline: z.string(),
          changes: z.array(z.string()).max(3), tradeoffs: z.string(), upgradeAdvice: z.string(),
          sources: z.array(z.string()).max(6),
        }).nullable().optional(),
      })).min(1).max(3),
      projects: z.array(z.object({
        projectId: z.string(),
        relevance: z.enum(RELEVANCE_LEVELS),
        verdict: z.enum(VERDICTS),
        reasoning: z.string(),
        role: z.object({ fit: z.string(), replaces: z.string().nullable().optional(), complements: z.string().nullable().optional(), cost: z.string().nullable().optional() }),
        tryAction: z.string().nullable().optional(),
        futureTrigger: z.string().nullable().optional(),
      })),
      missing: z.array(z.string()).optional(),
    }),
  },
  async ({ content, result }) => {
    const contexts = store.getContexts();
    const clean = sanitizeAnalysis(result);
    // 业务规则校验（try_now⇒tryAction 等）在 contracts.validateAnalysis
    const { validateAnalysis } = await import('../lib/contracts.js');
    const errs = validateAnalysis(clean, contexts.map((c) => c.projectId));
    if (errs.length) return { content: [{ type: 'text', text: `结果未通过契约校验:\n${errs.join('\n')}\n请修正后重试。` }], isError: true };
    const row = {
      id: newId('an'),
      createdAt: new Date().toISOString(),
      input: { type: 'text', value: String(content).slice(0, 300) },
      normalized: { type: 'text', ref: String(content).slice(0, 200), title: null },
      agentUsed: 'mcp-session',
      promptVersion: PROMPT_VERSION,
      result: clean,
      contextsSnapshot: contexts,
    };
    await store.appendAnalysis(row);
    return { content: [{ type: 'text', text: `已保存（id: ${row.id}）。可在卡片「历史」中查看。` }] };
  },
);

return server;
}
