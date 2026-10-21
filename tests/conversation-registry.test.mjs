import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
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
test('Extra High default, idempotency and safe URL/slug/job-reference continuation',async t=>{
  const {q}=await setup(t);
  const first=await q.enqueue({action:'start',prompt:'ping',request_id:'accept-a'});
  assert.equal(first.effort,'xhigh');
  assert.equal(first.status,'queued');
  assert.equal(first.prompt,undefined,'prompt must not leak to job status');
  assert.equal((await q.enqueue({action:'start',prompt:'ping',request_id:'accept-a'})).id,first.id);
  await assert.rejects(q.enqueue({action:'start',prompt:'different',request_id:'accept-a'}),/Idempotency/);
  const continued=await q.enqueue({action:'continue',chat_ref:ID,prompt:'continue'});
  assert.equal(continued.chat_url,URL);
  assert.equal(continued.effort,'xhigh');
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,chat_url:URL,prompt:'x'}),/Exactly one/);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:'https://example.com/c/'+ID,prompt:'x'}),/Unknown or invalid/);
});
test('async progress, observed slug and durable registry survive restart',async t=>{
  const {q,file}=await setup(t);
  const task=await q.enqueue({action:'start',prompt:'ping'});
  const claimed=await q.claim('desktop');
  assert.equal(claimed.id,task.id);
  await q.progress('desktop',{job_id:task.id,phase:'loading'});
  assert.equal(q.status(task.id).phase,'loading');
  assert.equal(q.listChats().total,0,'do not invent a slug before route actually exists');
  await q.progress('desktop',{job_id:task.id,phase:'waiting_composer'});
  await q.progress('desktop',{job_id:task.id,phase:'submitting'});
  const reported=await q.report('desktop',{job_id:task.id,status:'sent',chat_url:URL,message:'Send control triggered'});
  assert.equal(reported.status,'sent');
  assert.equal(reported.result_chat_url,URL);
  assert.equal(q.chatStatus(task.id).chat_id,ID);
  assert.equal(q.chatStatus(ID).conversation.chat_url,URL);
  assert.equal(q.listChats().total,1);
  const next=new FileQueue(file,{desktop:token});
  await next.initialize();
  assert.equal(next.listChats().total,1);
  assert.equal(next.chatStatus(URL).conversation.source_job_id,task.id);
  assert.equal(next.deviceStatus('desktop').online,false);
  const follow=await next.enqueue({action:'continue',chat_ref:task.id,prompt:'Continue'});
  assert.equal(follow.chat_url,URL);
});
test('later ChatGPT URL observation is recorded without inventing Send success',async t=>{
  const {q,file}=await setup(t);
  const task=await q.enqueue({action:'start',prompt:'ping'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:task.id,status:'blocked',message:'send selector missing'});
  const observed=await q.observeChat('desktop',{job_id:task.id,chat_url:PROJECT});
  assert.equal(observed.chat_id,ID);
  assert.equal(q.status(task.id).status,'blocked');
  assert.equal(q.chatStatus(PROJECT).conversation.transport_status,'observed');
  const restarted=new FileQueue(file,{desktop:token});
  await restarted.initialize();
  assert.equal(restarted.chatStatus(PROJECT).registered,true);
  await assert.rejects(q.observeChat('desktop',{job_id:'missing',chat_url:URL}),/Job does not belong/);
});
test('open-only job navigates without any prompt/send and records URL; cannot report sent',async t=>{
  const {q}=await setup(t);
  const task=await q.enqueue({action:'open',chat_ref:ID,request_id:'open-test'});
  assert.equal(task.prompt,undefined);
  assert.equal(task.effort,'auto');
  assert.equal(task.chat_url,URL);
  await q.claim('desktop');
  await q.progress('desktop',{job_id:task.id,phase:'opening'});
  await assert.rejects(q.report('desktop',{job_id:task.id,status:'sent',chat_url:URL}),/Open-only/);
  const done=await q.report('desktop',{job_id:task.id,status:'opened',chat_url:URL});
  assert.equal(done.status,'opened');
  assert.equal(q.chatStatus(ID).registered,true);
});
