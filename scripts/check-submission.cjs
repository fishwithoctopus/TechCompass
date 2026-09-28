const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const out=path.resolve(process.argv[2] || 'dist/submission');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('file:///'+out.replaceAll('\\','/')+'/index.html');
  for(const q of ['tech','model','unknown']){
   await page.locator(`[data-q="${q}"]`).click();
   assert.equal(await page.locator(`[data-q="${q}"]`).getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('.project').count(),q==='tech'?2:q==='model'?1:0);
   if(q==='model')assert.match(await page.locator('.result').textContent(),/对比基准/);
  }
  await page.locator('[data-view="projects"]').click();
  await page.locator('.project summary').first().click();
  assert.equal(await page.locator('.project').first().getAttribute('open'),'');
  await page.locator('[data-view="settings"]').click();
  await page.locator('#theme').click();assert.match(await page.locator('#app').getAttribute('class'),/dark/);
  await page.locator('#theme').click();
  await page.locator('[data-view="history"]').click();await page.locator('#history-open').click();
  await page.locator('#minimize').click();assert.equal(await page.locator('#compact').isVisible(),true);
  await page.locator('#compact').click();assert.equal(await page.locator('#app').isVisible(),true);
  for(const width of [1000,1440]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  assert.equal(await page.evaluate(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0)),true);
  assert.equal(await page.locator('script[src],link[rel="stylesheet"]').count(),0);
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
  await page.screenshot({path:path.join(out,'landing-check.png'),fullPage:true});
  console.log('PASS three scenarios, navigation, project details, themes, compact restore, 1000/1440 layout, embedded assets.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
