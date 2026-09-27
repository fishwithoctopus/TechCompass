import test from 'node:test';
import assert from 'node:assert/strict';
import {macAgentCandidates,agentEnvironment,cardShortcut} from '../lib/platform.js';
test('Mac CLI candidates cover native and Homebrew paths without scanning projects',()=>{
  assert.deepEqual(macAgentCandidates('codex','/Users/test'),['/Users/test/.local/bin/codex','/Users/test/.npm-global/bin/codex','/opt/homebrew/bin/codex','/usr/local/bin/codex']);
  assert.deepEqual(macAgentCandidates('../bad','/Users/test'),[]);
});
test('Mac child environment keeps custom PATH and adds interpreter locations',()=>{
  const env={PATH:'/custom/bin:/usr/bin',KEY:'kept'};
  const result=agentEnvironment(env,'darwin','/Users/test');
  assert.ok(result.PATH.startsWith('/custom/bin:/usr/bin:'));
  assert.ok(result.PATH.includes('/opt/homebrew/bin'));
  assert.equal(result.PATH.split(':').filter(x=>x==='/usr/bin').length,1);
  assert.equal(result.KEY,'kept');assert.equal(env.PATH,'/custom/bin:/usr/bin');
});
test('Windows environment is not converted to POSIX PATH',()=>{
  assert.equal(agentEnvironment({PATH:'C:\\node;D:\\bin'},'win32','C:\\User').PATH,'C:\\node;D:\\bin');
  assert.equal(cardShortcut('darwin'),'Command+Shift+T');assert.equal(cardShortcut('win32'),'Ctrl+Shift+T');
});
