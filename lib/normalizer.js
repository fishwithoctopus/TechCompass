// lib/normalizer.js — 把用户的原始输入（文字/链接/截图）归一化成分析管线可用的形态
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024;

export function isLink(text) {
  const t = (text || '').trim();
  return /^https?:\/\/\S+$/i.test(t);
}

async function fetchWithLimit(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'TechCompass/0.1 (+https://github.com/techcompass)', ...headers },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('内容过大');
    return { text: buf.toString('utf8'), status: res.status, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&hellip;/g, '…');
}

export function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<title[^>]*>([\s\S]*?)<\/title>/i, '\n<title>$1</title>\n');
  s = s.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function ghRepoFromUrl(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (!m) return null;
  if (['settings', 'orgs', 'topics', 'explore', 'features', 'marketplace', 'sponsors'].includes(m[1].toLowerCase())) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

async function normalizeGithub(url, repo) {
  const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const meta = await (async () => {
    try {
      const { text } = await fetchWithLimit(api, { accept: 'application/vnd.github+json' });
      return JSON.parse(text);
    } catch { return null; }
  })();
  let readme = '';
  try {
    const { text } = await fetchWithLimit(`${api}/readme`, { accept: 'application/vnd.github.raw' });
    readme = text.slice(0, 3000);
  } catch { /* 无 README */ }
  if (!meta && !readme) throw new Error('GitHub 仓库信息获取失败（可能触发限流，稍后再试或直接粘贴文字）');
  const parts = [];
  if (meta) {
    parts.push(`GitHub 仓库: ${meta.full_name}`);
    if (meta.description) parts.push(`描述: ${meta.description}`);
    parts.push(`主语言: ${meta.language || '未知'} · Stars: ${meta.stargazers_count ?? '?'} · 更新: ${meta.pushed_at || '?'}`);
    if (meta.topics?.length) parts.push(`Topics: ${meta.topics.join(', ')}`);
  }
  if (readme) parts.push(`README:\n${readme}`);
  return {
    type: 'link', ref: url, text: parts.join('\n').slice(0, 3500),
    meta: { title: meta?.full_name || `${repo.owner}/${repo.repo}`, source: 'github' },
  };
}

async function normalizeWeb(url) {
  const { text } = await fetchWithLimit(url);
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || url;
  const body = htmlToText(text).slice(0, 3000);
  if (!body) throw new Error('页面内容为空或无法解析');
  return { type: 'link', ref: url, text: body, meta: { title, source: 'web' } };
}

export async function normalizeInput(input, { tmpDir }) {
  const value = (input?.value || '').trim();
  if (!value) throw new Error('输入为空');
  const type = input.type;

  if (type === 'image') {
    // value: dataURL（data:image/png;base64,....）
    const m = value.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
    if (!m) throw new Error('截图格式不支持（支持 png/jpeg/webp/gif）');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw new Error('截图过大（>8MB）');
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `shot-${hash}.${ext}`);
    fs.writeFileSync(file, buf);
    return { type: 'image', ref: `image:${hash}`, text: '', meta: { path: file } };
  }

  if (type === 'link' || (type === 'text' && isLink(value))) {
    const url = value.split(/\s+/)[0];
    const gh = ghRepoFromUrl(url);
    if (gh) return normalizeGithub(url, gh);
    return normalizeWeb(url);
  }

  // 纯文本
  return { type: 'text', ref: value.slice(0, 200), text: value.slice(0, 2000), meta: {} };
}
