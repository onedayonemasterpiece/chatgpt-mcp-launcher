import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const s=await readFile(new URL('../install.ps1',import.meta.url),'utf8');
test('public installer does not require Git or private repo access',()=>{
  assert.ok(s.includes('https://api.github.com/repos/'));
  assert.ok(s.includes('https://codeload.github.com/'));
  assert.ok(s.includes('Expand-Archive'));
  assert.ok(!s.includes('git clone') && !s.includes('git fetch'));
});
test('scheduled update every fifteen minutes downloads only on SHA mismatch',()=>{
  assert.ok(s.includes('/SC MINUTE /MO 15'));
  assert.ok(s.includes('if(Is-Installed $targetRevision)'));
  assert.ok(s.includes('background_sha256 = $backgroundHash'));
  assert.ok(s.includes('driver_sha256 = $driverHash'));
  assert.ok(s.includes('Atomic-Text $marker'));
});

test('one-click update registers a per-user Windows protocol without accepting URL args',()=>{
  assert.ok(s.includes('HKEY_CURRENT_USER'));
  assert.ok(s.includes('chatgpt-mcp-update'));
  assert.ok(s.includes('URL Protocol'));
  assert.ok(s.includes('Set-Item -Path $cmdKey'));
  assert.ok(s.includes('if($Install) { Install-Schedule; Install-UpdateProtocol }'));
});
