import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileQueue} from '../relay/queue.mjs';
import {canonicalChatUrl,chatIdFromUrl,referenceToUrl} from '../relay/conversations.mjs';

const ID='6ad89e0c-b984-83ea-88ba-dd29b57ee40b';
const URL='https://chatgpt.com/c/'+ID;
const PROJECT='https://chatgpt.com/g/g-p-6ab91b49a1d48191a3a6b09d7b617819-projects-hub/c/'+ID;
const token='x'.repeat(40);
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'launcher-registry-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'queue.json');
  const q=new FileQueue(file,{desktop:token});
  await q.initialize();
  return {q,file};
}
test('canonical identity is precise; refuses hostile/malformed URLs and preserves project scope',()=>{
  assert.equal(canonicalChatUrl(URL+'/'),URL);
  assert.equal(canonicalChatUrl(PROJECT),PROJECT);
  assert.equal(chatIdFromUrl(PROJECT),ID);
  for(const url of [
    'http://chatgpt.com/c/'+ID,'https://chatgpt.com.evil.test/c/'+ID,
    'https://user:pw@chatgpt.com/c/'+ID,
    'https://chatgpt.com/c/'+ID+'?q=secret','https://chatgpt.com/c/'+ID+'#frag',
    'https://chatgpt.com/', 'https://chatgpt.com/local/'+ID,'https://chatgpt.com/c/../secrets'
  ])assert.equal(canonicalChatUrl(url),null,url);
  assert.equal(referenceToUrl(ID),URL);
  assert.equal(referenceToUrl('ftp://chatgpt.com/c/'+ID),null);
});
test('effort defaults to the level already selected in ChatGPT; idempotency; slug continuation',async t=>{
  const {q}=await setup(t);
  const first=await q.enqueue({action:'start',prompt:'ping',request_id:'accept-a'});
  assert.equal(first.effort,'auto','never forces a level unless the caller asks');
  assert.equal(first.status,'queued');
  assert.equal(first.prompt,undefined,'prompt must not leak to job status');
  assert.equal((await q.enqueue({action:'start',prompt:'ping',request_id:'accept-a'})).id,first.id);
  await assert.rejects(q.enqueue({action:'start',prompt:'different',request_id:'accept-a'}),/Idempotency/);
  assert.equal((await q.enqueue({action:'start',prompt:'x',effort:'xhigh'})).effort,'xhigh');
  const continued=await q.enqueue({action:'continue',chat_ref:ID,prompt:'continue'});
  assert.equal(continued.chat_url,URL);
  assert.equal(continued.chat_id,ID);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,chat_url:URL,prompt:'x'}),/Exactly one/);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:'https://example.com/c/'+ID,prompt:'x'}),/Unknown or invalid/);
});
test('slug is captured from sent report, survives restart and resolves by job ID',async t=>{
  const {q,file}=await setup(t);
  const task=await q.enqueue({action:'start',prompt:'ping'});
  assert.equal((await q.claim('desktop')).id,task.id);
  assert.equal(q.listChats().total,0,'do not invent a slug before the route exists');
  const reported=await q.report('desktop',{job_id:task.id,status:'sent',chat_url:URL,message:'New chat created via Enter.'});
  assert.equal(reported.result_chat_url,URL);
  assert.equal(q.status(task.id).chat_id,ID);
  assert.equal(q.listChats().chats[0].chat_id,ID);
  const next=new FileQueue(file,{desktop:token});
  await next.initialize();
  assert.equal(next.listChats().total,1);
  assert.equal(next.listChats().chats[0].source_job_id,task.id);
  assert.equal((await next.enqueue({action:'continue',chat_ref:task.id,prompt:'Continue'})).chat_url,URL);
  await assert.rejects(next.enqueue({action:'continue',chat_ref:(await next.enqueue({action:'start',prompt:'y'})).id,prompt:'z'}),
    /Unknown or invalid/,'a job that never reached a conversation is not guessed into a slug');
});
test('job ID still resolves through the registry after the job is pruned from the queue',async t=>{
  const {q,file}=await setup(t);
  const task=await q.enqueue({action:'start',prompt:'ping'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:task.id,status:'sent',chat_url:PROJECT});
  const state=JSON.parse(await readFile(file,'utf8'));
  state.jobs=[];
  await writeFile(file,JSON.stringify(state));
  const restarted=new FileQueue(file,{desktop:token});
  await restarted.initialize();
  assert.equal(restarted.status(task.id),null);
  assert.equal(restarted.resolveChat(task.id),PROJECT);
});
test('open-only job has no prompt or effort and can never report sent',async t=>{
  const {q}=await setup(t);
  const task=await q.enqueue({action:'open',chat_ref:ID,request_id:'open-test'});
  assert.equal(task.prompt,undefined);
  assert.equal(task.effort,null);
  assert.equal(task.chat_url,URL);
  await q.claim('desktop');
  await assert.rejects(q.report('desktop',{job_id:task.id,status:'sent',chat_url:URL}),/never report sent/);
  const done=await q.report('desktop',{job_id:task.id,status:'opened',chat_url:URL});
  assert.equal(done.status,'opened');
  assert.equal(q.listChats().chats[0].chat_url,URL);
});
test('a final report with an odd URL is accepted without the URL instead of wedging the worker',async t=>{
  const {q}=await setup(t);
  const task=await q.enqueue({action:'continue',chat_ref:ID,prompt:'next'});
  await q.claim('desktop');
  const done=await q.report('desktop',{job_id:task.id,status:'needs_review',
    chat_url:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555'});
  assert.equal(done.status,'needs_review');
  assert.equal(done.result_chat_url,null,'a different conversation is not linked to this job');
  const other=await q.enqueue({action:'start',prompt:'x'});
  await q.claim('desktop');
  assert.equal((await q.report('desktop',{job_id:other.id,status:'sent',chat_url:'https://evil.test/c/'+ID})).result_chat_url,null);
  assert.equal(q.listChats().total,0);
});

test('a temporary local ChatGPT address is never stored as a slug',()=>{
  for(const url of ['https://chatgpt.com/c/local-abc123456','https://chatgpt.com/local/'+ID,'https://chatgpt.com/c/LOCAL-abc123456'])
    assert.equal(canonicalChatUrl(url),null,url);
  assert.equal(referenceToUrl('local-abc123456'),null);
});
test('read job has no prompt, returns the reply text and can never report sent',async t=>{
  const {q}=await setup(t);
  const task=await q.enqueue({action:'read',chat_ref:ID});
  assert.equal(task.prompt,undefined);
  assert.equal(task.effort,null);
  await q.claim('desktop');
  await assert.rejects(q.report('desktop',{job_id:task.id,status:'sent',chat_url:URL}),/never report sent/);
  const done=await q.report('desktop',{job_id:task.id,status:'read',chat_url:URL,
    reply_text:'PONG'+'x'.repeat(30_000),reply_generating:false,message:'Last ChatGPT reply read'});
  assert.equal(done.status,'read');
  assert.equal(done.reply_text.slice(0,4),'PONG');
  assert.equal(done.reply_text.length,20_000);
  assert.equal(done.reply_generating,false);
  const sent=await q.enqueue({action:'start',prompt:'x'});
  await q.claim('desktop');
  await assert.rejects(q.report('desktop',{job_id:sent.id,status:'read'}),/Only read jobs/);
});
async function aged(t,mutate) {
  const {q,file}=await setup(t);
  const jobs={
    queued:await q.enqueue({action:'start',prompt:'old prompt'}),
  };
  const state=JSON.parse(await readFile(file,'utf8'));
  mutate(state);
  await writeFile(file,JSON.stringify(state));
  const r=new FileQueue(file,{desktop:token});
  await r.initialize();
  return {q:r,file,jobs};
}
const OLD=new Date(Date.now()-16*60_000).toISOString();
test('a job nobody picked up within 15 minutes expires and is never handed out later',async t=>{
  const {q,jobs}=await aged(t,s=>{s.jobs[0].created_at=OLD;});
  const st=q.status(jobs.queued.id);
  assert.equal(st.status,'expired');
  assert.match(st.next_step,/nothing was sent/);
  assert.equal(await q.claim('desktop'),null,'an hours-old prompt must not be sent when Chrome returns');
});
test('a claimed job without a report gets a final status and a late real report still wins',async t=>{
  const {q,jobs}=await aged(t,s=>{
    s.jobs[0].status='claimed';s.jobs[0].claimed_at=OLD;
    s.jobs.push({...s.jobs[0],id:'read-old',action:'read',prompt:null,status:'claimed',claimed_at:OLD});
  });
  const st=q.status(jobs.queued.id);
  assert.equal(st.status,'needs_review');
  assert.match(st.next_step,/last_user_text/);
  assert.equal(q.status('read-old').status,'failed','nothing is sent by a read, so repeating is safe');
  const late=await q.report('desktop',{job_id:jobs.queued.id,status:'sent',chat_url:URL});
  assert.equal(late.status,'sent');
  await assert.rejects(q.report('desktop',{job_id:jobs.queued.id,status:'blocked'}),/not claimed/);
});
test('a read reports the last user message so needs_review can be resolved',async t=>{
  const {q}=await setup(t);
  const task=await q.enqueue({action:'read',chat_ref:ID});
  await q.claim('desktop');
  const done=await q.report('desktop',{job_id:task.id,status:'read',chat_url:URL,
    reply_text:'PONG2',last_user_text:'PING 2',reply_generating:false});
  assert.equal(done.last_user_text,'PING 2');
  assert.match(done.next_step,/last ChatGPT reply/);
});
test('old needs_review jobs never fill the queue up',async t=>{
  const {file}=await setup(t);
  const state={device_status:{},chats:[]};
  state.jobs=Array.from({length:500},(_,i)=>({id:'j'+i,action:'start',device_id:'desktop',status:'needs_review',created_at:OLD}));
  await writeFile(file,JSON.stringify(state));
  const r=new FileQueue(file,{desktop:token});
  await r.initialize();
  assert.equal((await r.enqueue({action:'start',prompt:'fresh'})).status,'queued');
});
test('ChatGPT confirms through MCP: started resolves uncertainty, done carries the summary',async t=>{
  const {q}=await setup(t);
  const task=await q.enqueue({action:'start',prompt:'ping',request_id:'cb-1'});
  const claimed=await q.claim('desktop');
  assert.ok(claimed.prompt.includes('job_id='+task.id));
  assert.ok(!claimed.prompt.includes('\n')&&claimed.prompt.length<'ping'.length+260,'one short line');
  assert.equal(claimed.mention,'Chatgpt task lancher','the extension mentions the app itself');
  assert.equal((await q.enqueue({action:'start',prompt:'ping',request_id:'cb-1'})).id,task.id,'footer does not break idempotency');
  await q.report('desktop',{job_id:task.id,status:'needs_review',message:'not verified'});
  assert.equal(q.status(task.id).status,'needs_review');
  await q.modelReport({job_id:task.id,status:'started'});
  let st=q.status(task.id);
  assert.equal(st.status,'sent','the conversation answering proves delivery');
  assert.equal(st.model_status,'started');
  assert.match(st.next_step,/confirmed it started/);
  await q.modelReport({job_id:task.id,status:'done',summary:'PONG'});
  st=q.status(task.id);
  assert.equal(st.model_status,'done');
  assert.equal(st.model_summary,'PONG');
  assert.match(st.next_step,/model_summary/);
  await assert.rejects(q.modelReport({job_id:'nope',status:'done'}),/Unknown job_id/);
  await assert.rejects(q.modelReport({job_id:task.id,status:'weird'}),/status must be/);
  const open=await q.enqueue({action:'open',chat_ref:ID});
  await q.claim('desktop');
  await assert.rejects(q.modelReport({job_id:open.id,status:'started'}),/Unknown job_id/);
});
test('the chat address is kept when ChatGPT confirms before Chrome reports back',async t=>{
  const {q}=await setup(t);
  const task=await q.enqueue({action:'start',prompt:'ping'});
  await q.claim('desktop');
  await q.modelReport({job_id:task.id,status:'done',summary:'PONG'});
  assert.equal(q.status(task.id).status,'sent');
  const late=await q.report('desktop',{job_id:task.id,status:'sent',chat_url:URL});
  assert.equal(late.chat_id,ID);
  assert.equal(late.model_summary,'PONG');
  assert.equal(q.listChats().chats[0].chat_id,ID);
});

test('close job has no prompt and can only report closed or blocked',async t=>{
  const {q}=await setup(t);
  const task=await q.enqueue({action:'close',chat_ref:ID});
  assert.equal(task.effort,null);
  await q.claim('desktop');
  await assert.rejects(q.report('desktop',{job_id:task.id,status:'sent'}),/never report sent/);
  const done=await q.report('desktop',{job_id:task.id,status:'closed',chat_url:URL,message:'Closed 1 tab(s)'});
  assert.equal(done.status,'closed');
  assert.match(done.next_step,/stays in ChatGPT/);
});
