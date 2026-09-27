import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeResearch } from '../lib/search.js';
import { Store } from '../lib/store.js';
import { Pipeline } from '../lib/pipeline.js';
const evidence={status:'searched',summary:'检索测试资料',sources:[{title:'官方',url:'https://example.com'}],searchedAt:'2026-09-27',searchCount:1};
const result={terms:[{term:'Jev',what:'测试定义',solves:'测试用途'}],projects:[],missing:[]};
function setup(t, researcher) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tc-search-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir);let prompt='';
 const pipeline=new Pipeline({store,detector:()=>['codex'],researcher,runner:async(_chain,options)=>{prompt=options.prompt;return {text:JSON.stringify(result),agentId:'codex',fellBack:false};}});
 return {store,pipeline,prompt:()=>prompt};
}
test('不能把没有搜索事件的回答当作联网证据',()=>assert.throws(()=>sanitizeResearch({summary:'x',sources:[]},0),/真实联网搜索/));
test('搜索来源拒绝脚本地址和带密码链接',()=>{
 const r=sanitizeResearch({summary:'x',sources:[{url:'javascript:alert(1)'},{url:'https://a:b@example.com'},{url:'https://example.com/docs'}]},1);
 assert.equal(r.sources.length,1);assert.equal(r.sources[0].url,'https://example.com/docs');
});
test('已搜索无结果不同于工具报错',()=>assert.equal(sanitizeResearch({summary:'没有可靠结果',sources:[]},1).status,'no_results'));
test('资料先检索后进入分析 prompt，来源落库，缓存可刷新',async t=>{
 let calls=0;const {store,pipeline,prompt}=setup(t,async normalized=>{calls++;assert.equal(normalized.text,'jev');assert.equal(normalized.contexts,undefined);return evidence;});
 const a=await pipeline.analyze({type:'text',value:'jev'},{agentId:'codex'});
 assert.ok(prompt().includes('检索测试资料'));assert.deepEqual(store.getAnalysis(a.analysisId).research.sources,evidence.sources);
 assert.equal((await pipeline.analyze({type:'text',value:'jev'},{agentId:'codex'})).cached,true);assert.equal(calls,1);
 await pipeline.analyze({type:'text',value:'jev'},{agentId:'codex',noCache:true});assert.equal(calls,2);
});
test('搜索失败保留明确失败，不继续猜测或落库',async t=>{
 const {store,pipeline}=setup(t,async()=>{throw new Error('offline');});
 await assert.rejects(pipeline.analyze({type:'text',value:'jev'},{agentId:'codex'}),/联网搜索未完成.*offline/);
 assert.equal(store.listAnalyses().length,0);
});
test('Codex 合并路径：只调用一次，保留真实搜索证据与来源',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tc-combined-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir);let calls=0;
 const pipeline=new Pipeline({store,detector:()=>['codex'],combinedSearch:true,runner:async(chain,options)=>{
  calls++;assert.deepEqual(chain,['codex']);assert.equal(options.meta.purpose,'analysis_search');
  assert.ok(options.prompt.includes('不得将下面项目'));
  return {text:JSON.stringify({...result,research:{summary:'查到资料',sources:[{title:'官方',url:'https://example.com'}]}}),agentId:'codex',searchCount:1};
 }});
 const r=await pipeline.analyze({type:'text',value:'jev'},{agentId:'codex'});
 assert.equal(store.getAnalysis(r.analysisId).mode,'combined-search');
 assert.equal((await pipeline.analyze({type:'text',value:'jev'},{agentId:'codex'})).cached,true);
 assert.equal(calls,1);
});
test('合并路径缺少真实搜索事件时不生成结果',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tc-combined-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir);
 const pipeline=new Pipeline({store,detector:()=>['codex'],combinedSearch:true,runner:async()=>({text:JSON.stringify({...result,research:{summary:'x',sources:[]}}),searchCount:0})});
 await assert.rejects(pipeline.analyze({type:'text',value:'jev'},{agentId:'codex'}),/真实联网搜索/);assert.equal(store.listAnalyses().length,0);
});
