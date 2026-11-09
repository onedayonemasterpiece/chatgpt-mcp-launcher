import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileQueue} from '../relay/queue.mjs';
import {makeRelay,bookActivityReaderFromEnv,bookNoticeText} from '../relay/server.mjs';

const ING1='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ING2='11111111-2222-3333-4444-555555555555';
const ING3='99999999-aaaa-bbbb-cccc-dddddddddddd';
const CHAT='https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NEXT='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
const THIRD='https://chatgpt.com/c/99999999-aaaa-bbbb-cccc-dddddddddddd';
const THREAD='https://mira-projects.slack.com/archives/C0C8RT9JB2P/p1792868771439369';
const CONTINUE='Продолжай. Сначала book_ingest(status) по указанному ingestion_id. Принятые страницы не повторяй.';
const DEVICE='test-device-token-00000000000000000000';

async function fixture(t,{random=Math.random}={}) {
  const dir=await mkdtemp(join(tmpdir(),'launcher-book-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'queue.json');
  let time=Date.parse('2026-10-30T06:00:00Z');
  const now=()=>time;
  const q=new FileQueue(file,{desktop:DEVICE},{now,random});
  await q.initialize();
  const start=async(books=[{ingestion_id:ING1}],request_id='books-1')=>q.enqueue({
    action:'start',request_id,prompt:'Начни импорт первой книги.',
    slack_thread_url:THREAD,book:{books,continuation_prompt:CONTINUE}
  });
  const deliver=async(job,url=CHAT)=>{
    const claimed=await q.claim('desktop');
    assert.equal(claimed?.id,job.job_id||job.id);
    await q.report('desktop',{job_id:claimed.id,status:'sent',chat_url:url});
    return claimed;
  };
  const activity=async(job,state='staged',last_operation_at=new Date(time).toISOString(),accepted_pages=14)=>{
    const next_action={staged:'continue_pages',processing:'wait',finalized:'done',failed:'blocker'}[state];
    return q.bookActivity({book_task_id:job.job_id||job.id,state,next_action,last_operation_at,
      accepted_pages,next_cursor:'40'});
  };
  return {q,file,now,start,deliver,activity,advance(ms){time+=ms;}};
}


test('unavailable book continuation reuses the one fresh-chat fallback and preserves book identity',async t=>{
  const f=await fixture(t);const first=await f.start();await f.deliver(first);
  await f.activity(first,'staged',new Date(f.now()).toISOString(),0);
  await f.q.modelReport({job_id:first.job_id,status:'done'});
  f.advance(1000);await f.activity(first,'staged',new Date(f.now()).toISOString(),1);
  await f.q.tick();const continuation=await f.q.claim('desktop');
  assert.equal(continuation.action,'continue');
  await f.q.report('desktop',{job_id:continuation.id,status:'blocked',chat_url:CHAT,
    message:'ChatGPT conversation unavailable; nothing was sent'});
  const fallback=await f.q.claim('desktop');
  assert.equal(fallback?.action,'start');
  assert.equal(fallback.chat_url,null);assert.equal(fallback.book_task_id,first.job_id);
  assert.equal(fallback.book_index,0);assert.match(fallback.own_text,new RegExp(ING1));
  await f.q.report('desktop',{job_id:fallback.id,status:'sent',chat_url:NEXT});
  await f.q.tick();assert.equal(await f.q.claim('desktop'),null);
  const stored=JSON.parse(await readFile(f.file,'utf8'));
  assert.equal(stored.book_tasks[0].job_id,fallback.id);
  assert.equal(stored.jobs.filter(j=>j.fallback_of===continuation.id).length,1);
});

test('unavailable observer is not reopened repeatedly; ordinary silence handoff remains available',async t=>{
  const f=await fixture(t);const first=await f.start();await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});await f.activity(first);
  f.advance(1000);const last=new Date(f.now()).toISOString();
  await f.activity(first,'staged',last,15);f.advance(60000);await f.activity(first,'staged',last,15);
  const observer=await f.q.claim('desktop');assert.equal(observer.action,'reconcile');
  await f.q.report('desktop',{job_id:observer.id,status:'read',chat_url:CHAT,
    message:'ChatGPT conversation unavailable; no completion proof',delivery_evidence:'unknown'});
  f.advance(6*60000);await f.activity(first,'staged',last,15);
  assert.equal(await f.q.claim('desktop'),null,'do not reopen a known unavailable conversation');
  f.advance(20*60000);await f.activity(first,'staged',last,15);await f.q.tick();
  const replacement=await f.q.claim('desktop');assert.equal(replacement.action,'start');
  assert.equal(replacement.book_task_id,first.job_id);assert.equal(replacement.chat_url,null);
  assert.equal(f.q.status(first.job_id).model_status,'started','no invented completion');
});
