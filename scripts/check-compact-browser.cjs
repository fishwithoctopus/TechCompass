const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const { startDaemon } = await import('../lib/server.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-compact-'));
  const daemon = await startDaemon({ dataDir });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 580 } });
    await page.addInitScript(() => { window.electronAPI = { pickFolder: async () => null, setCollapsed: value => { window.lastCollapsed = value; } }; });
    await page.goto(`http://127.0.0.1:${daemon.port}/ui/?token=${daemon.token}`);
    await page.waitForFunction(() => !!document.getElementById('btn-collapse').onclick);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      await page.locator('#btn-collapse').click();
      await page.setViewportSize({ width: 96, height: 48 });
      assert.equal(await page.locator('#app').isVisible(), true);
      assert.equal(await page.locator('#mobile-notice').isVisible(), false);
      assert.equal(await page.locator('.logo').isVisible(), true);
      const box = await page.locator('#btn-collapse').boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 96 && box.y + box.height <= 48);
      await page.screenshot({ path: path.join(dataDir, `compact-${theme}.png`) });
      await page.locator('#btn-collapse').click();
      assert.equal(await page.evaluate(() => window.lastCollapsed), false);
      await page.setViewportSize({ width: 400, height: 580 });
      assert.equal(await page.locator('#input').isVisible(), true);
    }
    await page.setViewportSize({ width: 360, height: 640 });
    assert.equal(await page.locator('#mobile-notice').isVisible(), true);
    console.log('PASS light/dark: 96x48 logo + clickable restore, expanded input, mobile guard preserved. Screenshots: '+dataDir);
  } finally { await browser.close(); await daemon.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
