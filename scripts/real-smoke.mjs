import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Pipeline } from '../lib/pipeline.js';
import { resolveAgent } from '../lib/agentbridge.js';
const dir = path.resolve('qa', 'real-smoke');
const store = new Store(dir);
await store.upsertProject({ id: 'pj_smoke', path: path.resolve('.'), createdAt: new Date().toISOString() });
await store.saveContext({ projectId: 'pj_smoke', name: 'TechCompass', goal: '帮助开发者判断新技术是否与当前项目相关', stage: 'mvp', stack: ['Electron', 'JavaScript', 'Node.js'], keyDeps: [{name:'electron', why:'桌面卡片'}], focus: '今天交付 Windows 桌面应用，先修模型调用链路', constraints: ['当天截止，暂不迁移桌面框架'], source:'manual' });
console.log('Detected:', resolveAgent('codex'));
const start = Date.now();
try {
 const result = await new Pipeline({store}).analyze({type:'text',value:'Tauri',onStage:console.log},{agentId:'codex',noCache:true});
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({durationMs:Date.now()-start,...result},null,2));
 console.log(JSON.stringify({agentUsed:result.agentUsed,fellBack:result.fellBack,projects:result.result.projects,durationMs:Date.now()-start},null,2));
} catch(e) { console.error(e.message); process.exitCode=1; }
