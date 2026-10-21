import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
try {
  const page = await browser.newPage();
  const fixture = await readFile(resolve(root, 'tests/driver_fixture.html'), 'utf8');
  await page.setContent(fixture);
  let driver = await readFile(resolve(root, 'extension/page-driver.js'), 'utf8');
  // Test-only: the live extension must still enforce the real chatgpt.com origin.
  driver = driver.replace(/function isConversationUrl\(value\) \{[\s\S]*?\n  \}/, 'function isConversationUrl(value) { return true; }');
  assert.ok(driver.includes('function isConversationUrl(value) { return true; }'), 'test-only origin stub');
  await page.addScriptTag({content:driver});
  const first=await page.evaluate(()=>window.chatGPTLauncherRun({action:'start',prompt:'First launch',effort:'medium'}));
  assert.equal(first.status, 'sent',JSON.stringify(first));
  assert.equal(await page.evaluate(()=>window.sentCount), 1);
  assert.match(await page.locator('#model').innerText(), /Средний/);
  assert.equal((await page.locator('#thread').innerText()).trim(),'First launch');
  assert.equal((await page.locator('#other-input').innerText()).trim(),"user's unrelated draft",'never type into similarly labelled secondary editor');

  await page.locator('#composer').fill('existing user draft');
  const second=await page.evaluate(()=>window.chatGPTLauncherRun({action:'continue',prompt:'Follow-up',effort:'high'}));
  assert.equal(second.status, 'blocked',JSON.stringify(second));
  assert.equal(await page.evaluate(()=>window.sentCount), 1);
  await page.locator('#composer').fill('');
  const third=await page.evaluate(()=>window.chatGPTLauncherRun({action:'continue',prompt:'Follow-up',effort:'high'}));
  assert.equal(third.status, 'sent',JSON.stringify(third));
  assert.equal(await page.evaluate(()=>window.sentCount), 2);
  assert.match(await page.locator('#model').innerText(), /Высокий/);
  assert.equal((await page.locator('#other-input').innerText()).trim(),"user's unrelated draft");
  console.log('PASS: start, continue, medium/high effort, uniquely selected primary composer, no draft overwrite');
} finally { await browser.close(); }
