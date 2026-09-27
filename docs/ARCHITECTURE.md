# 架构

> 实现说明 · 0.3.2 与主分支 Mac 适配 · 2026-09-27

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
│  ├ lib/agentbridge.js           │  claude / codex / API；mock 仅显式选择
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
| headless CLI 与自定义 API | 可复用本机已登录 Agent，也可配置 API；真实调用不降级为 mock，调用仍消耗相应额度 |
| relevance 与 verdict 独立 | 产品核心原则：相关 ≠ 值得投入，契约强制分开（contracts.js） |
| try_now ⇒ tryAction，later/ignore ⇒ futureTrigger | 契约校验强制（validateAnalysis），prompt 明文要求 |
| MCP 工具最小化（4 个） | 会话内由 host Agent 自己推理（get_analysis_rubric），不必再 headless |

## 数据流

**分析**：`input(text|link|image)` → `normalizeInput`（链接正文 / 截图落盘）→ 项目上下文与缓存检查 → 检索和模型分析 → `extractJson` → `validateAnalysis` → `sanitizeAnalysis` → `analyses.jsonl`。Codex 关键词/截图路径将搜索和判断合并为一次调用，校验真实 web_search 完成事件；该路径格式异常直接报错，不隐式重试或换模型。其他模型仍先借助 Codex 检索再分析。链接直接读取原文。

**上下文**：`scanProject`（README/清单/目录树/git log，零 token）→ 草稿 → 可选 `enhance`（Agent 提炼）→ 用户确认 → `data.json`

**MCP 与卡片共享存储**：MCP 的 register_project/save_analysis 直接写同一目录；文件锁保证与 daemon 并发安全。

## 安全模型

- daemon 只绑 127.0.0.1；/api/* 需要 token（`~/.techcompass/token`，600 权限）
- 扫描只读项目元文件（README/清单/目录名/git log oneline），不读源码内容
- 不设置独立分析遥测上报；用户触发的搜索、链接读取和模型调用需要网络。
- 输入与必要项目上下文会发送给所选模型服务，不能保证 prompt 不含敏感信息；用户应限制关联和提交范围。
- 合并调用通过提示词禁止将项目私密信息放进搜索查询，不是独立的网络隔离。
- 反馈 UI 已移除；旧的兼容接口与历史存储仍保留，不表示自动学习。

## 测试

`node --test test/` 覆盖：契约（含业务规则）、存储（并发锁）、扫描、归一化、管线（mock 全链路+缓存）、HTTP E2E（完整用户流）、MCP stdio 协议、安装器（注册/注销/幂等/TOML 转义）。UI 另有 Playwright 冒烟（`test/ui.e2e.mjs`，需本地 `npm i -D playwright`）。
