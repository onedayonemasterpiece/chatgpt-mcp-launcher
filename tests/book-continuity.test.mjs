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


// Owner decision 03.11: one client refusal gets one honest retry in a new chat, silently.
async function refusedOnce(f,taskId,jobId) {
  await f.q.modelReport({job_id:jobId,status:'blocked',failure_kind:'client_safety_rejection',summary:'First refusal'});
  await f.q.tick();
  assert.equal(f.q.status(taskId).book_task.state,'active','a single refusal does not end the book');
  assert.equal(f.q.pendingBookNotices().length,0,'a single refusal is not reported');
  f.advance(19*60_000);
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'retry waits 20 minutes');
  f.advance(60_000);
  await f.q.tick();
  const retry=await f.q.claim('desktop');
  assert.equal(retry?.action,'start','retry runs in a NEW chat');
  assert.equal(retry.chat_url,null);
  assert.match(retry.own_text,new RegExp(f.q.status(taskId).book_task.ingestion_id));
  await f.q.report('desktop',{job_id:retry.id,status:'sent',chat_url:THIRD});
  return retry;
}

test('status-only activity is not import progress; accepted pages resume a completed reader',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  await f.activity(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  f.advance(60_000);
  await f.activity(first); // status ran, but the original page was unavailable: still 14 accepted.
  await f.q.modelReport({job_id:first.job_id,status:'done',summary:'Page unavailable, no new pages accepted'});
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'a status timestamp must not immediately repeat the failed read');
  const restored=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
  await restored.initialize();
  await restored.tick();
  assert.equal(await restored.claim('desktop'),null,'restart preserves the same progress baseline');
  f.advance(60_000);
  await restored.bookActivity({book_task_id:first.job_id,state:'staged',next_action:'continue_pages',
    last_operation_at:new Date(f.now()).toISOString(),accepted_pages:15,next_cursor:'41'});
  await restored.tick();
  const next=await restored.claim('desktop');
  assert.equal(next?.action,'continue','a newly accepted page permits ordinary immediate continuation');
  assert.equal(next.chat_url,CHAT);
});

test('book title survives queue persistence and appears first in reader prompt and Slack notice; untitled stays unchanged',async t=>{
  const f=await fixture(t);
  const title='Кёнигсбергский зоопарк';
  const first=await f.start([{ingestion_id:ING1,title}],'titled-book');
  const claimed=await f.deliver(first);
  assert.ok(claimed.own_text.startsWith(`(Книга 1 из 1: «${title}», ingestion_id=${ING1}`));
  assert.equal(JSON.parse(await readFile(f.file,'utf8')).book_tasks[0].books[0].title,title);
  await f.activity(first,'failed');await f.q.tick();
  const reloaded=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
  await reloaded.initialize();
  const notice=reloaded.pendingBookNotices()[0];
  assert.equal(notice.title,title);
  assert.ok(bookNoticeText(notice).includes(`book=«${title}» 1/1; ingestion_id=${ING1}`));
  await assert.rejects(f.start([{ingestion_id:ING3,title:'x'.repeat(301)}],'too-long-title'),/book.books\[\].title/);

  const legacy=await fixture(t);
  const old=await legacy.start([{ingestion_id:ING2}],'untitled-book');
  assert.ok((await legacy.deliver(old)).own_text.startsWith(`(Книга 1 из 1: ingestion_id=${ING2}`));
  await legacy.activity(old,'failed');await legacy.q.tick();
  assert.ok(bookNoticeText(legacy.q.pendingBookNotices()[0]).includes(`; ingestion_id=${ING2}; book=1/1;`));
});

test('30-minute active reading creates no browser probes or short tasks; real turn completion continues same chat',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  const initial=await f.deliver(first);
  assert.match(initial.own_text,new RegExp(ING1),'first window receives its book selector');
  assert.doesNotMatch(initial.prompt,/после пяти wait подряд/,'warming must not end a reader before READY');
  await f.activity(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  for(let minute=0;minute<30;minute++) {
    f.advance(60_000);
    await f.activity(first);
    await f.q.tick();
    assert.equal(await f.q.claim('desktop'),null,'ongoing RKB reading needs no browser inspection or continuation');
  }
  await f.activity(first,'staged',new Date(f.now()).toISOString(),15);
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
  assert.doesNotMatch(replacement.own_text,/Используй предыдущий чат как контекст/);
  assert.doesNotMatch(replacement.own_text,/Продолжение работы из чата|Исходный prompt предыдущего чата/);
  assert.ok(!replacement.own_text.includes(CHAT),'the book driver owns handoff; reader must not inspect the predecessor');
  assert.ok(!replacement.own_text.includes(CONTINUE),'caller text is not forwarded; MCP instructions rule the import');
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
    await f.activity(first,'staged',new Date(f.now()).toISOString(),13);
  f.advance(1);
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
  // An earlier book of the list failed; the warning is about the current one.
  const saved=JSON.parse(await readFile(f.file,'utf8'));
  saved.book_tasks[0].terminal_summary='\nold-book: failure_kind=client_safety_rejection';
  const view=new FileQueue(f.file+'.view',{desktop:DEVICE},{now:f.now});
  await writeFile(f.file+'.view',JSON.stringify(saved));await view.initialize();
  assert.equal(view.pendingBookNotices()[0].terminal_summary,null,'an earlier book outcome is not repeated in a current-book warning');
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
  assert.equal(f.q.status(first.job_id).book_task.no_progress_new_chats,2,
    'status-only activity preserves the no-progress warning');
  await f.activity(first,'staged',new Date(f.now()).toISOString(),15);
  assert.equal(f.q.status(first.job_id).book_task.no_progress_new_chats,0,
    'newly accepted page resets the no-progress streak');
});

test('retry of an unsent silent-book handoff keeps book ownership and automatic continuation',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  const oldOp=new Date(f.now()).toISOString();
  f.advance(21*60_000);
  await f.activity(first,'staged',oldOp);
  await f.q.tick();
  const handoff=await f.q.claim('desktop');
  assert.equal(handoff.action,'start');
  assert.equal(handoff.handoff_reason,'book_silent');
  await f.q.report('desktop',{job_id:handoff.id,status:'blocked',
    message:'ChatGPT composer unavailable after 90 seconds'});
  const retry=await f.q.retry(handoff.id,'book-handoff-retry');
  assert.equal(retry.book_task_id,first.job_id);
  assert.equal(retry.book_task.current_job_id,retry.job_id);
  assert.equal((await f.q.retry(handoff.id,'book-handoff-retry')).job_id,retry.job_id);
  const delivered=await f.q.claim('desktop');
  assert.equal(delivered.id,retry.job_id);
  assert.equal(delivered.action,'start');
  assert.match(delivered.own_text,new RegExp(ING1));
  await f.q.report('desktop',{job_id:delivered.id,status:'sent',chat_url:NEXT});
  await f.q.modelReport({job_id:delivered.id,status:'done',summary:'Real reader turn complete'});
  await f.activity(first,'staged',new Date(f.now()).toISOString(),15);
  await f.q.tick();
  const next=await f.q.claim('desktop');
  assert.equal(next.action,'continue');
  assert.equal(next.chat_url,NEXT);
  assert.equal(next.book_task_id,first.job_id);
  await assert.rejects(f.q.retry(handoff.id,'different-obsolete-retry'),/current book turn/);
});

test('book progress keeps its chat after 90 minutes; empty turns wait for existing silence recovery',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  await f.activity(first,'staged',new Date(f.now()).toISOString(),13);
  f.advance(100*60_000);
  await f.activity(first);
  await f.q.modelReport({job_id:first.job_id,status:'done'});
  await f.q.tick();
  let next=await f.q.claim('desktop');
  for(let turn=0;turn<7;turn++) {
    assert.equal(next.action,'continue');
    assert.equal(next.chat_url,CHAT);
    await f.q.report('desktop',{job_id:next.id,status:'sent',chat_url:CHAT});
    f.advance(1);
    await f.activity(first,'staged',new Date(f.now()).toISOString(),15+turn);
    await f.q.modelReport({job_id:next.id,status:'done'});
    await f.q.tick();
    next=await f.q.claim('desktop');
  }
  assert.equal(next.action,'continue');
  assert.equal(next.chat_url,CHAT);
  await f.q.report('desktop',{job_id:next.id,status:'sent',chat_url:CHAT});
  const lastOperation=new Date(f.now()).toISOString();
  f.advance(2*60_000);
  await f.activity(first,'staged',lastOperation,21); // Fresh status, no new operation.
  await f.q.modelReport({job_id:next.id,status:'done'});
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'no immediate empty continuation loop');
  f.advance(19*60_000);
  await f.activity(first,'staged',lastOperation,21);
  await f.q.tick();
  const replacement=await f.q.claim('desktop');
  assert.equal(replacement.action,'start');
  assert.equal(replacement.handoff_reason,'book_silent');
  assert.equal(replacement.previous_chat_url,CHAT);
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

test('RKB failed/blocker completes a one-book list with error; processing/wait never means stale',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
  f.advance(22*60_000);
  await f.activity(first,'processing',new Date(f.now()-22*60_000).toISOString());
  await f.q.tick();
  assert.equal(await f.q.claim('desktop'),null,'RKB processing creates no short browser tasks');
  await f.activity(first,'failed');
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.state,'failed');
  assert.equal(f.q.pendingBookNotices()[0].kind,'book_failure');
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

test('a completed book report refreshes stale activity before another continuation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launcher-terminal-activity-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let now=Date.now(),finalized=false,calls=0;
  const mcpToken='mcp-'.repeat(9);
  const {queue,server}=await makeRelay({file:join(dir,'state.json'),mcpToken,
    devices:{desktop:DEVICE},queueOptions:{now:()=>now},tickMs:15,deliveryMs:100_000,
    bookNotifier:null,bookActivityReader:async()=>{
      calls++;
      return {state:finalized?'finalized':'staged',next_action:finalized?'done':'continue_pages',
        last_operation_at:new Date(now).toISOString(),accepted_pages:475,next_cursor:finalized?null:'478'};
    }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const first=await queue.enqueue({action:'start',prompt:'Import',request_id:'terminal-activity',
    slack_thread_url:THREAD,book:{books:[{ingestion_id:ING1}],continuation_prompt:CONTINUE}});
  const claimed=await queue.claim('desktop');
  await queue.report('desktop',{job_id:claimed.id,status:'sent',chat_url:CHAT});
  for(let i=0;i<100&&!calls;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls,1);
  now+=1000;finalized=true;
  // The timer may already be using its cached snapshot when the report arrives.
  await queue.modelReport({job_id:first.job_id,status:'done'});
  await queue.tick();
  assert.equal(queue.status(first.job_id).book_task.current_job_id,first.job_id,
    'a snapshot preceding the terminal report cannot authorize continuation');
  const response=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{
    method:'POST',headers:{Authorization:'Bearer '+mcpToken,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'chatgpt_report',arguments:{job_id:first.job_id,status:'done'}}})});
  assert.equal(response.status,200);await response.json();
  for(let i=0;i<100&&queue.status(first.job_id).book_task.state!=='done';i++)
    await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls,2,'existing timer refreshes without waiting five minutes');
  assert.equal(queue.status(first.job_id).book_task.state,'done');
  let retired;
  for(let i=0;i<100&&!retired;i++) {
    retired=await queue.claim('desktop');
    if(!retired)await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(retired?.action,'close','completed reader tab is retired');
});


test('cached-schema repeated safety refusal stops a sent successor, including after restart with a stored blocked report',async t=>{
  for(const persisted of [false,true]) {
    const f=await fixture(t);
    const first=await f.start();
    await f.deliver(first);
    await f.activity(first,'staged',new Date(f.now()).toISOString(),13);
    const reader=await refusedOnce(f,first.job_id,first.job_id);
    f.advance(1);
    await f.activity(first);
    await f.q.modelReport({job_id:reader.id,status:'done'});
    await f.q.tick();
    const successorId=f.q.status(first.job_id).book_task.current_job_id;
    const sent=await f.deliver({job_id:successorId});
    await f.q.modelReport({job_id:sent.id,status:'started'});
    const refusal='failure_kind=client_safety_rejection. Script error: OpenAI client blocked book_ingest(status).';
    let q=f.q;
    if(persisted) {
      // A pre-fix relay stored the cached-schema report but left its book active.
      const state=JSON.parse(await readFile(f.file,'utf8'));
      const source=state.jobs.find(j=>j.id===reader.id);
      source.model_status='blocked';source.model_summary=refusal;
      await writeFile(f.file,JSON.stringify(state));
      q=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
      await q.initialize();
      await q.tick();
    } else {
      await q.modelReport({job_id:reader.id,status:'blocked',summary:refusal});
    }
    await q.tick();
    assert.equal(q.status(first.job_id).book_task.state,'failed',persisted?'stored report':'cached schema');
    assert.match(q.status(first.job_id).book_task.terminal_summary,/client_safety_rejection/);
    const stop=await q.claim('desktop');
    assert.equal(stop?.action,'book_stop','sent successor needs the existing exact Stop');
    assert.equal(stop.after_job_id,sent.id);
    assert.equal(stop.chat_url,THIRD);
    await q.report('desktop',{job_id:stop.id,status:'stopped',chat_url:THIRD});
    const prior=JSON.parse(await readFile(f.file,'utf8')).jobs
      .filter(j=>j.book_task_id===first.job_id&&['start','continue'].includes(j.action)).length;
    f.advance(25*60_000);
    await q.tick();
    const reloaded=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});
    await reloaded.initialize();
    await reloaded.tick();
    const later=JSON.parse(await readFile(f.file,'utf8')).jobs
      .filter(j=>j.book_task_id===first.job_id&&['start','continue'].includes(j.action));
    assert.equal(later.length,prior,'no future book sends after reload');
    assert.equal(await reloaded.claim('desktop'),null);
    assert.equal(reloaded.pendingBookNotices().length,2,'one book error and one list completion notice');
  }
});

test('repeated explicit client safety rejection stops only this book after queued continuation; stale RKB cannot restart it',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
    await f.activity(first,'staged',new Date(f.now()).toISOString(),13);
  const reader=await refusedOnce(f,first.job_id,first.job_id);
  f.advance(1);
  const oldOperation=new Date(f.now()).toISOString();
  await f.activity(first,'staged',oldOperation); // A prior read arrived; the rejected stage did not.
  await f.q.modelReport({job_id:reader.id,status:'started'});
  await f.q.modelReport({job_id:reader.id,status:'done'});
  await f.q.tick();
  const queuedId=f.q.status(first.job_id).book_task.current_job_id;
  assert.equal(f.q.status(queuedId).status,'queued','finished turn queued continuation before late refusal');

  const other=await f.start([{ingestion_id:ING2}],'unrelated-book');
  const refusal='Script error: Этот вызов инструмента был заблокирован системами безопасности OpenAI. Внимательно проверьте отправляемые данные.';
  const report={job_id:reader.id,status:'blocked',failure_kind:'client_safety_rejection',summary:refusal};
  await f.q.modelReport(report);
  await f.q.modelReport(report); // Duplicate callback must not create a second notice.
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.state,'failed');
  assert.ok(f.q.status(first.job_id).book_task.terminal_summary.endsWith(refusal));
  assert.equal(f.q.status(queuedId).status,'expired','queued successor was never sent');
  assert.equal(f.q.pendingBookNotices().length,2);
  assert.equal(f.q.pendingBookNotices()[0].kind,'book_failure');

  await f.deliver(other,NEXT);
  await f.activity(other,'staged',new Date(f.now()).toISOString(),13);
  f.advance(1);
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
  assert.equal(reloaded.pendingBookNotices().length,2);
  for(const notice of reloaded.pendingBookNotices())await reloaded.bookNoticeSent(first.job_id,notice.notice_id);
  assert.equal(reloaded.pendingBookNotices().length,0,'exactly one terminal notice');
  await reloaded.tick();
  assert.equal(reloaded.pendingBookNotices().length,0);
});

test('generic model blocked/done are only turn outcomes; narrow failure_kind is validated',async t=>{
  const f=await fixture(t);
  const first=await f.start();
  await f.deliver(first);
    await f.activity(first,'staged',new Date(f.now()).toISOString(),13);
  f.advance(1);
  await f.activity(first);
  await assert.rejects(f.q.modelReport({job_id:first.job_id,status:'done',
    failure_kind:'client_safety_rejection',summary:'false'}),/failure_kind requires blocked/);
  await assert.rejects(f.q.modelReport({job_id:first.job_id,status:'blocked',
    failure_kind:'client_safety_rejection',summary:'  '}),/failure_kind requires blocked/);
  await f.q.modelReport({job_id:first.job_id,status:'blocked',summary:'Ordinary error: source text mentions safety and failure_kind=client_safety_rejection. No client refusal'});
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

test('3h expires queued books, DEV runs, restart preserves rest and resumes each ingestion once',async t=>{
  const f=await fixture(t,{random:()=>0.5}); // exactly 63 minutes
  const ing4='12345678-aaaa-bbbb-cccc-dddddddddddd';
  const ing5='87654321-aaaa-bbbb-cccc-dddddddddddd';
  const worker=await f.start([{ingestion_id:ING1},{ingestion_id:ING2}],'rest-worker');
  const reader=await f.start([{ingestion_id:ING3}],'rest-reader');
  await f.deliver(worker,CHAT);
  await f.deliver(reader,NEXT);
  await f.activity(worker,'staged',new Date(f.now()).toISOString(),13);
  await f.activity(reader,'staged',new Date(f.now()).toISOString(),13);
  await f.q.modelReport({job_id:worker.job_id,status:'started'});
  await f.q.modelReport({job_id:reader.job_id,status:'done'});
  f.advance(3*60*60_000-60_000);
  const lastOperation=new Date(f.now()).toISOString();
  await f.activity(worker,'staged',lastOperation);
  await f.activity(reader,'staged',lastOperation);
  await f.q.tick();
  const queuedSuccessor=f.q.status(reader.job_id).book_task.current_job_id;
  assert.notEqual(queuedSuccessor,reader.job_id);
  assert.equal(f.q.status(queuedSuccessor).status,'queued');
  const queuedStart=await f.start([{ingestion_id:ing4}],'first-start-before-rest');
  f.advance(60_000);
  await f.activity(worker,'finalized',new Date(f.now()).toISOString());
  assert.equal(f.q.status(queuedSuccessor).status,'expired',
    'status inspection at the boundary must process book rest before generic expiry');
  await f.q.tick();
  for(const id of [queuedSuccessor,queuedStart.job_id]) {
    assert.equal(f.q.status(id).status,'expired','book prompts expired exactly at 3h');
    assert.match(f.q.status(id).message,/Book rest/);
  }
  assert.equal(f.q.status(worker.job_id).book_task.current_book_index,0,
    'finalized-to-nextbook must not enqueue during drain');
  assert.equal(f.q.status(worker.job_id).book_task.rest_until,null,
    'the active first book has not completed its turn');
  assert.equal(await f.q.claim('desktop'),null);
  await assert.rejects(f.start([{ingestion_id:ing5}],'new-during-drain'),/Book import rest until/);
  const dev=await f.q.enqueue({action:'start',prompt:'Normal DEV work',request_id:'dev-during-book-rest'});
  assert.equal((await f.q.claim('desktop')).id,dev.job_id,'DEV bypasses book-only pause');

  f.advance(20*60_000);
  await f.q.modelReport({job_id:worker.job_id,status:'done'});
  await f.q.tick();
  const resumeAt=new Date(f.now()+63*60_000).toISOString();
  assert.equal(f.q.status(worker.job_id).book_task.rest_until,resumeAt,
    'all 63 rest minutes begin after the last save');
  assert.equal(f.q.status(worker.job_id).book_task.current_book_index,0);
  f.advance(30*60_000);
  const restored=new FileQueue(f.file,{desktop:DEVICE},{now:f.now,random:()=>0});
  await restored.initialize();
  await restored.tick();
  assert.equal(restored.status(reader.job_id).book_task.rest_until,resumeAt,
    'restart does not resample or shorten the pause');
  assert.equal(await restored.claim('desktop'),null);
  await assert.rejects(restored.enqueue({action:'start',prompt:'Another book',request_id:'during-rest',
    slack_thread_url:THREAD,book:{books:[{ingestion_id:ing5}],continuation_prompt:CONTINUE}}),
    /Book import rest until/);

  f.advance(33*60_000);
  await restored.bookActivity({book_task_id:reader.job_id,state:'staged',next_action:'continue_pages',
    last_operation_at:lastOperation,accepted_pages:15,next_cursor:'42'});
  await restored.tick();
  await restored.tick();
  assert.equal(restored.status(worker.job_id).book_task.current_book_index,1,
    'next book starts only after full rest');
  const all=JSON.parse(await readFile(f.file,'utf8')).jobs;
  for(const [root,ingestion] of [[worker,ING2],[reader,ING3],[queuedStart,ing4]]) {
    const queued=all.filter(j=>j.book_task_id===root.job_id&&
      ['start','continue'].includes(j.action)&&j.status==='queued');
    assert.equal(queued.length,1,'one successor per ingestion, not a retry loop');
    assert.match(queued[0].prompt,new RegExp(ingestion));
    assert.match(queued[0].prompt,/book_ingest/);
  }
  const sends=[];
  for(let i=0;i<3;i++)sends.push(await restored.claim('desktop'));
  assert.equal(sends.filter(j=>j.book_task_id===reader.job_id).length,1,
    'exactly one ordinary replacement of the same ING3');
  assert.equal(sends.filter(j=>j.book_task_id===queuedStart.job_id).length,1,
    'an expired first bookstart also resumes automatically');
  assert.equal(await restored.claim('desktop'),null);
});

test('book rest chooses the inclusive 35–90 minute range',async t=>{
  for(const [index,random,minutes] of [[0,()=>0,35],[1,()=>0.999999,90]]) {
    const f=await fixture(t,{random});
    const first=await f.start([{ingestion_id:ING1}],'bounds-'+index);
    await f.deliver(first);
    await f.q.modelReport({job_id:first.job_id,status:'done'});
    f.advance(3*60*60_000);
    await f.q.tick();
    assert.equal(f.q.status(first.job_id).book_task.rest_until,
      new Date(f.now()+minutes*60_000).toISOString());
  }
});

test('a model working 20 minutes past 3h completes before the full 35-minute rest',async t=>{
  const f=await fixture(t,{random:()=>0});
  const first=await f.start([{ingestion_id:ING1}],'late-reader');
  await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  f.advance(3*60*60_000);
  await f.activity(first,'staged',new Date(f.now()).toISOString());
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.rest_until,null);
  await assert.rejects(f.start([{ingestion_id:ING2}],'during-drain'),/Book import rest until/);
  f.advance(20*60_000);
  await f.activity(first,'staged',new Date(f.now()).toISOString());
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.rest_until,null);
  await f.q.modelReport({job_id:first.job_id,status:'done'});
  await f.q.tick();
  const resumeAt=new Date(f.now()+35*60_000).toISOString();
  assert.equal(f.q.status(first.job_id).book_task.rest_until,resumeAt);
  f.advance(10*60_000);
  const restarted=new FileQueue(f.file,{desktop:DEVICE},{now:f.now,random:()=>0.99999});
  await restarted.initialize();
  await restarted.tick();
  assert.equal(restarted.status(first.job_id).book_task.rest_until,resumeAt);
});

test('processing/wait stays active after deadline; staged plus real 20m RKB silence permits full rest',async t=>{
  const f=await fixture(t,{random:()=>0});
  const first=await f.start([{ingestion_id:ING1}],'processing-reader');
  await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  const originalOperation=new Date(f.now()).toISOString();
  await f.activity(first,'processing',originalOperation);
  f.advance(3*60*60_000+21*60_000);
  await f.activity(first,'processing',originalOperation);
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.rest_until,null,
    'processing/wait must not be treated as a dead window');
  assert.equal(await f.q.claim('desktop'),null,'deadline already prevents new book work');
  await f.activity(first,'staged',originalOperation);
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.rest_until,
    new Date(f.now()+35*60_000).toISOString(),'RKB settled and silent starts rest without browser Stop');
});


test('silent registered reader is replaced without browser Stop or manual reconciliation',async t=>{
  const f=await fixture(t);
  const first=await f.start();await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  await f.activity(first);f.advance(20*60_000);
  await f.activity(first,'staged',new Date(f.now()-20*60_000).toISOString());
  await f.q.tick();
  const next=await f.q.claim('desktop');
  assert.equal(next?.action,'start');
  assert.equal(next.book_task_id,first.job_id);
  assert.equal(next.book_index,0);
  assert.equal(await f.q.claim('desktop'),null);
  const saved=JSON.parse(await readFile(f.file,'utf8'));
  assert.equal(saved.jobs.some(j=>j.action==='book_stop'||j.action==='reconcile'||j.action==='read'),false);
});

test('rest starts from RKB silence without Stop and resumes automatically after restart',async t=>{
  const f=await fixture(t,{random:()=>0});
  const first=await f.start();await f.deliver(first);
  await f.q.modelReport({job_id:first.job_id,status:'started'});
  await f.activity(first);f.advance(3*60*60_000);
  await f.activity(first,'staged',new Date(f.now()-20*60_000).toISOString());
  await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.rest_until,new Date(f.now()+35*60_000).toISOString());
  assert.equal(await f.q.claim('desktop'),null);
  const restored=new FileQueue(f.file,{desktop:DEVICE},{now:f.now,random:()=>0});await restored.initialize();
  f.advance(35*60_000);await restored.bookActivity({book_task_id:first.job_id,state:'staged',next_action:'continue_pages',last_operation_at:new Date(f.now()-55*60_000).toISOString(),accepted_pages:14,next_cursor:'40'});
  await restored.tick();const next=await restored.claim('desktop');
  assert.equal(next?.action,'start');assert.equal(next.book_task_id,first.job_id);
});


test('recent activity and pending RKB save never create a replacement or browser probe',async t=>{
  for(const [state,age] of [['staged',19],['processing',25]]) {
    const f=await fixture(t);const first=await f.start();await f.deliver(first);
    await f.q.modelReport({job_id:first.job_id,status:'started'});
    const operation=new Date(f.now()).toISOString();f.advance(age*60_000);
    await f.activity(first,state,operation);await f.q.tick();
    assert.equal(await f.q.claim('desktop'),null);
  }
});


test('a rejected book reports once and advances independent books without operator state',async t=>{
  for(const safety of [false,true]) {
    const f=await fixture(t);const first=await f.start([{ingestion_id:ING1},{ingestion_id:ING2}]);await f.deliver(first);
    await f.activity(first);
    if(safety) {
      const retry=await refusedOnce(f,first.job_id,first.job_id);
      await f.q.modelReport({job_id:retry.id,status:'blocked',failure_kind:'client_safety_rejection',summary:'Explicit platform rejection'});
    }
    else await f.activity(first,'failed');
    await f.q.tick();
    assert.equal(f.q.status(first.job_id).book_task.state,'active');
    assert.equal(f.q.status(first.job_id).book_task.current_book_index,1);
    const next=await f.q.claim('desktop');assert.equal(next?.action,'start');assert.equal(next.book_index,1);
    assert.doesNotMatch(next.own_text,new RegExp(ING1));
    const issues=f.q.pendingBookNotices().filter(n=>n.kind==='book_failure');assert.equal(issues.length,1);
    assert.equal(issues[0].ingestion_id,ING1);assert.match(bookNoticeText(issues[0]),/BOOK_FAILURE/);
    await f.q.bookNoticeSent(first.job_id,issues[0].notice_id);
    const restored=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});await restored.initialize();
    assert.equal(restored.pendingBookNotices().filter(n=>n.kind==='book_failure').length,0);
    await restored.report('desktop',{job_id:next.id,status:'sent',chat_url:NEXT});
    await restored.bookActivity({book_task_id:first.job_id,state:'finalized',next_action:'done'});await restored.tick();
    assert.equal(restored.status(first.job_id).book_task.state,'failed','a failed book is never labelled imported');
  }
});


test('legacy blocked book tasks become terminal errors without sending requests',async t=>{
  const f=await fixture(t);const first=await f.start();await f.deliver(first);
  const state=JSON.parse(await readFile(f.file,'utf8'));state.book_tasks[0].state='blocked';
  state.book_tasks[0].terminal_summary='Original failure retained';await writeFile(f.file,JSON.stringify(state));
  const restored=new FileQueue(f.file,{desktop:DEVICE},{now:f.now});await restored.initialize();await restored.tick();
  assert.equal(restored.status(first.job_id).book_task.state,'failed');
  assert.equal(restored.status(first.job_id).book_task.terminal_summary,'Original failure retained');
  assert.equal(await restored.claim('desktop'),null);
});


test('an undelivered initial reader with zero RKB operations recovers without an operator',async t=>{
  for(const uncertain of [false,true]) {
    const f=await fixture(t);const first=await f.start();
    if(uncertain){const claimed=await f.q.claim('desktop');await f.q.report('desktop',{job_id:claimed.id,status:'needs_review',message:'Browser delivery outcome unavailable'});}
    f.advance(21*60_000);
    await f.q.bookActivity({book_task_id:first.job_id,state:'staged',next_action:'continue_pages',last_operation_at:null,accepted_pages:0,next_cursor:'0'});
    await f.q.tick();const next=await f.q.claim('desktop');
    assert.equal(next?.action,'start');assert.notEqual(next.id,first.job_id);
    assert.equal(next.book_task_id,first.job_id);assert.match(next.own_text,new RegExp(ING1));
    await f.q.tick();assert.equal(await f.q.claim('desktop'),null);
  }
});

test('finalized book does not let an unconfirmed predecessor block device rest',async t=>{
  const f=await fixture(t,{random:()=>0});
  const first=await f.start([{ingestion_id:ING1},{ingestion_id:ING2}],'rest-finalized-predecessor');
  await f.deliver(first);await f.q.modelReport({job_id:first.job_id,status:'started'});
  const old=new Date(f.now()).toISOString();f.advance(21*60_000);
  await f.activity(first,'staged',old);await f.q.tick();
  const successor=await f.q.claim('desktop');
  await f.q.report('desktop',{job_id:successor.id,status:'sent',chat_url:NEXT});
  await f.q.modelReport({job_id:successor.id,status:'done'});
  f.advance(3*60*60_000);
  await f.activity(first,'finalized');await f.q.tick();
  assert.equal(f.q.status(first.job_id).book_task.rest_until,new Date(f.now()+35*60_000).toISOString());
  assert.equal(await f.q.claim('desktop'),null,'next book respects the full rest');
  f.advance(35*60_000);await f.q.tick();
  const next=await f.q.claim('desktop');assert.equal(next.action,'start');assert.match(next.own_text,new RegExp(ING2));
});

test('a single refusal is retried once; progress after the retry keeps the book without notices',async t=>{
  const f=await fixture(t);
  const first=await f.start([{ingestion_id:ING1},{ingestion_id:ING2}]);
  await f.deliver(first);
  await f.activity(first);
  const retry=await refusedOnce(f,first.job_id,first.job_id);
  await f.q.modelReport({job_id:retry.id,status:'started'});
  f.advance(60_000);
  await f.activity(first,'staged',new Date(f.now()).toISOString(),15);
  await f.q.modelReport({job_id:retry.id,status:'done',summary:'Read on'});
  await f.q.tick();
  const next=await f.q.claim('desktop');
  assert.equal(next?.action,'continue','the retried book continues in its new chat');
  assert.equal(next.chat_url,THIRD);
  assert.equal(next.book_index,0);
  assert.equal(f.q.pendingBookNotices().length,0);
});
