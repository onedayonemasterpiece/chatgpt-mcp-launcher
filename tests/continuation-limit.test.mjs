import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileQueue} from '../relay/queue.mjs';

const ID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NEW='11111111-2222-3333-4444-555555555555';
const URL='https://chatgpt.com/c/'+ID;
const NEW_URL='https://chatgpt.com/c/'+NEW;
const TOKEN='test-device-token';
async function setup(t,options={}) {
  const dir=await mkdtemp(join(tmpdir(),'launcher-limit-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'queue.json');
  const q=new FileQueue(file,{desktop:TOKEN},options);
  await q.initialize();
  return {q,file};
}
const chat=(q,url=URL)=>q.listChats().chats.find(c=>c.chat_url===url);
async function startKnown(q,url=URL,prompt='Original owner instruction') {
  const j=await q.enqueue({action:'start',prompt});
  const worker=await q.claim('desktop');
  assert.equal(worker.action,'start');
  await q.report('desktop',{job_id:j.id,status:'sent',chat_url:url});
  await q.modelReport({job_id:j.id,status:'done',summary:'original completed'});
  assert.equal(chat(q,url).continuation_count,0);
  return j;
}
async function deliverContinue(q,index=0,url=URL) {
  const j=await q.enqueue({action:'continue',chat_ref:url,prompt:'Follow-up '+index,request_id:'continue-'+index});
  assert.equal(j.delivery_action,undefined);
  const worker=await q.claim('desktop');
  assert.equal(worker.id,j.id);
  assert.equal(worker.action,'continue');
  await q.report('desktop',{job_id:j.id,status:'sent',chat_url:url});
  await q.modelReport({job_id:j.id,status:'done',summary:'done'});
  return j;
}

test('a freshly started chat begins at zero and gets five (not six) confirmed continuations',async t=>{
  const {q}=await setup(t);
  await startKnown(q);
  for(let n=0;n<5;n++) {
    assert.equal(chat(q).continuation_count,n);
    await deliverContinue(q,n);
    assert.equal(chat(q).continuation_count,n+1);
  }
  const next=await q.enqueue({action:'continue',chat_ref:ID,prompt:'Sixth task',request_id:'sixth'});
  assert.equal(next.action,'continue','caller requested a continuation');
  assert.equal(next.delivery_action,'start','Chrome must create a new chat');
  assert.equal(next.chat_id,null,'do not invent a new chat ID before Chrome reports it');
  assert.equal(next.chat_url,null);
  assert.equal(next.previous_chat_url,URL);
  assert.equal(next.handoff_reason,'limit_reached');
  assert.equal(chat(q).continuation_count,5);
  const worker=await q.claim('desktop');
  assert.equal(worker.action,'start');
  assert.equal(worker.chat_url,null,'never send the sixth prompt to the old tab');
  assert.match(worker.own_text,/Sixth task/);
  assert.match(worker.own_text,/Original owner instruction/,'include the initial prompt when retained');
  assert.match(worker.own_text,/https:\/\/chatgpt\.com\/c\//);
  assert.equal(worker.own_text.includes('Служебное:'),false,'the callback footer is separate');
  const delivered=await q.report('desktop',{job_id:next.id,status:'sent',chat_url:NEW_URL});
  assert.equal(delivered.chat_url,NEW_URL);
  assert.equal(delivered.chat_id,NEW);
  assert.equal(delivered.continuation_count,0,'a proven new chat begins at zero');
  assert.equal(chat(q,NEW_URL).previous_chat_url,URL);
  assert.equal(chat(q,URL).successor_chat_url,NEW_URL);
  await q.modelReport({job_id:next.id,status:'done',summary:'ok'});
  const inNew=await q.enqueue({action:'continue',chat_ref:NEW,prompt:'Work on new window'});
  assert.equal(inNew.delivery_action,undefined);
  assert.equal(inNew.chat_url,NEW_URL);
});

test('counts 0 and 4 deliver to existing tab; count 5 rolls over, no count consumed while queued',async t=>{
  const {q}=await setup(t);
  await startKnown(q);
  const first=await q.enqueue({action:'continue',chat_ref:ID,prompt:'one'});
  assert.equal(first.chat_url,URL);
  assert.equal(first.delivery_action,undefined);
  assert.equal(chat(q).continuation_count,0);
  await q.claim('desktop');
  await q.report('desktop',{job_id:first.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:first.id,status:'done'});
  for(let n=1;n<4;n++) await deliverContinue(q,n);
  assert.equal(chat(q).continuation_count,4);
  const fifth=await q.enqueue({action:'continue',chat_ref:URL,prompt:'fifth'});
  assert.equal(fifth.delivery_action,undefined);
  assert.equal(chat(q).continuation_count,4);
  await q.claim('desktop');
  await q.report('desktop',{job_id:fifth.id,status:'sent',chat_url:URL});
  assert.equal(chat(q).continuation_count,5);
});

test('legacy missing/null and unseen chat do not reconstruct a count: next continue starts NEW',async t=>{
  const {q,file}=await setup(t);
  await startKnown(q);
  const data=JSON.parse(await readFile(file,'utf8'));
  delete data.chats[0].continuation_count;
  await writeFile(file,JSON.stringify(data));
  const missing=new FileQueue(file,{desktop:TOKEN});
  await missing.initialize();
  const j=await missing.enqueue({action:'continue',chat_ref:ID,prompt:'Legacy work'});
  assert.equal(j.delivery_action,'start');
  assert.equal(j.handoff_reason,'unknown_count');
  assert.equal(j.chat_url,null);
  assert.equal(chat(missing).continuation_count,undefined);
  assert.equal((await missing.claim('desktop')).action,'start');
  await missing.report('desktop',{job_id:j.id,status:'sent',chat_url:NEW_URL});
  assert.equal(chat(missing,NEW_URL).continuation_count,0);
  assert.equal(chat(missing,URL).continuation_count,null);
  const data2=JSON.parse(await readFile(file,'utf8'));
  data2.jobs=data2.jobs.filter(x=>x.id!==j.id);
  const old=data2.chats.find(x=>x.chat_url===URL);
  old.continuation_count=null;
  delete old.successor_chat_url; // independent legacy snapshot without an established handoff
  data2.chats=data2.chats.filter(x=>x.chat_url===URL);
  await writeFile(file,JSON.stringify(data2));
  const reloaded=new FileQueue(file,{desktop:TOKEN});
  await reloaded.initialize();
  assert.equal((await reloaded.enqueue({action:'continue',chat_ref:ID,prompt:'Again'})).delivery_action,'start');
  const {q:unseen}=await setup(t);
  assert.equal((await unseen.enqueue({action:'continue',chat_ref:ID,prompt:'Unknown slug'})).delivery_action,'start');
});

test('initialize from old jobs-only JSON NEVER infers zero from historical sent starts',async t=>{
  const {file}=await setup(t);
  const legacy={jobs:[{id:'historical-start',action:'start',prompt:'old',
    device_id:'desktop',status:'sent',result_chat_url:URL,reported_at:new Date().toISOString(),
    model_status:'done',model_finished_at:new Date().toISOString()}]};
  await writeFile(file,JSON.stringify(legacy));
  const q=new FileQueue(file,{desktop:TOKEN});
  await q.initialize();
  assert.equal(chat(q).continuation_count,null);
  const pending=await q.enqueue({action:'continue',chat_ref:ID,prompt:'Resume old work'});
  assert.equal(pending.delivery_action,'start');
});

test('same request_id stays one job through handoff, sent receipt and relay restart',async t=>{
  const {q,file}=await setup(t);
  await startKnown(q);
  for(let n=0;n<5;n++) await deliverContinue(q,n);
  const args={action:'continue',chat_ref:ID,prompt:'Exactly once',request_id:'stable-rollover'};
  const first=await q.enqueue(args);
  assert.equal((await q.enqueue(args)).id,first.id);
  await assert.rejects(q.enqueue({...args,prompt:'other'}),/Idempotency/);
  const restarted=new FileQueue(file,{desktop:TOKEN});
  await restarted.initialize();
  assert.equal((await restarted.enqueue(args)).id,first.id);
  const worker=await restarted.claim('desktop');
  assert.equal(worker.action,'start');
  await restarted.report('desktop',{job_id:first.id,status:'sent',chat_url:NEW_URL});
  const duplicate=await restarted.enqueue(args);
  assert.equal(duplicate.id,first.id);
  assert.equal(duplicate.chat_url,NEW_URL);
  assert.equal(chat(restarted,URL).continuation_count,5);
  assert.equal(chat(restarted,NEW_URL).continuation_count,0);
  assert.equal((await restarted.claim('desktop')),null,'duplicate request cannot queue second browser send');
});

test('two concurrent requests at count 4 serialize: only one reserves slot five',async t=>{
  const {q}=await setup(t);
  await startKnown(q);
  for(let n=0;n<4;n++) await deliverContinue(q,n);
  const attempts=await Promise.allSettled([
    q.enqueue({action:'continue',chat_ref:ID,prompt:'A',request_id:'race-a'}),
    q.enqueue({action:'continue',chat_ref:ID,prompt:'B',request_id:'race-b'})
  ]);
  const fulfilled=attempts.filter(v=>v.status==='fulfilled');
  const rejected=attempts.filter(v=>v.status==='rejected');
  assert.equal(fulfilled.length,1);
  assert.equal(rejected.length,1);
  assert.match(String(rejected[0].reason),/already on its way/);
  const winner=fulfilled[0].value;
  assert.equal(winner.delivery_action,undefined);
  await q.claim('desktop');
  await q.report('desktop',{job_id:winner.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:winner.id,status:'done'});
  assert.equal(chat(q).continuation_count,5);
  const next=await q.enqueue({action:'continue',chat_ref:ID,prompt:'C'});
  assert.equal(next.delivery_action,'start');
});

test('Chrome sent and MCP report sent count the continuation only once',async t=>{
  const {q,file}=await setup(t);
  await startKnown(q);
  const c=await q.enqueue({action:'continue',chat_ref:ID,prompt:'confirmed'});
  await q.claim('desktop');
  await q.modelReport({job_id:c.id,status:'started'});
  assert.equal(chat(q).continuation_count,1);
  await q.modelReport({job_id:c.id,status:'done'});
  await q.report('desktop',{job_id:c.id,status:'sent',chat_url:URL});
  await q.report('desktop',{job_id:c.id,status:'sent',chat_url:URL});
  assert.equal(chat(q).continuation_count,1);
  const restarted=new FileQueue(file,{desktop:TOKEN});
  await restarted.initialize();
  assert.equal(chat(restarted).continuation_count,1);
  assert.equal((await restarted.enqueue({action:'continue',chat_ref:ID,prompt:'next'})).delivery_action,undefined);
});

test('unknown needs_review and active job block rollover; no blind duplicate',async t=>{
  const {q}=await setup(t);
  await startKnown(q);
  for(let n=0;n<4;n++) await deliverContinue(q,n);
  const ambiguous=await q.enqueue({action:'continue',chat_ref:ID,prompt:'fifth'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:ambiguous.id,status:'needs_review',chat_url:URL,
    page_state:{composer_text:'empty',composer:'present'}});
  assert.equal(chat(q).continuation_count,4);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'sixth'}),/needs review|Reconcile|reconcile/i);
  await assert.rejects(q.retry(ambiguous.id),/may already have been sent/);
  await q.modelReport({job_id:ambiguous.id,status:'started'});
  assert.equal(chat(q).continuation_count,5);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'sixth'}),/still working/);
  await q.modelReport({job_id:ambiguous.id,status:'done'});
  assert.equal((await q.enqueue({action:'continue',chat_ref:ID,prompt:'sixth'})).delivery_action,'start');
});

test('blocked before send does not spend a continuation; fallback is still one start and preserves links',async t=>{
  const {q}=await setup(t);
  await startKnown(q);
  const c=await q.enqueue({action:'continue',chat_ref:ID,prompt:'New task'});
  await q.claim('desktop');
  const st=await q.report('desktop',{job_id:c.id,status:'blocked',message:'Not sent'});
  assert.equal(chat(q).continuation_count,0);
  assert.ok(st.fallback_job_id);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'second'}),/already on its way/);
  const fallback=await q.claim('desktop');
  assert.equal(fallback.action,'start');
  assert.equal(fallback.id,st.fallback_job_id);
  await q.report('desktop',{job_id:fallback.id,status:'sent',chat_url:NEW_URL});
  assert.equal(chat(q,NEW_URL).continuation_count,0);
  assert.equal(chat(q,NEW_URL).previous_chat_url,URL);
  assert.equal(chat(q,URL).continuation_count,0);
});

test('a reroute with unverified new chat ID remains needs_review; never sends old chat or pretends success',async t=>{
  const {q}=await setup(t);
  await startKnown(q);
  for(let n=0;n<5;n++) await deliverContinue(q,n);
  const c=await q.enqueue({action:'continue',chat_ref:ID,prompt:'Rollover uncertain'});
  assert.equal((await q.claim('desktop')).action,'start');
  const r=await q.report('desktop',{job_id:c.id,status:'sent',chat_url:URL});
  assert.equal(r.status,'needs_review');
  assert.equal(r.chat_url,null);
  assert.equal(chat(q,URL).continuation_count,5);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'different'}),/reconcile|needs review/i);
  assert.equal(q.status(c.id).fallback_job_id,undefined,'unknown must not trigger a blind fallback');
  await q.modelReport({job_id:c.id,status:'started'});
  assert.equal(q.status(c.id).status,'sent');
  assert.equal(q.status(c.id).chat_id,null,'MCP model report alone cannot invent new chat ID');
});

test('legacy null and full counter survive read/open and repeated relay reboots',async t=>{
  const {q,file}=await setup(t);
  await startKnown(q);
  for(let n=0;n<5;n++) await deliverContinue(q,n);
  const read=await q.enqueue({action:'read',chat_ref:ID});
  await q.claim('desktop');
  await q.report('desktop',{job_id:read.id,status:'read',chat_url:URL,
    reply_text:'done',reply_generating:false});
  let r=new FileQueue(file,{desktop:TOKEN});
  await r.initialize();
  assert.equal(chat(r).continuation_count,5);
  const old=JSON.parse(await readFile(file,'utf8'));
  old.chats.find(x=>x.chat_url===URL).continuation_count=null;
  await writeFile(file,JSON.stringify(old));
  r=new FileQueue(file,{desktop:TOKEN});
  await r.initialize();
  assert.equal(chat(r).continuation_count,null);
  assert.equal((await r.enqueue({action:'continue',chat_ref:ID,prompt:'new'})).delivery_action,'start');
});

test('an already migrated predecessor rejects a second successor and names the real new chat',async t=>{
  const {q}=await setup(t);
  await startKnown(q);
  for(let n=0;n<5;n++) await deliverContinue(q,n);
  const req={action:'continue',chat_ref:ID,prompt:'Move once',request_id:'single-handoff'};
  const j=await q.enqueue(req);
  await q.claim('desktop');
  await q.report('desktop',{job_id:j.id,status:'sent',chat_url:NEW_URL});
  await q.modelReport({job_id:j.id,status:'done'});
  assert.equal((await q.enqueue(req)).id,j.id,'same request remains idempotent');
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'Another assignment'}),
    /already been handed off.*11111111/i,'new request using the old chat must not fork a second implementation');
  assert.equal((await q.enqueue({action:'continue',chat_ref:NEW,prompt:'Continue in successor'})).chat_url,NEW_URL);
});

test('handoff includes the entire original prompt when it fits, not a 1800 character excerpt',async t=>{
  const {q,file}=await setup(t);
  const original='Owner original task: '+ 'A'.repeat(8000);
  await startKnown(q,URL,original);
  const data=JSON.parse(await readFile(file,'utf8'));
  data.chats.find(c=>c.chat_url===URL).continuation_count=5;
  await writeFile(file,JSON.stringify(data));
  const r=new FileQueue(file,{desktop:TOKEN});
  await r.initialize();
  const move=await r.enqueue({action:'continue',chat_ref:ID,prompt:'Keep implementing'});
  assert.equal(move.delivery_action,'start');
  const worker=await r.claim('desktop');
  assert.equal(worker.action,'start');
  assert.ok(worker.own_text.includes(original),'opening task must be transmitted in full if budget permits');
  assert.ok(worker.own_text.includes('Keep implementing'));
});

test('handoff worker payload includes callbackFooter inside 30000 character limit',async t=>{
  const {q,file}=await setup(t);
  const original='Original task: '+ 'A'.repeat(29400);
  await startKnown(q,URL,original);
  const data=JSON.parse(await readFile(file,'utf8'));
  data.chats.find(c=>c.chat_url===URL).continuation_count=5;
  await writeFile(file,JSON.stringify(data));
  const r=new FileQueue(file,{desktop:TOKEN});
  await r.initialize();
  const continuation='Sixth continuation: '+ 'B'.repeat(900);
  const j=await r.enqueue({action:'continue',chat_ref:ID,prompt:continuation});
  assert.equal(j.delivery_action,'start');
  const worker=await r.claim('desktop');
  assert.equal(worker.id,j.id);
  assert.equal(worker.action,'start');
  assert.equal(worker.chat_url,null);
  assert.ok(worker.own_text.includes(continuation),'new instruction is never truncated');
  assert.match(worker.own_text,/Остальное — по ссылке выше/,'long opening prompt is truncated with source link');
  assert.ok(worker.prompt.endsWith('job_id='+j.id+
    ' status=started, в конце status=done и summary; если нужно чьё-то решение — status=blocked и в summary какое и от кого.)'));
  assert.equal(worker.prompt.length,30000,'maximal handoff must fit Chrome preparePrompt exactly, including callbackFooter');
});

test('at queue capacity no needs_review or unconfirmed job can be silently pruned',async t=>{
  const {file}=await setup(t);
  const now=new Date().toISOString();
  const pending=Array.from({length:500},(_,n)=>({
    id:'uncertain-'+n,action:'continue',device_id:'desktop',chat_url:URL,
    prompt:'Uncertain '+n,request_id:'req-'+n,status:'needs_review',
    created_at:now,claimed_at:now,reported_at:now
  }));
  await writeFile(file,JSON.stringify({jobs:pending,chats:[],device_status:{}}));
  const q=new FileQueue(file,{desktop:TOKEN});
  await q.initialize();
  await assert.rejects(q.enqueue({action:'start',prompt:'new work'}),/Queue capacity reached/);
  assert.equal(q.status('uncertain-0').status,'needs_review');
  const same=await q.enqueue({action:'continue',chat_ref:ID,prompt:'Uncertain 0',request_id:'req-0'});
  assert.equal(same.id,'uncertain-0','duplicate request stays idempotent despite capacity');
  const after=new FileQueue(file,{desktop:TOKEN});
  await after.initialize();
  assert.equal(after.status('uncertain-499').status,'needs_review','uncertainty survives relay restart');
});

test('pruned completed job leaves a durable request_id receipt across restarts',async t=>{
  const {q,file}=await setup(t);
  const original=await q.enqueue({action:'start',prompt:'Do not send twice',request_id:'lost-ack'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:original.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:original.id,status:'done',summary:'complete'});
  const data=JSON.parse(await readFile(file,'utf8'));
  const old=new Date(Date.now()-3_600_000).toISOString();
  for(let n=0;n<499;n++) data.jobs.push({
    id:'expired-'+n,action:'read',device_id:'desktop',status:'expired',created_at:old,reported_at:old
  });
  await writeFile(file,JSON.stringify(data));
  const r=new FileQueue(file,{desktop:TOKEN});
  await r.initialize();
  assert.equal((await r.enqueue({action:'start',prompt:'unrelated new request'})).status,'queued');
  assert.equal(r.status(original.id),null,'old completed job was correctly removed from bounded active queue');
  const replay=await r.enqueue({action:'start',prompt:'Do not send twice',request_id:'lost-ack'});
  assert.equal(replay.id,original.id,'same request must not cause a second Chrome send');
  assert.equal(replay.archived,true);
  assert.equal(replay.status,'sent');
  assert.equal((await r.claim('desktop')).action,'start','only the unrelated new request is claimable');
  await assert.rejects(r.enqueue({action:'start',prompt:'Different task',request_id:'lost-ack'}),/Idempotency/);
  const persisted=new FileQueue(file,{desktop:TOKEN});
  await persisted.initialize();
  assert.equal((await persisted.enqueue({action:'start',prompt:'Do not send twice',request_id:'lost-ack'})).id,original.id);
  const state=JSON.parse(await readFile(file,'utf8'));
  assert.equal(state.request_receipts.length,1);
  assert.equal(JSON.stringify(state.request_receipts).includes('Do not send twice'),false,'compact ledger stores a digest, not prompt');
});
