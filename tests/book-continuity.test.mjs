import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileQueue} from '../relay/queue.mjs';

const CHAT='https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NEXT='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
const THREAD='https://mira-projects.slack.com/archives/C0C8RT9JB2P/p1792868771439369';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'launcher-book-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'queue.json');
  let time=Date.parse('2026-10-30T06:00:00Z');
  const now=()=>time;
  const q=new FileQueue(file,{desktop:'test-device-token'},{now});
  await q.initialize();
  const start=async(ingestion='ingestion-1',request_id='book-1')=>q.enqueue({
    action:'start',request_id,prompt:'Read an RKB book with book_ingest(status)',
    slack_thread_url:THREAD,book:{ingestion_id:ingestion,
      continuation_prompt:'Продолжай прежний ingestion. Сначала book_ingest(status); принятые страницы не повторяй.'}
  });
  const deliver=async(job,url=CHAT)=>{
    const claimed=await q.claim('desktop');
    assert.equal(claimed.id,job.job_id);
    await q.report('desktop',{job_id:job.job_id,status:'sent',chat_url:url});
    return claimed;
  };
  return {q,file,now,start,deliver,advance(ms){time+=ms;}};
}

test('completed assistant page automatically continues in same chat without model done',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  f.advance(31_000);
  await f.q.tick();
  const probe=await f.q.claim('desktop');
  assert.equal(probe.action,'reconcile','reuse PR 45 read-only completion evidence');
  assert.equal(probe.verify_job_id,first.job_id);
  await f.q.report('desktop',{job_id:probe.id,status:'read',chat_url:CHAT,
    delivery_evidence:'sent',evidence_kind:'user_message_marker',execution_evidence:'page_completed'});
  await f.q.tick();
  const next=await f.q.claim('desktop');
  assert.equal(next.action,'continue');
  assert.equal(next.chat_url,CHAT);
  assert.match(next.own_text,/book_ingest\(status\)/);
  assert.equal(next.slack_thread_url,null,'do not ask ChatGPT to post every book turn in Slack');
  assert.match(next.prompt,/единственный итог по книге отправляет Launcher/);
  assert.equal(f.q.status(first.job_id).book_task.current_job_id,next.id);
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'no concurrent duplicate continuation');
});

test('20 minutes without an RKB operation makes exactly one new chat; repeats are safe',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  f.advance(20*60_000+1_000);
  await f.q.bookActivity({book_task_id:first.job_id,state:'continue_pages',
    last_operation_at:new Date(f.now()-21*60_000).toISOString()});
  await f.q.tick();
  const replacement=await f.q.claim('desktop');
  assert.equal(replacement.action,'start','stale book operation forces rollover');
  assert.equal(replacement.previous_chat_url,CHAT);
  assert.equal(replacement.handoff_reason,'book_silent');
  assert.match(replacement.own_text,/book_ingest\(status\)/);
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'one outstanding successor only');
  await f.q.report('desktop',{job_id:replacement.id,status:'sent',chat_url:NEXT});
  const restored=new FileQueue(f.file,{desktop:'test-device-token'},{now:f.now});
  await restored.initialize();
  await restored.tick();
  assert.equal(await restored.claim('desktop'),null,'reload does not fork the successor');
  assert.equal(restored.status(first.job_id).book_task.current_job_id,replacement.id);
});

test('explicit whole-book done stops; generic per-turn done continues',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'done',summary:'Finished one turn'});
  await f.q.tick();
  const second=await f.q.claim('desktop');
  assert.equal(second.action,'continue');
  await f.q.report('desktop',{job_id:second.id,status:'sent',chat_url:CHAT});
  await f.q.modelReport({job_id:second.id,status:'done',book_completed:true,summary:'Книга дочитана'});
  await f.q.tick();
  assert.equal(f.q.bookTaskStatus(first.job_id).state,'done');
  assert.equal(await f.q.claim('desktop'),null);
  assert.equal(f.q.pendingBookNotices().length,1);
  await f.q.bookNoticeSent(first.job_id);
  await f.q.tick();
  assert.equal(f.q.pendingBookNotices().length,0,'only one terminal Slack notice');
  const restored=new FileQueue(f.file,{desktop:'test-device-token'},{now:f.now});
  await restored.initialize();
  assert.equal(restored.pendingBookNotices().length,0,'notice receipt survives restart');
});

test('duplicate starts or ticks never produce two active chats for one ingestion',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  assert.equal((await f.start()).job_id,first.job_id,'durable request_id');
  await assert.rejects(f.start('changed-ingestion','book-1'),/Idempotency key/);
  await assert.rejects(f.start('ingestion-1','different-key'),/already has an active book task/);
  await f.deliver(first);
  await assert.rejects(f.q.enqueue({action:'continue',chat_ref:CHAT,prompt:'unsafe',
    book_stale:true}),/unconfirmed|still working/,'caller cannot bypass in-flight guard');
  await f.q.modelReport({job_id:first.job_id,status:'done'});
  await Promise.all([f.q.tick(),f.q.tick(),f.q.tick()]);
  const next=await f.q.claim('desktop');
  assert.equal(next.action,'continue');
  assert.equal(await f.q.claim('desktop'),null);
});

test('90-minute window rolls over on completed turn; unavailable RKB never means silence',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  f.advance(90*60_000+1_000);
  await f.q.bookActivity({book_task_id:first.job_id,state:'unavailable'});
  await f.q.modelReport({job_id:first.job_id,status:'done'});
  await f.q.tick();
  const next=await f.q.claim('desktop');
  assert.equal(next.action,'start','normal window-age rollover');
  assert.equal(next.handoff_reason,'book_window_age');
  assert.equal(next.previous_chat_url,CHAT);
});


test('late whole-book report cancels a continuation queued from page completion',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  f.advance(31_000);
  await f.q.tick();
  const probe=await f.q.claim('desktop');
  await f.q.report('desktop',{job_id:probe.id,status:'read',chat_url:CHAT,
    delivery_evidence:'sent',evidence_kind:'user_message_marker',execution_evidence:'page_completed'});
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.state,'active');
  await f.q.modelReport({job_id:first.job_id,status:'done',book_completed:true,summary:'All pages done'});
  await f.q.tick();
  assert.equal(f.q.bookTaskStatus(first.job_id).state,'done');
  assert.equal(await f.q.claim('desktop'),null,'do not deliver already queued successor after book done');
});
