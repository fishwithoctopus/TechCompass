// lib/scanner.js — 项目本地扫描：不花 token 的部分全部在这里完成
// 读取 README / 依赖清单 / 目录树 / git log，产出原始扫描 + 一份可用的草稿上下文
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizeContext } from './contracts.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'target', 'vendor',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage', '.cache',
]);

const MANIFESTS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'deno.json',
];

const STACK_HINTS = [
  { file: 'next.config.js', stack: 'Next.js' }, { file: 'next.config.mjs', stack: 'Next.js' },
  { file: 'next.config.ts', stack: 'Next.js' }, { file: 'nuxt.config.ts', stack: 'Nuxt' },
  { file: 'vite.config.ts', stack: 'Vite' }, { file: 'vite.config.js', stack: 'Vite' },
  { file: 'astro.config.mjs', stack: 'Astro' }, { file: 'tailwind.config.js', stack: 'Tailwind CSS' },
  { file: 'tailwind.config.ts', stack: 'Tailwind CSS' }, { file: 'docker-compose.yml', stack: 'Docker Compose' },
  { file: 'Dockerfile', stack: 'Docker' }, { file: 'prisma', stack: 'Prisma', dir: true },
  { file: 'supabase', stack: 'Supabase', dir: true },
];

function readText(p, max = 6000) {
  try { return fs.readFileSync(p, 'utf8').slice(0, max); } catch { return null; }
}

function treeOf(dir, maxEntries = 120) {
  const lines = [];
  const walk = (d, prefix, depth) => {
    if (depth > 2 || lines.length >= maxEntries) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries = entries.filter((e) => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= maxEntries) return;
      lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}  `, depth + 1);
    }
  };
  walk(dir, '', 0);
  return lines.join('\n');
}

function gitLogOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'log', '--oneline', '-n', '30'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

function parsePkgJson(dir) {
  const raw = readText(path.join(dir, 'package.json'), 20000);
  if (!raw) return null;
  try {
    const pkg = JSON.parse(raw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return {
      name: pkg.name || null,
      description: pkg.description || null,
      deps: Object.keys(deps).slice(0, 40),
      scripts: Object.keys(pkg.scripts || {}).slice(0, 15),
    };
  } catch { return null; }
}

function parseSimpleManifests(dir) {
  const out = [];
  for (const m of MANIFESTS) {
    if (m === 'package.json') continue;
    const p = path.join(dir, m);
    if (!fs.existsSync(p)) continue;
    const text = readText(p, 8000) || '';
    if (m === 'requirements.txt') {
      out.push({ manifest: m, deps: text.split('\n').map((l) => l.trim().split(/[=<>~]/)[0]).filter(Boolean).slice(0, 40) });
    } else if (m === 'pyproject.toml') {
      const name = text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] || null;
      const desc = text.match(/^description\s*=\s*"([^"]+)"/m)?.[1] || null;
      const deps = (text.match(/^\s*"([A-Za-z0-9_.-]+)(?:[<>=~!][^"]*)?"\s*$/gm) || []).length;
      out.push({ manifest: m, name, description: desc, depCount: deps });
    } else if (m === 'Cargo.toml') {
      const name = text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] || null;
      out.push({ manifest: m, name, deps: (text.match(/^[a-zA-Z0-9_-]+\s*=\s*[{"']/gm) || []).length - 2 });
    } else if (m === 'go.mod') {
      const name = text.match(/^module\s+(\S+)/m)?.[1] || null;
      const deps = (text.match(/^\t\S+\.\S+\/\S+/gm) || []).length;
      out.push({ manifest: m, name, deps });
    } else {
      out.push({ manifest: m, present: true });
    }
  }
  return out;
}

function detectStack(dir, pkg) {
  const stack = new Set();
  for (const h of STACK_HINTS) {
    const p = path.join(dir, h.file);
    const ok = h.dir ? fs.existsSync(p) && fs.statSync(p).isDirectory() : fs.existsSync(p);
    if (ok) stack.add(h.stack);
  }
  const deps = pkg?.deps || [];
  const depHints = {
    react: 'React', vue: 'Vue', svelte: 'Svelte', next: 'Next.js', 'nuxt': 'Nuxt', astro: 'Astro',
    express: 'Express', fastify: 'Fastify', koa: 'Koa', nestjs: 'NestJS', '@nestjs/core': 'NestJS',
    typescript: 'TypeScript', tailwindcss: 'Tailwind CSS', electron: 'Electron',
    'django': 'Django', fastapi: 'FastAPI', flask: 'Flask',
    prisma: 'Prisma ORM', typeorm: 'TypeORM', mongoose: 'MongoDB', 'pg': 'PostgreSQL',
    postgres: 'PostgreSQL', redis: 'Redis', graphql: 'GraphQL', 'react-native': 'React Native',
    expo: 'Expo', 'vite': 'Vite', webpack: 'Webpack', 'three': 'Three.js', '@vueuse/core': 'VueUse',
  };
  for (const d of deps) {
    const hit = depHints[d] || depHints[d.replace(/^@[^/]+\//, '')];
    if (hit) stack.add(hit);
  }
  return [...stack].slice(0, 12);
}

function readmeOf(dir) {
  for (const name of ['README.md', 'readme.md', 'README.MD', 'README', 'README.txt', 'Readme.md']) {
    const t = readText(path.join(dir, name), 5000);
    if (t) return t;
  }
  return null;
}

export function draftContextFromScan(scan, projectId) {
  const pkg = scan.pkgJson;
  const readme = scan.readme || '';
  const draft = { source: 'scan' }; // 本地扫描推断，非用户确认
  // goal：优先 manifest description，其次 README 第一段非标题文字
  let goal = pkg?.description || scan.manifests.find((m) => m.description)?.description || '';
  if (!goal) {
    const para = readme.split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('[') && !l.startsWith('<') && !l.startsWith('---'));
    goal = para.slice(0, 3).join(' ').slice(0, 300);
  }
  const stack = detectStack(scan.dir, pkg);
  const keyDeps = (pkg?.deps || []).slice(0, 8).map((name) => ({ name, why: '' }));
  return sanitizeContext({
    projectId,
    name: pkg?.name || scan.manifests.find((m) => m.name)?.name || path.basename(scan.dir),
    goal: goal || '（待补充：这个项目要做什么）',
    stage: 'prototype',
    stack,
    keyDeps,
    focus: '',
    constraints: [],
    source: draft.source,
  });
}

export function scanProject(dir) {
  const abs = path.resolve(dir);
  const st = fs.statSync(abs); // 不存在则抛错，由调用方处理
  if (!st.isDirectory()) throw new Error(`不是目录: ${abs}`);
  const readme = readmeOf(abs);
  const pkgJson = parsePkgJson(abs);
  const manifests = parseSimpleManifests(abs);
  const tree = treeOf(abs);
  const gitLog = gitLogOf(abs);
  const files = {};
  for (const m of MANIFESTS) {
    const p = path.join(abs, m);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files[m] = true;
  }
  return {
    dir: abs,
    name: pkgJson?.name || path.basename(abs),
    pkgJson,
    manifests,
    files,
    stackHints: detectStack(abs, pkgJson),
    readmeExcerpt: readme ? readme.slice(0, 4000) : null,
    tree: tree.slice(0, 6000),
    gitLog: gitLog ? gitLog.slice(0, 3000) : null,
    scannedAt: new Date().toISOString(),
  };
}

export function scanSummaryForPrompt(scan) {
  const parts = [`目录: ${scan.dir}`, `项目名: ${scan.name}`];
  if (scan.pkgJson) {
    if (scan.pkgJson.description) parts.push(`描述: ${scan.pkgJson.description}`);
    parts.push(`依赖: ${(scan.pkgJson.deps || []).join(', ')}`);
    if (scan.pkgJson.scripts?.length) parts.push(`脚本: ${scan.pkgJson.scripts.join(', ')}`);
  }
  if (scan.manifests.length) parts.push(`其他清单: ${JSON.stringify(scan.manifests)}`);
  if (scan.stackHints.length) parts.push(`检测到的技术栈: ${scan.stackHints.join(', ')}`);
  if (scan.readmeExcerpt) parts.push(`README 节选:\n${scan.readmeExcerpt.slice(0, 2500)}`);
  if (scan.tree) parts.push(`目录结构(截断):\n${scan.tree.slice(0, 2000)}`);
  if (scan.gitLog) parts.push(`近期提交:\n${scan.gitLog}`);
  return parts.join('\n');
}
