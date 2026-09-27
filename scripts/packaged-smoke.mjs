import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const dir=path.resolve('qa','packaged');
const token=fs.readFileSync(path.join(dir,'token'),'utf8').trim();
const request=async(p,method='GET',body)=>{
 const r=await fetch('http://127.0.0.1:47423'+p,{method,headers:{'x-tc-token':token,'content-type':'application/json'},body:body ? JSON.stringify(body):undefined});
 const data=await r.json(); if(!r.ok) throw new Error(data.error);return data;
};
const state=await request('/api/state');
if(state.version!=='0.3.0' || state.dataDir!==dir) throw new Error('Wrong application instance');
console.log('Packaged app:',JSON.stringify({version:state.version,detected:state.agents.detected,encrypted:state.apiKeyPersistent}));
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
await request('/api/provider','PUT',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'local-test-only',apiKey:'tc-test-not-a-real-secret'});
await request('/api/provider/test','POST',{});
const encrypted=fs.readFileSync(path.join(dir,'api-key.encrypted'));
if(encrypted.includes(Buffer.from('tc-test-not-a-real-secret'))) throw new Error('Key persisted as plaintext');
console.log('OS encrypted key + packaged API connection: PASS');
await request('/api/provider','DELETE');await new Promise(r=>server.close(r));
const scan=await request('/api/projects/scan','POST',{path:path.resolve('.')});
const saved=await request('/api/projects','POST',{path:path.resolve('.'),context:{...scan.draft,goal:'判断新技术与当前项目的关系',focus:'当天交付 Windows 版，先修模型链路',constraints:['今天不迁移桌面框架']}});
const job=await request('/api/analyze','POST',{input:{type:'text',value:'Tauri'},agentId:'codex',noCache:true});
console.log('Packaged real Codex analysis started');
const started=Date.now();
for(;;) {
 const status=await request('/api/jobs/'+job.jobId);
 if(status.status==='error') throw new Error(status.error);
 if(status.status==='done') {
  if(status.result.agentUsed!=='codex' || status.result.fellBack) throw new Error('Wrong engine');
  const record=await request('/api/analyses/'+status.result.analysisId);
  fs.writeFileSync(path.resolve('qa','packaged-result.json'),JSON.stringify({elapsedMs:Date.now()-started,version:state.version,result:record.analysis},null,2));
  console.log(JSON.stringify({elapsedMs:Date.now()-started,agentUsed:record.analysis.agentUsed,verdict:record.analysis.result.projects[0]?.verdict,project:saved.project.id}));break;
 }
 if(Date.now()-started>200000) throw new Error('Job timeout');
 await new Promise(r=>setTimeout(r,1000));
}
