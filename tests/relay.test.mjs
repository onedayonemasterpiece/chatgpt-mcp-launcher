import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeRelay} from '../relay/server.mjs';
import {validChatUrl} from '../relay/queue.mjs';

const token='test_mcp_00000000000000000000000001';
const deviceToken='test_device_00000000000000000001';
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
const devHeaders={Authorization:'Bearer '+deviceToken,'X-Launcher-Device-Id':'win',Accept:'application/json'};
const chatUrl='https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function rpc(method,params,id=1) {return JSON.stringify({jsonrpc:'2.0',id,method,params});}

test('MCP -> local Chrome queue protocol, idempotency, security, persistence',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chatgpt-launcher-test-'));
 const file=join(dir,'queue.json');
 const {server,queue}=await makeRelay({file,mcpToken:token,devices:{win:deviceToken}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 async function req(path,method='GET',body,extra={}) {
  const res=await fetch(base+path,{method,headers:extra,body});
  const raw=await res.text();
  return {status:res.status,data:raw?JSON.parse(raw):null};
 }
 let out=await req('/mcp','POST',rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'0.1'}}),headers);
 assert.equal(out.status,200);
 assert.equal(out.data.result.serverInfo.name,'chatgpt-local-chrome-launcher');
 out=await req('/mcp','POST',rpc('tools/list',{}),headers);
 assert.deepEqual(out.data.result.tools.map(t=>t.name),['chatgpt_start','chatgpt_continue','chatgpt_read_reply','chatgpt_reconcile','chatgpt_task_status','chatgpt_list_chats','chatgpt_retry','chatgpt_close_chat','chatgpt_open','chatgpt_coordination_set','chatgpt_coordination_close','chatgpt_report','chatgpt_device_status']);
 out=await req('/mcp','POST',rpc('tools/call',{name:'chatgpt_start',arguments:{prompt:'Check the project',effort:'xhigh',device_id:'win',request_id:'test-1'}}),headers);
 const job=JSON.parse(out.data.result.content[0].text);
 assert.equal(job.status,'queued');
 assert.equal(job.effort,'xhigh');
 assert.equal(job.prompt,undefined); // never echo prompt in MCP result
 const duplicate=await req('/mcp','POST',rpc('tools/call',{name:'chatgpt_start',arguments:{prompt:'Check the project',effort:'xhigh',device_id:'win',request_id:'test-1'}}),headers);
 assert.equal(JSON.parse(duplicate.data.result.content[0].text).id,job.id);
 assert.equal((await req('/device/poll','GET',null,{})).status,401);
 out=await req('/mcp','POST',rpc('tools/call',{name:'chatgpt_device_status',arguments:{device_id:'win'}}),headers);
 assert.equal(JSON.parse(out.data.result.content[0].text).online,false);
 const legacy=await req('/device/poll','GET',null,{...devHeaders,'X-Launcher-Revision':'a'.repeat(40)});
 assert.equal(legacy.data.job,null,'unverified legacy extension must never consume queued jobs');
 const ready=await req('/device/report','POST',JSON.stringify({
   type:'heartbeat',schema_version:1,commands_enabled:true,
   active_revision:'a'.repeat(40),installed_revision:'a'.repeat(40),
   manifest_version:'0.2.0',runtime_integrity:'ok',
   runtime_loaded_at:new Date().toISOString(),updater:{state:'current'},
 }),{...devHeaders,'X-Launcher-Revision':'a'.repeat(40),'Content-Type':'application/json'});
 assert.equal(ready.status,200);
 const staleWorker=await req('/device/poll','GET',null,{...devHeaders,'X-Launcher-Revision':'f'.repeat(40)});
 assert.equal(staleWorker.data.job,null,'legacy stale worker cannot claim tasks after a new worker heartbeat');
 out=await req('/device/poll','GET',null,{...devHeaders,'X-Launcher-Revision':'a'.repeat(40)});
 assert.equal(out.data.job.id,job.id);
 assert.ok(out.data.job.prompt.startsWith('Check the project (Служебное:'),'original prompt first');
 assert.ok(out.data.job.prompt.includes('chatgpt_report')&&out.data.job.prompt.includes(out.data.job.id),'asks ChatGPT to confirm via MCP with this job_id');
 out=await req('/mcp','POST',rpc('tools/call',{name:'chatgpt_device_status',arguments:{device_id:'win'}}),headers);
 const observed=JSON.parse(out.data.result.content[0].text);
 assert.equal(observed.online,true);
 assert.equal(observed.revision,'a'.repeat(40));
 assert.equal(observed.last_job.status,'claimed');
 assert.equal(observed.last_job.prompt,undefined);
 assert.equal((await req('/device/poll','GET',null,devHeaders)).data.job,null); // claimed once
 const report={job_id:job.id,status:'sent',chat_url:chatUrl,message:'sent'};
 assert.equal((await req('/device/report','POST',JSON.stringify(report),{...devHeaders,'Content-Type':'application/json'})).status,200);
 assert.equal((await req('/device/report','POST',JSON.stringify(report),{...devHeaders,'Content-Type':'application/json'})).status,200); // ack retry
 out=await req('/mcp','POST',rpc('tools/call',{name:'chatgpt_task_status',arguments:{job_id:job.id}}),headers);
 assert.equal(JSON.parse(out.data.result.content[0].text).result_chat_url,chatUrl);
 assert.equal((await req('/mcp','POST',rpc('tools/list',{}),{'Content-Type':'application/json'})).status,401);
 assert.equal((await req('/mcp','POST',rpc('tools/list',{}),{...headers,Origin:'https://evil.example'})).status,403);
 await queue.modelReport({job_id:job.id,status:'done',summary:'initial task finished'});
 const continueJob=await req('/mcp','POST',rpc('tools/call',{name:'chatgpt_continue',arguments:{prompt:'Follow-up',chat_url:chatUrl,device_id:'win',effort:'medium'}}),headers);
 const next=JSON.parse(continueJob.data.result.content[0].text);
 assert.equal(next.action,'continue');
 const {server:other,queue:reloaded}=await makeRelay({file,mcpToken:token,devices:{win:deviceToken}});
 assert.equal(reloaded.status(job.id).status,'sent');
 assert.equal(reloaded.status(next.id).status,'queued');
 other.close();
 const invalid=await req('/mcp','POST',rpc('tools/call',{name:'chatgpt_continue',arguments:{prompt:'bad',chat_url:'https://evil.example/c/123',device_id:'win'}}),headers);
 assert.equal(invalid.data.result.isError,true);
 assert.equal(queue.status(next.id).status,'queued');
});

test('URL validation rejects untrusted destinations',()=>{
 assert.equal(validChatUrl(chatUrl),true);
 assert.equal(validChatUrl('https://chatgpt.com/g/g-p-abcdef/c/abc123'),true);
 for(const url of ['http://chatgpt.com/c/abc','https://chatgpt.com.evil.test/c/abc',
  'https://chatgpt.com/','https://chatgpt.com/c/abc?prompt=hello',
  'https://user@chatgpt.com/c/abc','javascript:alert(1)']) {
  assert.equal(validChatUrl(url),false,url);
 }
});
