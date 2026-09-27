import fs from 'node:fs';
import path from 'node:path';
import { runAgentPrompt } from './agentbridge.js';

export function validateProvider(input) {
  const url = new URL(String(input.baseUrl || '').trim());
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含密码、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('请使用 HTTPS API 地址；本机服务可使用 HTTP');
  const model = String(input.model || '').trim();
  if (!model || model.length > 160) throw new Error('请填写模型名称');
  return { baseUrl: url.href.replace(/\/$/, ''), model };
}

// API keys never enter settings, analysis snapshots, logs, or renderer responses.
export function createVault(dir, encryption) {
  const file = path.join(dir, 'api-key.encrypted');
  let sessionKey = '';
  return {
    persistent: !!encryption,
    get() {
      if (sessionKey) return sessionKey;
      if (!encryption || !fs.existsSync(file)) return '';
      try { return encryption.decryptString(fs.readFileSync(file)); }
      catch { throw new Error('无法解密 API Key，请在设置中重新保存'); }
    },
    set(key) {
      if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) throw new Error('API Key 格式不正确');
      if (encryption) {
        const temp = `${file}.tmp`;
        fs.writeFileSync(temp, encryption.encryptString(key.trim()), { mode: 0o600 });
        fs.renameSync(temp, file);
      }
      sessionKey = key.trim();
    },
    clear() { sessionKey = ''; if (fs.existsSync(file)) fs.unlinkSync(file); },
    has() { try { return !!this.get(); } catch { return false; } },
  };
}

export async function runProvider({ provider, key, prompt, imagePath, fetchImpl = fetch, timeoutMs = 90_000, signal }) {
  if (!provider || !key) throw new Error('请先在设置中保存 API 地址、模型名称与 API Key');
  const { baseUrl, model } = validateProvider(provider);
  let content = prompt;
  if (imagePath) {
    const ext = path.extname(imagePath).slice(1).replace('jpg', 'jpeg');
    content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/${ext};base64,${fs.readFileSync(imagePath).toString('base64')}` } }];
  }
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 4000 }),
    });
  } catch { signal?.throwIfAborted(); throw new Error('API 连接失败或超时，请检查网络和 API 地址'); }
  if (!response.ok) throw new Error(`API 返回 ${response.status}：${response.status === 401 ? '请检查 API Key' : response.status === 429 ? '额度或请求频率受限' : '请检查模型名称、权限和服务状态'}。未切换到演示引擎。`);
  let data;
  try { data = await response.json(); } catch { throw new Error('API 返回的不是有效 JSON'); }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('API 未返回有效分析文本');
  return { text, agentId: 'api' };
}

export function providerRunner(store, vault) {
  return async (chain, options) => {
    const errors = [];
    for (let i = 0; i < chain.length; i++) {
      try {
        const result = chain[i] === 'api'
          ? await runProvider({ provider: store.getSettings().apiProvider, key: vault.get(), prompt: options.prompt, signal: options.signal, imagePath: options.meta?.normalized?.meta?.path })
          : await runAgentPrompt({ ...options, agentId: chain[i] });
        return { ...result, fellBack: i > 0 };
      } catch (e) { options.signal?.throwIfAborted(); errors.push(`${chain[i]}：${e.message}`); }
    }
    throw new Error(errors.join('\n'));
  };
}
