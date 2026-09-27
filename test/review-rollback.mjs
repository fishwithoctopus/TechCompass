import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {registerFor} from '../lib/installer.js';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'tc-review-'));
fs.mkdirSync(path.join(home,'.codex'));
const cfg=path.join(home,'.codex','config.toml');
const original='model = "test-model"\n';
fs.writeFileSync(cfg,original);
let copies=0;
const result=await registerFor(['codex'],{home,entry:{command:'D:\\Test\\TechCompass.exe',args:[]},probe:false,deps:{
  copyFileSync:(from,to)=>{if(++copies>1)throw Object.assign(new Error('simulated restore denied'),{code:'EACCES'});fs.copyFileSync(from,to);},
  renameSync:(from,to)=>{fs.renameSync(from,to);fs.writeFileSync(to,'# simulated concurrent edit\n');}
}});
console.log(JSON.stringify({isolatedDirectory:home,result:result.results[0],originalRestored:fs.readFileSync(cfg,'utf8')===original},null,2));
