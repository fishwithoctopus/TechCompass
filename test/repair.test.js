import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Pipeline } from '../lib/pipeline.js';
import { runProvider, createVault, validateProvider } from '../lib/provider.js';
import { registerFor } from '../lib/installer.js';
import { startDaemon } from '../lib/server.js';
import http from 'node:http';
import { providerRunner } from '../lib/provider.js';

function temp(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-repair-'));
 t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
 return dir;
}
test('显式 Codex 不可用时不能命中 mock 缓存或偷偷降级', async t => {
 const store = new Store(temp(t));
 const pipeline = new Pipeline({store,detector:()=>[]});
 await pipeline.analyze({type:'text',value:'Bun'}, {agentId:'mock'});
 await assert.rejects(pipeline.analyze({type:'text',value:'Bun'}, {agentId:'codex'}), /未检测到/);
 await assert.rejects(pipeline.analyze({type:'text',value:'Bun'}), /没有可用/);
 assert.equal(store.listAnalyses().length,1);
});
test('真实模型失败不生成伪结果', async t => {
 const store = new Store(temp(t));
 const pipeline = new Pipeline({store,detector:()=>['codex'],researcher:async()=>({status:'searched',summary:'test',sources:[]}),runner:async()=>{throw new Error('offline');}});
 await assert.rejects(pipeline.analyze({type:'text',value:'Bun'},{agentId:'codex'}),/offline/);
 assert.equal(store.listAnalyses().length,0);
});
test('API 适配器真实请求契约及错误脱敏', async () => {
 const provider={baseUrl:'https://example.com/v1',model:'test'};
 let request;
 const r = await runProvider({provider,key:'secret-test',prompt:'hello',fetchImpl:async(url,opts)=>{request={url,...opts};return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})};}});
 assert.equal(r.text,'OK'); assert.equal(request.url,'https://example.com/v1/chat/completions');
 assert.equal(JSON.parse(request.body).messages[0].content,'hello');
 await assert.rejects(runProvider({provider,key:'secret-test',prompt:'x',fetchImpl:async()=>({ok:false,status:401})}),e=> !e.message.includes('secret-test') && /401/.test(e.message));
 assert.throws(()=>validateProvider({baseUrl:'http://example.com',model:'test'}),/HTTPS/);
 assert.throws(()=>validateProvider({baseUrl:'https://user:pass@example.com',model:'test'}),/密码/);
});
test('没有 OS 加密能力时密钥只存在内存', t => {
 const dir=temp(t); const vault=createVault(dir);
 vault.set('secret-test'); assert.equal(vault.get(),'secret-test'); assert.equal(vault.persistent,false);
 assert.equal(createVault(dir).has(),false); assert.equal(fs.readdirSync(dir).length,0);
 vault.clear(); assert.equal(vault.has(),false);
});
test('API HTTP 全链路：模型返回 → JSON 校验 → 落库；切模型后缓存失效', async t => {
 const store=new Store(temp(t));const vault=createVault(store.dir);vault.set('test-only');
 let calls=0;
 const server=http.createServer((req,res)=>{
  assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer test-only');
  let body='';req.on('data',d=>body+=d);req.on('end',()=>{
   assert.ok(JSON.parse(body).messages[0].content.includes('TechCompass'));calls++;
   res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({terms:[{term:'Bun',what:'测试服务固定响应',solves:'仅测试 HTTP 链路'}],projects:[],missing:['请关联项目']})}}]}));
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const provider={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'test-a'};
 await store.updateSettings({apiProvider:provider});
 const pipeline=new Pipeline({store,runner:providerRunner(store,vault),detector:()=>[],researcher:async()=>({status:'searched',summary:'test',sources:[]})});
 const first=await pipeline.analyze({type:'text',value:'Bun'},{agentId:'api'});
 assert.equal(first.agentUsed,'api');assert.equal(first.fellBack,false);
 assert.equal((await pipeline.analyze({type:'text',value:'Bun'},{agentId:'api'})).cached,true);
 await store.updateSettings({apiProvider:{...provider,model:'test-b'}});
 assert.equal((await pipeline.analyze({type:'text',value:'Bun'},{agentId:'api'})).cached,false);assert.equal(calls,2);
});
test('写后被并发修改：不覆盖现场，也不谎称已还原', async t => {
 const home=temp(t); fs.mkdirSync(path.join(home,'.codex'));
 const file=path.join(home,'.codex','config.toml'); fs.writeFileSync(file,'model = "test"\n');
 const r=await registerFor(['codex'],{home,entry:{command:'D:\\Test\\a.exe',args:[]},probe:false,deps:{renameSync:(from,to)=>{fs.renameSync(from,to);fs.writeFileSync(to,'# concurrent change\n');}}});
 const result=r.results[0]; assert.equal(result.code,'POSTCHECK_FAILED'); assert.equal(result.untouched,false); assert.equal(result.originalRestored,false);
 assert.equal(fs.readFileSync(file,'utf8'),'# concurrent change\n'); assert.equal(fs.readFileSync(result.backup,'utf8'),'model = "test"\n');
});
test('HTTP：API 密钥不返回；更换端点必须重新提供密钥；确认反馈进入上下文', async t => {
 const dir=temp(t); const daemon=await startDaemon({dataDir:dir,port:0});
 t.after(()=>daemon.stop());
 const request=async(p,method='GET',body)=>{
  const r=await fetch(`http://127.0.0.1:${daemon.port}${p}`,{method,headers:{'x-tc-token':daemon.token,'content-type':'application/json'},body:body ? JSON.stringify(body):undefined});
  return {status:r.status,body:await r.json()};
 };
 assert.equal((await request('/api/provider','PUT',{baseUrl:'https://example.com/v1',model:'test',apiKey:'secret-test'})).status,200);
 assert.ok(!JSON.stringify((await request('/api/state')).body).includes('secret-test'));
 assert.ok(!fs.readFileSync(path.join(dir,'data.json'),'utf8').includes('secret-test'));
 assert.equal((await request('/api/provider','PUT',{baseUrl:'https://other.example/v1',model:'test'})).status,400);
 await daemon.app.store.upsertProject({id:'p1',path:'/fixture'});
 await daemon.app.store.saveContext({projectId:'p1',name:'test',goal:'test',stage:'mvp',stack:[],keyDeps:[],constraints:[]});
 const result=await daemon.app.pipeline.analyze({type:'text',value:'Bun'},{agentId:'mock'});
 const feedback={analysisId:result.analysisId,projectId:'p1',accuracy:'partial',intent:'later',note:'本周不迁移框架'};
 await request('/api/feedback','POST',feedback);
 assert.deepEqual(daemon.app.store.getContexts()[0].constraints,[]);
 await request('/api/feedback','POST',{...feedback,remember:true});
 assert.deepEqual(daemon.app.store.getContexts()[0].constraints,['用户确认：本周不迁移框架']);
 assert.equal((await request('/api/feedback','POST',{...feedback,projectId:'missing'})).status,400);
 const changed=await daemon.app.pipeline.analyze({type:'text',value:'Bun'},{agentId:'mock'});
 assert.equal(changed.cached,false);
 await request('/api/provider','DELETE');
 assert.equal((await request('/api/state')).body.apiKeyConfigured,false);
});
