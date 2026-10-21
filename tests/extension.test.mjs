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
  // Exercise the REAL browser's HTMLFormElement.requestSubmit() pathway,
  // not a mocked KeyboardEvent: native submit events must reach listeners.
  await page.setContent(`<!doctype html><html><body>
    <form id="composer-form">
      <div id="prompt-textarea" contenteditable="true" data-testid="composer-text-input"
           aria-label="Ask ChatGPT" style="display:block;width:320px;min-height:50px;border:1px solid"></div>
      <button type="button" id="other" aria-label="Voice">Mic</button>
    </form>
    <script>
      window.nativeSubmissions=0;
      document.getElementById('composer-form').addEventListener('submit',event=>{
        event.preventDefault();
        window.nativeSubmissions++;
        document.getElementById('prompt-textarea').textContent='';
      });
    </script></body></html>`);
  await page.addScriptTag({content:driver});
  const native=await page.evaluate(()=>window.chatGPTLauncherRun({action:'start',prompt:'native-form-ping',effort:'auto'}));
  assert.equal(native.status,'sent',JSON.stringify(native));
  assert.match(native.message,/Native form submit/);
  assert.equal(await page.evaluate(()=>window.nativeSubmissions),1,'real browser delivered native submit exactly once');
  assert.equal((await page.locator('#prompt-textarea').innerText()).trim(),'');
  console.log('PASS: native browser form requestSubmit delivered once with unlabeled Send control');
} finally { await browser.close(); }
