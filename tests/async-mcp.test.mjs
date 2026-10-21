import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeRelay} from '../relay/server.mjs';

const TOKEN='m'.repeat(40),DEVICE='d'.repeat(40),REV='a'.repeat(40);
const ID='6ad89e0c-b984-83ea-88ba-dd29b57ee40b';
const URL='https://chatgpt.com/c/'+ID;
test('MCP opens known slug asynchronously, records progress/route and resumes without duplicating prompt',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launcher-mcp-async-'));
  const file=join(dir,'queue.json');
  const {server,queue}=await makeRelay({file,mcpToken:TOKEN,devices:{desktop:DEVICE}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{await new Promise(done=>server.close(done));await rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const devHeaders={Authorization:'Bearer '+DEVICE,'X-Launcher-Device-Id':'desktop','X-Launcher-Revision':REV,'Content-Type':'application/json'};
  async function json(path,body=null,auth='device'){
    const headers=auth==='device'?devHeaders:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'};
    const r=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
    return {code:r.status,body:await r.json()};
  }
  let rpcId=0;
  async function call(name,args){
    const res=await json('/mcp',{jsonrpc:'2.0',id:++rpcId,method:'tools/call',
      params:{name,arguments:args}},'mcp');
    assert.equal(res.code,200);
    if(res.body.result.isError)throw Error('MCP error: '+res.body.result.content[0].text);
    return JSON.parse(res.body.result.content[0].text);
  }
  const opened=await call('chatgpt_open',{chat_ref:ID,request_id:'open-id'});
  assert.equal(opened.status,'queued');
  assert.equal(opened.chat_url,URL);
  assert.equal(opened.prompt,undefined);
  const same=await call('chatgpt_open',{chat_ref:ID,request_id:'open-id'});
  assert.equal(opened.id,same.id,'idempotency prevents duplicate tabs');
  const ready=await json('/device/report',{type:'heartbeat',schema_version:1,
    commands_enabled:true,active_revision:REV,installed_revision:REV,
    runtime_integrity:'ok',manifest_version:'0.2.2',
    runtime_loaded_at:new Date().toISOString(),updater:{state:'current'}});
  assert.equal(ready.code,200);
  let next=await json('/device/poll');
  assert.equal(next.body.job.id,opened.id);
  assert.equal(next.body.job.action,'open');
  assert.equal(next.body.job.prompt,null,'open-only browser job has no prompt');
  let progress=await json('/device/report',{type:'progress',job_id:opened.id,phase:'loading'});
  assert.equal(progress.code,200);
  let status=await call('chatgpt_task_status',{job_id:opened.id});
  assert.equal(status.status,'claimed');
  assert.equal(status.phase,'loading');
  progress=await json('/device/report',{type:'chat_seen',job_id:opened.id,chat_url:URL});
  assert.equal(progress.code,200);
  const registry=await call('chatgpt_list_chats',{device_id:'desktop'});
  assert.equal(registry.total,1);
  assert.equal(registry.chats[0].chat_id,ID);
  const observation=await call('chatgpt_chat_status',{chat_ref:ID});
  assert.equal(observation.chat_url,URL);
  assert.equal(observation.note.includes('not verified'),true);
  const done=await json('/device/report',{job_id:opened.id,status:'opened',chat_url:URL});
  assert.equal(done.code,200);
  status=await call('chatgpt_task_status',{job_id:opened.id});
  assert.equal(status.status,'opened');
  const continuation=await call('chatgpt_continue',{chat_ref:ID,prompt:'Continue work',request_id:'continue-id'});
  assert.equal(continuation.action,'continue');
  assert.equal(continuation.chat_url,URL);
  assert.equal(continuation.effort,'xhigh');
  const noSecret=JSON.stringify(registry);
  assert.equal(noSecret.includes('Continue work'),false);
  assert.equal(noSecret.includes(DEVICE),false);
  assert.equal((await json('/device/report',{type:'progress',job_id:opened.id,phase:'submitting'},'none')).code,401);
});
