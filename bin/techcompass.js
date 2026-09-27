#!/usr/bin/env node
// bin/techcompass.js — TechCompass CLI
// 用法：
//   techcompass init        注册 MCP 到已安装的 Agent（Claude Code/Codex/Cursor/Windsurf）
//   techcompass doctor      健康检查
//   techcompass daemon      前台启动本地服务（卡片后端；Electron 版会自动内嵌，无需手动跑）
//   techcompass analyze <内容> [--agent claude|codex|mock] [--json]   一次性分析（真实 Agent 冒烟用）
//   techcompass mcp         手动拉起 MCP server（调试用；正常由 Agent 自动拉起）
//   techcompass card        开发模式启动 Electron 卡片（需要 npm i 后的 electron）
//   techcompass uninstall   从各 Agent 注销 MCP
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;

const HELP = `TechCompass v${VERSION} — 新技术 × 我的项目

命令:
  init            注册 MCP 到 Claude Code / Codex / Cursor / Windsurf
  doctor          健康检查
  daemon          前台启动本地服务
  analyze <内容>  一次性分析（--agent claude|codex|mock, --json）
  mcp             手动拉起 MCP server（调试）
  card            开发模式启动 Electron 卡片
  uninstall       注销所有 Agent 的 MCP 配置

环境变量:
  TECHCOMPASS_HOME  数据目录（默认 ~/.techcompass）`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Map();
  const positional = [];
  for (const a of rest) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else flags.set(a.slice(2), true);
    } else positional.push(a);
  }
  const argAfter = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  switch (cmd) {
    case 'init': {
      console.log(`TechCompass v${VERSION} — 开始注册\n`);
      const { registerAll } = await import('../lib/installer.js');
      const mcpPath = path.join(ROOT, 'mcp', 'server.js');
      if (!fs.existsSync(mcpPath)) { console.error(`✗ 找不到 ${mcpPath}`); process.exit(1); }
      const { results } = await registerAll(mcpPath);
      for (const r of results) {
        console.log(`${r.ok ? '✓' : '✗'} ${r.agent.padEnd(9)} ${r.ok ? `配置已写入 → ${r.path}${r.backup ? '（已备份）' : ''}` : `失败: ${r.error}`}`);
        if (r.ok && r.probe) console.log(`            连通性: ${r.probe.ok ? '✓ ' + r.probe.detail : '✗ ' + r.probe.detail + '（不影响写入结果，请检查命令是否可执行）'}`);
      }
      const { detectAgents } = await import('../lib/agentbridge.js');
      const detected = detectAgents();
      console.log(`\n检测到的 Agent CLI: ${detected.length ? detected.join(', ') : '（未检测到 claude / codex 命令——卡片将使用演示引擎；安装其中之一即可获得真实分析）'}`);
      // 预生成数据目录与 token
      const { defaultDataDir } = await import('../lib/store.js');
      const { Store } = await import('../lib/store.js');
      const store = new Store(defaultDataDir());
      store.token();
      console.log(`\n数据目录: ${store.dir}`);
      console.log(`\n下一步:`);
      console.log(`  1. 重启你的 Agent（Claude Code / Codex / Cursor…），MCP 工具即可用`);
      console.log(`     会话里可以说: “把当前项目注册进 techcompass”、“用 techcompass 分析一下 <链接>”`);
      console.log(`  2. 安装悬浮卡片: 从 GitHub Releases 下载 TechCompass-Setup-x.x.x.exe`);
      console.log(`     （开发模式也可运行: techcompass card）`);
      break;
    }

    case 'doctor': {
      console.log(`TechCompass v${VERSION} 诊断\n`);
      const problems = [];
      const nv = process.versions.node.split('.').map(Number);
      if (nv[0] < 20) problems.push(`Node 版本过低 (${process.version}，需要 ≥20)`);
      console.log(`✓ Node ${process.version} (${process.platform})`);
      const { defaultDataDir, Store } = await import('../lib/store.js');
      const dir = defaultDataDir();
      const store = new Store(dir);
      try { store.token(); console.log(`✓ 数据目录可写: ${dir}`); } catch (e) { problems.push(`数据目录不可写: ${e.message}`); }
      const { detectAgents } = await import('../lib/agentbridge.js');
      const detected = detectAgents();
      console.log(`${detected.length ? '✓' : '!'} Agent CLI: ${detected.join(', ') || '未检测到（claude / codex）→ 卡片将使用演示引擎'}`);
      const { checkRegistrations } = await import('../lib/installer.js');
      const reg = checkRegistrations();
      for (const [agent, r] of Object.entries(reg)) {
        console.log(`${r.installed ? '✓' : '!'} MCP@${agent.padEnd(9)} ${r.installed ? '已注册' : '未注册'}${r.exists ? '' : '（配置文件不存在）'}`);
      }
      const projects = store.getProjects().length;
      console.log(`${projects ? '✓' : '!'} 已关联项目: ${projects} 个`);
      const analyses = store.listAnalyses(500).length;
      console.log(`✓ 历史分析: ${analyses} 条`);
      console.log(problems.length ? `\n发现 ${problems.length} 个问题:\n${problems.map((p) => `✗ ${p}`).join('\n')}` : '\n一切正常。');
      process.exit(problems.length ? 1 : 0);
      break;
    }

    case 'daemon': {
      const { startDaemon } = await import('../lib/server.js');
      const { defaultDataDir } = await import('../lib/store.js');
      const port = argAfter('port');
      const d = await startDaemon({ dataDir: defaultDataDir(), port: port ? Number(port) : undefined });
      console.log(`TechCompass daemon v${VERSION}`);
      console.log(`  地址: http://127.0.0.1:${d.port}/ui/?token=${d.token}`);
      console.log(`  数据: ${defaultDataDir()}`);
      console.log(`  Ctrl+C 退出`);
      break;
    }

    case 'analyze': {
      const content = positional.join(' ');
      if (!content) { console.error('用法: techcompass analyze <技术名词或链接>'); process.exit(1); }
      const { Store, defaultDataDir } = await import('../lib/store.js');
      const { Pipeline } = await import('../lib/pipeline.js');
      const store = new Store(defaultDataDir());
      const pipeline = new Pipeline({ store });
      const agent = argAfter('agent');
      process.stderr.write(`分析中（${agent || '自动'}）… 项目数: ${store.getContexts().length}\n`);
      try {
        const r = await pipeline.analyze({ type: /^https?:\/\//i.test(content) ? 'link' : 'text', value: content }, { agentId: agent, noCache: true });
        if (flags.has('json')) { console.log(JSON.stringify(r.result, null, 2)); }
        else {
          console.log(`\n■ ${r.result.terms.map((t) => t.term).join(' / ')}`);
          for (const t of r.result.terms) console.log(`  ${t.term}: ${t.what} ${t.solves}`);
          const ctxs = store.getContexts();
          for (const p of r.result.projects) {
            const name = ctxs.find((c) => c.projectId === p.projectId)?.name || p.projectId;
            console.log(`\n  [${name}] ${p.relevance} / ${p.verdict}`);
            console.log(`    ${p.reasoning}`);
            if (p.tryAction) console.log(`    → ${p.tryAction}`);
            if (p.futureTrigger) console.log(`    ↻ ${p.futureTrigger}`);
          }
          if (r.result.missing?.length) console.log(`\n  ? 需补充: ${r.result.missing.join('；')}`);
          console.log(`\n（agent: ${r.agentUsed}${r.fellBack ? '（降级）' : ''}）`);
        }
        process.exit(0);
      } catch (e) {
        console.error(`分析失败: ${e.message}`);
        if (e.errors) console.error(e.errors.join('\n'));
        process.exit(1);
      }
      break;
    }

    case 'mcp': {
      const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.js')], { stdio: 'inherit' });
      child.on('exit', (c) => process.exit(c ?? 0));
      break;
    }

    case 'card': {
      let electronBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
      if (!fs.existsSync(electronBin)) {
        console.error('开发模式需要先 npm install（electron 只作为 devDependency 安装）。\n正式使用请从 GitHub Releases 下载安装包。');
        process.exit(1);
      }
      const child = spawn(electronBin, ['.'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('exit', (c) => process.exit(c ?? 0));
      break;
    }

    case 'uninstall': {
      const { unregisterAll } = await import('../lib/installer.js');
      const results = unregisterAll();
      for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.agent}: ${r.ok ? '已注销' : r.error}`);
      console.log('\n（数据与历史保留在 ~/.techcompass，可手动删除）');
      break;
    }

    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
