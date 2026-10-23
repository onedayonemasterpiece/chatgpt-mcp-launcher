import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {FileQueue} from '../relay/queue.mjs';

const ID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const URL='https://chatgpt.com/c/'+ID;
const KEY='test-'+'x'.repeat(32);
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'launcher-reconcile-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'queue.json');
  const q=new FileQueue(file,{desktop:KEY});
  await q.initialize();
  return {q,file};
}
async function ambiguous(q) {
  const first=await q.enqueue({action:'start',prompt:'original'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:first.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:first.id,status:'done'});
  const follow=await q.enqueue({action:'continue',chat_ref:ID,prompt:'do not duplicate',request_id:'original-continue'});
  const claimed=await q.claim('desktop');
  assert.equal(claimed.id,follow.id);
  await q.report('desktop',{job_id:follow.id,status:'needs_review',chat_url:URL,
    message:'Frame 0 was removed',page_state:{composer_text:'empty'}});
  assert.equal(q.status(follow.id).status,'needs_review');
  return follow;
}
test('one read-only probe confirms original delivery without rerunning or fabricating model status',async t=>{
  const {q,file}=await setup(t);
  const original=await ambiguous(q);
  assert.equal(q.listChats().chats[0].continuation_count,0);
  const probe=await q.reconcile(original.id,'probe-1');
  assert.equal(probe.action,'reconcile');
  assert.equal(probe.prompt,undefined);
  assert.equal((await q.reconcile(original.id,'probe-2')).id,probe.id,'concurrent probes coalesce');
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'new work'}),/needs review|reconcile/i);
  const worker=await q.claim('desktop');
  assert.equal(worker.action,'reconcile');
  assert.equal(worker.verify_job_id,original.id);
  assert.equal(worker.prompt,null);
  const done=await q.report('desktop',{job_id:probe.id,status:'read',chat_url:URL,
    delivery_evidence:'sent',evidence_kind:'user_message_marker'});
  assert.equal(done.status,'read');
  assert.equal(done.reconcile_status,'sent');
  const resolved=q.status(original.id);
  assert.equal(resolved.status,'sent');
  assert.equal(resolved.delivery_counted,true);
  assert.equal(resolved.continuation_count,1);
  assert.equal(resolved.model_status,undefined,'no invented model completion or started');
  assert.equal(resolved.execution,'awaiting_confirmation');
  assert.equal((await q.reconcile(original.id,'probe-1')).id,probe.id,'same request_id is idempotent after resolution');
  const state=JSON.parse(await readFile(file,'utf8'));
  assert.equal(state.jobs.filter(j=>j.id===original.id).length,1);
  const reload=new FileQueue(file,{desktop:KEY});
  await reload.initialize();
  assert.equal(reload.status(original.id).continuation_count,1);
  assert.equal((await reload.reconcile(original.id,'probe-1')).id,probe.id);
  await assert.rejects(reload.enqueue({action:'continue',chat_ref:ID,prompt:'never duplicate active'}),/unconfirmed|working/i);
});

test('unreadable DOM, missing marker and mismatched URL cannot resolve unknown',async t=>{
  const {q}=await setup(t);
  const original=await ambiguous(q);
  const p=await q.reconcile(original.id,'missing');
  await q.claim('desktop');
  const unknown=await q.report('desktop',{job_id:p.id,status:'read',chat_url:URL,
    delivery_evidence:'unknown',evidence_kind:'unconfirmed'});
  assert.equal(unknown.reconcile_status,'needs_review');
  assert.equal(q.status(original.id).status,'needs_review');
  const second=await q.reconcile(original.id,'different-tab');
  await q.claim('desktop');
  const bad=await q.report('desktop',{job_id:second.id,status:'read',
    chat_url:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    delivery_evidence:'sent',evidence_kind:'conversation_marker'});
  assert.equal(bad.reconcile_status,'needs_review');
  assert.equal(q.status(original.id).continuation_count,0);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'not safe'}),/needs review|reconcile/i);
  await assert.rejects(q.retry(original.id),/may already have been sent/i);
  assert.equal(q.status(original.id).fallback_job_id,undefined);
});

test('mismatched/spoofed evidence and duplicate request IDs never change original job',async t=>{
  const {q}=await setup(t);
  const original=await ambiguous(q);
  const check=await q.reconcile(original.id,'proof');
  await assert.rejects(q.reconcile(original.id,'original-continue'),/Idempotency key belongs/i);
  await q.claim('desktop');
  const bad=await q.report('desktop',{job_id:check.id,status:'read',chat_url:URL,
    delivery_evidence:'sent',evidence_kind:'unknown'});
  assert.equal(bad.reconcile_status,'needs_review');
  assert.equal(q.status(original.id).status,'needs_review');
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'another'}),/needs review|reconcile/i);
  assert.equal((await q.reconcile(original.id,'proof')).id,check.id);
});

test('late real model report after unreadable reconciliation resolves only delivery and counts once',async t=>{
  const {q}=await setup(t);
  const original=await ambiguous(q);
  const check=await q.reconcile(original.id,'maybe');
  await q.claim('desktop');
  await q.report('desktop',{job_id:check.id,status:'read',chat_url:URL,
    delivery_evidence:'unknown'});
  await q.modelReport({job_id:original.id,status:'started'});
  assert.equal(q.status(original.id).continuation_count,1);
  await q.modelReport({job_id:original.id,status:'done',summary:'actual work result'});
  assert.equal(q.status(original.id).model_summary,'actual work result');
  assert.equal(q.status(original.id).continuation_count,1);
});

const driver=await readFile(new globalThis.URL('../extension/page-driver.js',import.meta.url),'utf8');
function inspect({main='',user='',draft='',wrongPage=false,noMain=false}={}) {
  const marker='job_id='+ID;
  const editor={id:'prompt-textarea',innerText:draft,textContent:draft,isConnected:true,
    getBoundingClientRect:()=>({width:300,height:40}),matches:()=>false,getAttribute:()=>null};
  const mainNode={innerText:main};
  const userNode={innerText:user,textContent:user};
  const document={
    querySelectorAll(selector){
      if(selector==='[contenteditable="true"],textarea')return [editor];
      if(selector==='main')return noMain?[]:[mainNode];
      if(selector==='[data-message-author-role="user"]')return user?[userNode]:[];
      return [];
    }
  };
  const context={document,window:{location:{href:wrongPage?'https://chatgpt.com/':URL},
    getComputedStyle:()=>({visibility:'visible',display:'block'})},
    globalThis:null,URL:globalThis.URL,setTimeout:fn=>{queueMicrotask(fn);return 1;}};
  context.globalThis=context;
  runInNewContext(driver,context,{timeout:2000});
  return context.chatGPTLauncherReconcile({action:'reconcile',verify_job_id:ID});
}
test('read-only browser probe accepts exact user marker; never returns conversation content',async()=>{
  const result=await inspect({user:'Hello job_id='+ID+' done',main:'unrelated'});
  assert.equal(result.delivery_evidence,'sent');
  assert.equal(result.evidence_kind,'user_message_marker');
  assert.equal(JSON.stringify(result).includes('Hello'),false);
});
test('read-only browser probe handles marker inside visible main without role selectors',async()=>{
  const result=await inspect({main:'Conversation turn: job_id='+ID+' current'});
  assert.equal(result.delivery_evidence,'sent');
  assert.equal(result.evidence_kind,'conversation_marker');
});
test('marker only in unsent editor, absent content or unrendered page is NEVER sent evidence',async()=>{
  for(const sample of [{main:'',draft:'job_id='+ID},
    {main:'job_id='+ID,draft:'job_id='+ID},
    {main:''},{main:'job_id='+ID,noMain:true},
    {main:'job_id='+ID,wrongPage:true}]) {
    const result=await inspect(sample);
    assert.equal(result.delivery_evidence,'unknown',JSON.stringify(sample));
  }
});
