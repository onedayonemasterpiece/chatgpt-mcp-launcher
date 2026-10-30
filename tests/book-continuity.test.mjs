import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileQueue} from '../relay/queue.mjs';
import {makeRelay,bookActivityReaderFromEnv} from '../relay/server.mjs';

const ING1='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ING2='11111111-2222-3333-4444-555555555555';
const ING3='99999999-aaaa-bbbb-cccc-dddddddddddd';
const CHAT='https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NEXT='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
const THIRD='https://chatgpt.com/c/99999999-aaaa-bbbb-cccc-dddddddddddd';
const THREAD='https://mira-projects.slack.com/archives/C0C8RT9JB2P/p1792868771439369';
const CONTINUE='Продолжай. Сначала book_ingest(status) по указанному ingestion_id. Принятые страницы не повторяй.';
const DEVICE='test-device-token-00000000000000000000';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'launcher-book-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'queue.json');
  let time=Date.parse('2026-10-30T06:00:00Z');
  const now=()=>time;
  const q=new FileQueue(file,{desktop:DEVICE},{now});
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
  const activity=async(job,state='staged',last_operation_at=new Date(time).toISOString())=>{
    const next_action={staged:'continue_pages',processing:'wait',finalized:'done',failed:'blocker'}[state];
    return q.bookActivity({book_task_id:job.job_id||job.id,state,next_action,last_operation_at,
      accepted_pages:14,next_cursor:'40'});
  };
  return {q,file,now,start,deliver,activity,advance(ms){time+=ms;}};
}

test('30-minute active reading creates no browser probes or short tasks; real turn completion continues same chat',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  const initial=await f.deliver(first);
  assert.match(initial.own_text,new RegExp(ING1),'first window receives its book selector');
  await f.activity(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  for(let minute=0;minute<30;minute++) {
    f.advance(60_000);
    await f.activity(first);
    await f.q.tick();
    assert.equal(await f.q.claim('desktop'),null,'ongoing RKB reading needs no browser inspection or continuation');
  }
  await f.q.modelReport({job_id:first.job_id,status:'done',summary:'End of a real working turn'});
  await f.q.tick();
  const next=await f.q.claim('desktop');
  assert.equal(next.action,'continue');
  assert.equal(next.chat_url,CHAT);
  assert.match(next.own_text,/book_ingest\(status\)/);
  assert.equal(next.slack_thread_url,null,'no per-turn Slack messages');
  assert.equal(f.q.status(first.job_id).book_task.state,'active');
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'one in-flight continuation');
});

test('20 minutes only with staged/continue_pages and RKB last_operation_at: one successor',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  const previous=new Date(f.now()-60_000).toISOString();
  await f.activity(first,'staged',previous);
  f.advance(21*60_000);
  await f.q.bookActivity({book_task_id:first.job_id,state:'unavailable'});
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'unavailable RKB cannot start a replacement or browser probe');
  await f.activity(first,'staged',previous);
  await Promise.all([f.q.tick(),f.q.tick()]);
  const replacement=await f.q.claim('desktop');
  assert.equal(replacement.action,'start');
  assert.equal(replacement.previous_chat_url,CHAT);
  assert.equal(replacement.handoff_reason,'book_silent');
  assert.equal(replacement.slack_thread_url,null);
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null);
  await f.q.report('desktop',{job_id:replacement.id,status:'sent',chat_url:NEXT});
  const recovered=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
  await recovered.initialize();
  await recovered.tick();
  assert.equal(await recovered.claim('desktop'),null,'no second successor after restart');
  assert.equal(recovered.status(first.job_id).book_task.current_job_id,replacement.id);
});

test('finished turn waits for RKB readiness and then continues same chat even after a cold interval',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  const oldOperation=new Date(f.now()).toISOString();
  await f.activity(first,'processing',oldOperation);
  await f.q.modelReport({job_id:first.job_id,status:'done',summary:'Ordinary native wait'});
  f.advance(35*60_000);
  await f.activity(first,'processing',oldOperation);
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'backend wait must not create short reading turns');
  await f.q.bookActivity({book_task_id:first.job_id,state:'unavailable'});
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'unavailable backend must not create short reading turns');
  await f.activity(first,'staged',oldOperation);
  await f.q.tick();
  const next=await f.q.claim('desktop');
  assert.equal(next.action,'continue','known completed turn is not a silent/dead window');
  assert.equal(next.chat_url,CHAT);
  assert.equal(f.q.status(first.job_id).book_task.state,'active');
});

test('ordered books: only RKB finalized/done moves to next NEW chat, finally stops',async t=>{
  const f=await fixture(t);
  const first=await f.start([{ingestion_id:ING1},{ingestion_id:ING2,telegram_original:'t.me/c/1/2'}]);
  assert.equal((await f.start([{ingestion_id:ING1},{ingestion_id:ING2,telegram_original:'t.me/c/1/2'}])).job_id,
    first.job_id);
  await f.deliver(first);
  await f.activity(first);
  await f.q.modelReport({job_id:first.job_id,status:'done',book_completed:true,summary:'Модель утверждает что дочитала'});
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.state,'active','model is not RKB source of truth');
  await f.activity(first,'finalized');
  await f.q.tick();
  const next=await f.q.claim('desktop');
  assert.equal(next.action,'start','next book always new chat');
  assert.match(next.prompt,new RegExp(ING2));
  assert.equal(f.q.status(first.job_id).book_task.current_book_index,1);
  assert.equal(f.q.pendingBookNotices().length,0,'no terminal message between books');
  await f.q.report('desktop',{job_id:next.id,status:'sent',chat_url:NEXT});
  await f.activity(first,'processing');
  f.advance(25*60_000);
  await f.activity(first,'processing');
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'RKB processing/wait cannot start a stale chat or browser probe');
  await f.activity(first,'finalized');
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.state,'done');
  assert.equal(await f.q.claim('desktop'),null);
  const notice=f.q.pendingBookNotices();
  assert.equal(notice.length,1);
  assert.equal(notice[0].kind,'terminal');
  await f.q.bookNoticeSent(first.job_id,notice[0].notice_id);
  const recovered=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
  await recovered.initialize();
  assert.equal(recovered.pendingBookNotices().length,0);
});

test('retired book tabs close after confirmed replacement or finalization, with durable busy retry',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  const oldOp=new Date(f.now()).toISOString();
  f.advance(21*60_000);
  await f.activity(first,'staged',oldOp);
  await f.q.tick();
  await f.q.closeRetiredBookChats();
  const replacement=await f.q.claim('desktop');
  assert.equal(replacement.action,'start');
  assert.equal(await f.q.claim('desktop'),null,'unconfirmed replacement keeps predecessor tab');
  await f.q.report('desktop',{job_id:replacement.id,status:'sent',chat_url:NEXT});
  await f.q.closeRetiredBookChats();
  const close=await f.q.claim('desktop');
  assert.equal(close.action,'close');
  assert.equal(close.chat_url,CHAT);
  await f.q.closeRetiredBookChats();
  assert.equal(await f.q.claim('desktop'),null,'only one pending close');
  await f.q.report('desktop',{job_id:close.id,status:'blocked',chat_url:CHAT,message:'ChatGPT still answering'});
  const recovered=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
  await recovered.initialize();
  await recovered.closeRetiredBookChats();
  const retry=await recovered.claim('desktop');
  assert.equal(retry.action,'close');
  assert.equal(retry.chat_url,CHAT);
  await recovered.report('desktop',{job_id:retry.id,status:'closed',chat_url:CHAT});
  await recovered.closeRetiredBookChats();
  assert.equal(await recovered.claim('desktop'),null,'closed predecessor and active current tab stay untouched');
  await recovered.bookActivity({book_task_id:first.job_id,state:'finalized',next_action:'done'});
  await recovered.tick();
  await recovered.closeRetiredBookChats();
  const finished=await recovered.claim('desktop');
  assert.equal(finished.action,'close');
  assert.equal(finished.chat_url,NEXT,'finalization retires the last reader tab');
  await recovered.report('desktop',{job_id:finished.id,status:'blocked',chat_url:NEXT,message:'Tab left open: unsent draft'});
  await recovered.closeRetiredBookChats();
  assert.equal(await recovered.claim('desktop'),null,'owner draft is left alone without repeated probes');
});

test('two confirmed replacements without a new RKB operation emit ONE warning, stay active, throttle 20min',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  const oldOp=new Date(f.now()-60_000).toISOString();
  await f.activity(first,'staged',oldOp);
  for(const [index,url] of [[1,NEXT],[2,THIRD]]) {
    f.advance(21*60_000);
    await f.activity(first,'staged',oldOp);
    await f.q.tick();
    const replacement=await f.q.claim('desktop');
    assert.equal(replacement.action,'start');
    assert.equal(replacement.handoff_reason,'book_silent');
    await f.q.report('desktop',{job_id:replacement.id,status:'sent',chat_url:url});
    await f.q.tick();
    const observed=f.q.status(first.job_id).book_task;
    assert.equal(observed.no_progress_new_chats,index);
    assert.equal(observed.state,'active');
  }
  const notices=f.q.pendingBookNotices();
  assert.equal(notices.length,1);
  assert.equal(notices[0].kind,'no_progress');
  assert.equal(notices[0].no_progress_new_chats,2);
  await f.q.bookNoticeSent(first.job_id,notices[0].notice_id);
  await f.q.tick();
  assert.equal(f.q.pendingBookNotices().length,0);
  const recovered=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
  await recovered.initialize();
  assert.equal(recovered.pendingBookNotices().length,0,'receipt survives reboot');
  await f.activity(first,'staged',new Date(f.now()).toISOString());
  assert.equal(f.q.status(first.job_id).book_task.no_progress_new_chats,0,
    'new RKB operation resets the no-progress streak');
});

test('book continuations stay in the same chat past five turns until its 90-minute lifetime',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  const oldOp=new Date(f.now()-60_000).toISOString();
  f.advance(21*60_000);
  await f.activity(first,'staged',oldOp);
  await f.q.tick();
  const replacement=await f.q.claim('desktop');
  await f.q.report('desktop',{job_id:replacement.id,status:'sent',chat_url:NEXT});
  await f.q.modelReport({job_id:replacement.id,status:'done'});
  await f.q.tick();
  // The ordinary task limit must not fragment a book into new chats.
  for(let n=0;n<7;n++) {
    const next=await f.q.claim('desktop');
    assert.equal(next.action,'continue');
    await f.q.report('desktop',{job_id:next.id,status:'sent',chat_url:NEXT});
    await f.q.modelReport({job_id:next.id,status:'done'});
    await f.q.tick();
  }
  const eighth=await f.q.claim('desktop');
  assert.equal(eighth.action,'continue');
  await f.q.report('desktop',{job_id:eighth.id,status:'sent',chat_url:NEXT});
  f.advance(90*60_000);
  await f.activity(first,'staged',oldOp);
  await f.q.modelReport({job_id:eighth.id,status:'done'});
  await f.q.tick();
  const later=await f.q.claim('desktop');
  assert.equal(later.action,'start');
  assert.equal(later.previous_chat_url,NEXT);
});

test('one ingestion belongs to at most one live list, including its future books',async t=>{
  const f=await fixture(t);
  const first=await f.start([{ingestion_id:ING1},{ingestion_id:ING2}]);
  await assert.rejects(f.start([{ingestion_id:ING1},{ingestion_id:ING3}],'another-key'),/active book task/);
  await assert.rejects(f.start([{ingestion_id:ING2}],'other-future-key'),/active book task/);
  await assert.rejects(f.start([{ingestion_id:ING1},{ingestion_id:ING3}],'books-1'),/Idempotency/);
  await assert.rejects(f.start([{telegram_original:'t.me/only'}],'locator-only'),
    /canonical ingestion_id/,'RKB endpoint cannot resolve locator-only');
  await assert.rejects(f.start([{ingestion_id:ING1},{ingestion_id:ING1}],'duplicate'),/Duplicate ingestion_id/);
  await assert.rejects(f.q.enqueue({action:'start',prompt:'Import without report destination',
    book:{books:[{ingestion_id:ING3}],continuation_prompt:CONTINUE}}),/requires slack_thread_url/);
  assert.equal(f.q.activeBooks().length,1);
  assert.equal(f.q.activeBooks()[0].book_task_id,first.job_id);
});


test('two concurrent book tasks on distinct ingestions remain independent',async t=>{
  const f=await fixture(t);
  const first=await f.start([{ingestion_id:ING1}],'pilot-window-one');
  const second=await f.start([{ingestion_id:ING2}],'pilot-window-two');
  assert.equal(f.q.activeBooks().length,2);
  await f.deliver(first,CHAT);
  await f.deliver(second,NEXT);
  await f.activity(first,'finalized');
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.state,'done');
  assert.equal(f.q.status(second.job_id).book_task.state,'active');
  assert.deepEqual(f.q.activeBooks(),[{book_task_id:second.job_id,ingestion_id:ING2}]);
});

test('RKB failed/blocker stops list; processing/wait never means stale',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  f.advance(22*60_000);
  await f.activity(first,'processing',new Date(f.now()-22*60_000).toISOString());
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'RKB processing creates no short browser tasks');
  await f.activity(first,'failed');
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.state,'blocked');
  assert.equal(f.q.pendingBookNotices()[0].kind,'terminal');
});

test('loopback RKB GET sends dedicated principal, credential UUID and epoch; exact contract',async t=>{
  const received=[];
  const remote=createServer((req,res)=>{
    received.push({url:req.url,method:req.method,headers:req.headers});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({state:'staged',next_action:'continue_pages',
      last_operation_at:'2026-10-30T06:00:00Z',accepted_pages:14,next_cursor:'40'}));
  });
  await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>remote.close(resolve)));
  const keys=['LAUNCHER_RKB_ACTIVITY_URL','LAUNCHER_RKB_ACTIVITY_TOKEN',
    'LAUNCHER_RKB_SERVICE_CREDENTIAL_ID','LAUNCHER_RKB_SERVICE_CREDENTIAL_EPOCH'];
  const previous=keys.map(k=>process.env[k]);
  t.after(()=>keys.forEach((k,i)=>previous[i]===undefined?delete process.env[k]:process.env[k]=previous[i]));
  process.env.LAUNCHER_RKB_ACTIVITY_URL='http://127.0.0.1:'+remote.address().port+'/internal/import/activity';
  process.env.LAUNCHER_RKB_ACTIVITY_TOKEN='read-only-service-token'.repeat(2);
  process.env.LAUNCHER_RKB_SERVICE_CREDENTIAL_ID=ING1;
  process.env.LAUNCHER_RKB_SERVICE_CREDENTIAL_EPOCH='1';
  const reader=bookActivityReaderFromEnv();
  const data=await reader(ING2);
  assert.equal(data.next_action,'continue_pages');
  assert.equal(received.length,1);
  assert.equal(received[0].url,'/internal/import/activity?ingestion_id='+ING2);
  assert.equal(received[0].method,'GET');
  assert.equal(received[0].headers['x-rkb-service'],'launcher-import-watch');
  assert.equal(received[0].headers['x-rkb-service-credential'],ING1);
  assert.equal(received[0].headers['x-rkb-service-epoch'],'1');
  assert.equal(received[0].headers.authorization,'Bearer '+process.env.LAUNCHER_RKB_ACTIVITY_TOKEN);
  process.env.LAUNCHER_RKB_ACTIVITY_URL='http://public.example/internal/import/activity';
  assert.throws(()=>bookActivityReaderFromEnv(),/loopback/);
});

test('existing relay timer invokes injected RKB test double only for active ingestion',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launcher-poll-double-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[];
  const {queue,server}=await makeRelay({
    file:join(dir,'state.json'),mcpToken:'mcp-'.repeat(9),devices:{desktop:DEVICE},
    tickMs:15,deliveryMs:100_000,bookNotifier:null,
    bookActivityReader:async ingestion_id=>{
      calls.push(ingestion_id);
      return {state:'staged',next_action:'continue_pages',
        last_operation_at:new Date().toISOString(),accepted_pages:2,next_cursor:'5'};
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const first=await queue.enqueue({action:'start',prompt:'Import',request_id:'poll-double',
    slack_thread_url:THREAD,book:{books:[{ingestion_id:ING1}],continuation_prompt:CONTINUE}});
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.deepEqual(calls,[ING1],'only one activity poll in initial five-minute interval');
  assert.equal(queue.status(first.job_id).book_task.activity_state,'staged');
});


test('explicit client safety rejection stops only this book after queued continuation; stale RKB cannot restart it',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  const oldOperation=new Date(f.now()-21*60_000).toISOString();
  await f.activity(first,'staged',oldOperation); // RKB never received rejected stage.
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  await f.q.modelReport({job_id:first.job_id,status:'done'});
  await f.q.tick();
  const queuedId=f.q.status(first.job_id).book_task.current_job_id;
  assert.equal(f.q.status(queuedId).status,'queued','finished turn queued continuation before late refusal');

  const other=await f.start([{ingestion_id:ING2}],'unrelated-book');
  const refusal='Script error: Этот вызов инструмента был заблокирован системами безопасности OpenAI. Внимательно проверьте отправляемые данные.';
  const report={job_id:first.job_id,status:'blocked',failure_kind:'client_safety_rejection',summary:refusal};
  await f.q.modelReport(report);
  await f.q.modelReport(report); // Duplicate callback must not create a second notice.
  assert.equal(f.q.status(first.job_id).book_task.state,'blocked');
  assert.equal(f.q.status(first.job_id).book_task.terminal_summary,'OpenAI client safety rejection: '+refusal);
  assert.equal(f.q.status(queuedId).status,'expired','queued successor was never sent');
  assert.equal(f.q.pendingBookNotices().length,1);
  assert.equal(f.q.pendingBookNotices()[0].kind,'terminal');

  await f.deliver(other,NEXT);
  await f.activity(other);
  await f.q.modelReport({job_id:other.job_id,status:'done',summary:'Normal turn completion'});
  await f.q.tick();
  const otherNext=await f.q.claim('desktop');
  assert.equal(otherNext.action,'continue','unrelated book keeps reading');
  assert.equal(otherNext.book_task_id,other.job_id);
  await f.q.report('desktop',{job_id:otherNext.id,status:'sent',chat_url:NEXT});
  const initialJobs=JSON.parse(await readFile(f.file,'utf8')).jobs
    .filter(j=>j.book_task_id===first.job_id&&['start','continue'].includes(j.action)).length;

  f.advance(25*60_000);
  await f.activity(first,'staged',oldOperation);
  await Promise.all([f.q.tick(),f.q.tick(),f.q.tick()]);
  const reloaded=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
  await reloaded.initialize();
  await reloaded.tick();
  const laterJobs=JSON.parse(await readFile(f.file,'utf8')).jobs
    .filter(j=>j.book_task_id===first.job_id&&['start','continue'].includes(j.action));
  assert.equal(laterJobs.length,initialJobs,'no new sends, rollover or retry after stale RKB and restart');
  assert.ok(!laterJobs.some(j=>j.status==='queued'||j.status==='claimed'));
  assert.deepEqual(reloaded.activeBooks(),[{book_task_id:other.job_id,ingestion_id:ING2}]);
  assert.equal(reloaded.pendingBookNotices().length,1);
  await reloaded.bookNoticeSent(first.job_id,first.job_id);
  assert.equal(reloaded.pendingBookNotices().length,0,'exactly one terminal notice');
  await reloaded.tick();
  assert.equal(reloaded.pendingBookNotices().length,0);
});

test('generic model blocked/done are only turn outcomes; narrow failure_kind is validated',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  await f.activity(first);
  await assert.rejects(f.q.modelReport({job_id:first.job_id,status:'done',
    failure_kind:'client_safety_rejection',summary:'false'}),/failure_kind requires blocked/);
  await assert.rejects(f.q.modelReport({job_id:first.job_id,status:'blocked',
    failure_kind:'client_safety_rejection',summary:'  '}),/failure_kind requires blocked/);
  await f.q.modelReport({job_id:first.job_id,status:'blocked',summary:'Ordinary model blocker'});
  assert.equal(f.q.status(first.job_id).book_task.state,'active');
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  await f.q.modelReport({job_id:first.job_id,status:'done',summary:'Finished turn'});
  await f.q.tick();
  const continued=await f.q.claim('desktop');
  assert.equal(continued.action,'continue','generic done remains a turn completion');
  assert.equal(f.q.status(first.job_id).book_task.state,'active');
  assert.equal(f.q.pendingBookNotices().length,0);
});

test('late client safety report from prior book cannot stop already advanced ingestion',async t=>{
  const f=await fixture(t);
  const first=await f.start([{ingestion_id:ING1},{ingestion_id:ING2}]);
  await f.deliver(first);
  await f.activity(first,'finalized');
  await f.q.tick();
  const current=f.q.status(first.job_id).book_task.current_job_id;
  assert.equal(f.q.status(first.job_id).book_task.current_book_index,1);
  assert.equal(f.q.status(current).status,'queued');
  await f.q.modelReport({job_id:first.job_id,status:'blocked',
    failure_kind:'client_safety_rejection',summary:'Old page rejected before the prior book finalized'});
  assert.equal(f.q.status(first.job_id).book_task.state,'active');
  assert.equal(f.q.status(current).status,'queued','current book start must not be cancelled');
  assert.equal(f.q.pendingBookNotices().length,0);
  const newBook=await f.q.claim('desktop');
  assert.equal(newBook.id,current);
  assert.equal(newBook.action,'start');
  assert.equal(newBook.book_index,1);
});
