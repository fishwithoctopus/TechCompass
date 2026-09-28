import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('mobile width guard excludes the compact desktop card', () => {
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(css, /body:not\(\.collapsed\) #app \{ display: none; \}/);
  assert.match(css, /body:not\(\.collapsed\) #mobile-notice/);
  assert.doesNotMatch(html, /id="mobile-notice" class="hidden"/);
});
