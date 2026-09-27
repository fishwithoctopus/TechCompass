# 架构

> v1 · 2026-09-27 · 与 `docs/techcompass-architecture-v1.md`（产品设计稿）配套的实现文档

## 总览

```
┌────────────────────────────────┐
│  桌面卡片 card/（Electron）      │  托盘 + 无边框置顶窗 + Ctrl+Shift+T + 粘贴截图
│  ui/（无框架 Web UI）            │  由 daemon 直接托管，浏览器也能访问（开发模式）
└──────────────┬─────────────────┘
               │ HTTP 127.0.0.1:47423 + token
┌──────────────▼─────────────────┐
│  Daemon lib/server.js           │  项目/分析/反馈/设置 API + 任务轮询
│  ├ lib/pipeline.js 分析管线      │  归一化 → 缓存 → prompt → 借脑 → 契约校验 → 落库
│  ├ lib/agentbridge.js           │  claude -p / codex exec / mock 三适配器 + 降级链
│  └ lib/store.js                 │  data.json + analyses.jsonl + feedback.jsonl（O_EXCL 锁）
└──────────────┬─────────────────┘
               │ 共享同一存储目录 ~/.techcompass
┌──────────────▼─────────────────┐
│  MCP server mcp/server.js       │  Agent 会话内 4 工具，由 Agent 进程拉起
└────────────────────────────────┘
```

## 关键决策

| 决策 | 理由 |
|---|---|
| 存储用 JSON/JSONL 文件而非 SQLite | 零 native 依赖，Electron/Windows 打包无原生模块风险；写入量小，O_EXCL 锁足够 |
| UI 无框架无构建 | 卡片由 daemon 托管，浏览器可直接访问 → E2E 可测；Electron 只是壳 |
| 借脑 = headless CLI | 用户已为 Agent 付费，不引入第二份 API Key；claude→codex→mock 降级链 |
| relevance 与 verdict 独立 | 产品核心原则：相关 ≠ 值得投入，契约强制分开（contracts.js） |
| try_now ⇒ tryAction，later/ignore ⇒ futureTrigger | 契约校验强制（validateAnalysis），prompt 明文要求 |
| MCP 工具最小化（4 个） | 会话内由 host Agent 自己推理（get_analysis_rubric），不必再 headless |

## 数据流

**分析**：`input(text|link|image)` → `normalizeInput`（GitHub API / 网页正文 / 截图落盘）→ cacheKey（含 prompt 版本与项目版本）→ `buildAnalysisPrompt` → agent 链执行 → `extractJson` → `validateAnalysis`（失败带错误回喂重试一次）→ `sanitizeAnalysis` → `analyses.jsonl`

**上下文**：`scanProject`（README/清单/目录树/git log，零 token）→ 草稿 → 可选 `enhance`（Agent 提炼）→ 用户确认 → `data.json`

**MCP 与卡片共享存储**：MCP 的 register_project/save_analysis 直接写同一目录；文件锁保证与 daemon 并发安全。

## 安全模型

- daemon 只绑 127.0.0.1；/api/* 需要 token（`~/.techcompass/token`，600 权限）
- 扫描只读项目元文件（README/清单/目录名/git log oneline），不读源码内容
- 无任何网络上报；链接抓取只发生在用户显式输入时
- Agent headless 调用的工作目录是数据目录，prompt 不含敏感信息

## 测试

`node --test test/` 覆盖：契约（含业务规则）、存储（并发锁）、扫描、归一化、管线（mock 全链路+缓存）、HTTP E2E（完整用户流）、MCP stdio 协议、安装器（注册/注销/幂等/TOML 转义）。UI 另有 Playwright 冒烟（`test/ui.e2e.mjs`，需本地 `npm i -D playwright`）。
