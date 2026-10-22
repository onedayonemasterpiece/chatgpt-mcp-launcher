import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeRelay} from '../relay/server.mjs';
import {FileQueue} from '../relay/queue.mjs';
import {JOB_EVENT,REMINDER_EVENT,sealer,sign,webhookSender} from '../relay/events.mjs';

const TOKEN='m'.repeat(40),DEVICE='d'.repeat(40);
const SECRET='whsec_'+Buffer.alloc(32,7).toString('base64');
const ID='6ad89e0c-b984-83ea-88ba-dd29b57ee40b';
const URL='https://chatgpt.com/c/'+ID;
const MIN=60_000;

async function tempFile(t) {
  const dir=await mkdtemp(join(tmpdir(),'launcher-events-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return join(dir,'queue.json');
}
// A fake clock and a sender that records events instead of using the network.
function harness(file,{statuses=[]}={}) {
  const clock={t:Date.parse('2026-10-22T00:00:00Z')};
  const sent=[];
  const sender={
    verify:async()=>{},
    send:async(url,sub,event)=>{sent.push(event);return {status:statuses.length?statuses.shift():200};},
  };
  const q=new FileQueue(file,{desktop:DEVICE},{now:()=>clock.t,seal:sealer(TOKEN),silenceMs:30*MIN,confirmMs:10*MIN});
  return {q,clock,sent,sender};
}
async function flush(q,sender) {while(await q.deliverDue(sender));}
const subscribeTo=(q,sender,name,url='https://callback.example/hook')=>
  q.subscribe({name,arguments:{},delivery:{mode:'webhook',url,secret:SECRET}},sender);

test('Standard Webhooks signature matches the reference vector',()=>{
  assert.equal(sign('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw','msg_p5jXN8AQM9LWM0D4loKWxJek',1614265330,'{"test": 2432232314}'),
    'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
});

test('2026-07-28 discover/tools/events next to the unchanged 2025-11-25 handshake',async t=>{
  const file=await tempFile(t);
  const {server}=await makeRelay({file,mcpToken:TOKEN,devices:{desktop:DEVICE}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(done=>server.close(done)));
  const base='http://127.0.0.1:'+server.address().port+'/mcp';
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
  const call=async(method,params={})=>(await (await fetch(base,{method:'POST',
    headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json());
  const discover=(await call('server/discover',{_meta:meta})).result;
  assert.deepEqual(discover.supportedVersions,['2026-07-28']);
  assert.deepEqual(discover.capabilities.events,{});
  assert.equal(discover.resultType,'complete');
  assert.equal(discover.cacheScope,'private');
  assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name,'chatgpt-local-chrome-launcher');
  const tools=(await call('tools/list',{_meta:meta})).result;
  assert.equal(tools.resultType,'complete');
  assert.ok(tools.tools.some(x=>x.name==='chatgpt_coordination_set'));
  const events=(await call('events/list',{_meta:meta})).result.events.map(e=>e.name);
  assert.deepEqual(events,[JOB_EVENT,REMINDER_EVENT]);
  const called=(await call('tools/call',{_meta:meta,name:'chatgpt_list_chats',arguments:{}})).result;
  assert.equal(called.resultType,'complete');
  assert.equal(JSON.parse(called.content[0].text).total,0);
  const bad=await call('tools/list',{_meta:{...meta,'io.modelcontextprotocol/protocolVersion':'2099-01-01'}});
  assert.equal(bad.error.code,-32022);
  const legacy=(await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'x',version:'1'}})).result;
  assert.equal(legacy.protocolVersion,'2025-11-25');
  assert.equal(legacy.resultType,undefined,'legacy clients get exactly the old shape');
  const legacyTools=(await call('tools/list')).result;
  assert.equal(legacyTools.resultType,undefined);
});

test('real webhook: verified subscription, signed event when ChatGPT finishes, survives a relay restart',async t=>{
  const file=await tempFile(t);
  const received=[];
  let failNext=0;
  const hook=http.createServer((req,res)=>{
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      const msg=JSON.parse(body);
      const expected=sign(SECRET,req.headers['webhook-id'],req.headers['webhook-timestamp'],body);
      assert.equal(req.headers['webhook-signature'],expected,'signed over the exact body');
      if(msg.type==='verification') {res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({challenge:msg.challenge}));}
      assert.equal(req.headers['webhook-id'],msg.eventId);
      received.push({...msg,subscription:req.headers['x-mcp-subscription-id']});
      if(failNext>0) {failNext--;res.writeHead(503);return res.end();}
      res.writeHead(200);res.end('{}');
    });
  });
  await new Promise(done=>hook.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(done=>hook.close(done)));
  const callback='http://127.0.0.1:'+hook.address().port+'/events';
  const sender=webhookSender({allowLocal:true});
  const start=async()=>{
    const relay=await makeRelay({file,mcpToken:TOKEN,devices:{desktop:DEVICE},sender,deliveryMs:20,tickMs:60_000});
    await new Promise(done=>relay.server.listen(0,'127.0.0.1',done));
    return relay;
  };
  let {server,queue}=await start();
  const sub=await queue.subscribe({name:JOB_EVENT,arguments:{},delivery:{mode:'webhook',url:callback,secret:SECRET}},sender);
  assert.match(sub.id,/^sub_/);
  const job=await queue.enqueue({action:'start',prompt:'ping',request_id:'e2e-1'});
  await queue.claim('desktop');
  await queue.report('desktop',{job_id:job.id,status:'sent',chat_url:URL});
  failNext=1; // the first attempt fails: the same event must be retried
  await queue.modelReport({job_id:job.id,status:'done',summary:'PONG'});
  for(let i=0;i<200&&received.length<1;i++) await new Promise(r=>setTimeout(r,10));
  // Let the first relay record the failed attempt, then restart before the retry.
  for(let i=0;i<200&&queue.eventsStatus().outbox.pending!==1;i++) await new Promise(r=>setTimeout(r,10));
  await new Promise(done=>server.close(done));
  ({server,queue}=await start());
  t.after(()=>new Promise(done=>server.close(done)));
  for(let i=0;i<400&&queue.eventsStatus().outbox.accepted<1;i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(received.length,2);
  assert.equal(received[0].eventId,received[1].eventId,'the retry keeps the same eventId');
  const event=received[1];
  assert.equal(event.name,JOB_EVENT);
  assert.equal(event.subscription,sub.id);
  assert.deepEqual([event.data.job_id,event.data.chat_id,event.data.request_id,event.data.execution,event.data.summary],
    [job.id,ID,'e2e-1','done','PONG']);
  assert.equal(JSON.stringify(event).includes('ping'),false,'no prompt text in events');
  assert.equal(queue.eventsStatus().outbox.accepted,1);
  assert.equal(queue.eventsStatus().subscriptions[0].state,'active');
  const {readFile}=await import('node:fs/promises');
  assert.equal((await readFile(file,'utf8')).includes(SECRET),false,'the webhook secret is stored encrypted');
});

test('a callback that does not echo the challenge is refused',async t=>{
  const file=await tempFile(t);
  const hook=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200);res.end('{"challenge":"wrong"}');});});
  await new Promise(done=>hook.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(done=>hook.close(done)));
  const {q}=harness(file);
  await assert.rejects(q.subscribe({name:JOB_EVENT,arguments:{},delivery:{mode:'webhook',
    url:'http://127.0.0.1:'+hook.address().port+'/x',secret:SECRET}},webhookSender({allowLocal:true})),/challenge_failed/);
  await assert.rejects(q.subscribe({name:JOB_EVENT,arguments:{},delivery:{mode:'webhook',url:'http://127.0.0.1/x',secret:SECRET}},
    webhookSender()),/invalid_url/,'only HTTPS to public addresses in production');
});

test('one fact gives one event; blocked/needs_review/closed notify; 410 ends the subscription',async t=>{
  const {q,sent,sender}=harness(await tempFile(t),{statuses:[200,200,410]});
  await subscribeTo(q,sender,JOB_EVENT);
  const a=await q.enqueue({action:'continue',chat_ref:ID,prompt:'next'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:a.id,status:'blocked',message:'An unsent draft already exists'});
  await q.report('desktop',{job_id:a.id,status:'blocked'}); // repeated report: same fact
  await flush(q,sender);
  assert.equal(sent.length,1);
  assert.deepEqual([sent[0].data.status,sent[0].data.execution],['blocked','not_started']);
  const b=await q.enqueue({action:'close',chat_ref:ID});
  await q.claim('desktop');
  await q.report('desktop',{job_id:b.id,status:'closed',chat_url:URL,message:'Closed 1 tab(s)'});
  await flush(q,sender);
  assert.equal(sent.at(-1).data.status,'closed');
  const c=await q.enqueue({action:'start',prompt:'x'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:c.id,status:'needs_review'});
  await flush(q,sender);
  assert.equal(q.eventsStatus().subscriptions[0].state,'gone','410 means the subscriber is gone');
  assert.equal(q.eventsStatus().last_undelivered.last_error,'http_410');
});

test('silence is reported as unconfirmed once, never as done; progress keeps the work alive',async t=>{
  const {q,clock,sent,sender}=harness(await tempFile(t));
  await subscribeTo(q,sender,JOB_EVENT);
  const job=await q.enqueue({action:'start',prompt:'long task'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:job.id,status:'sent',chat_url:URL});
  assert.equal(q.status(job.id).execution,'awaiting_confirmation','sent is not proof of work');
  clock.t+=11*MIN; await q.tick(); await flush(q,sender);
  assert.equal(q.status(job.id).execution,'unconfirmed');
  assert.equal(sent.length,1);
  await q.modelReport({job_id:job.id,status:'started'});
  clock.t+=20*MIN;
  await q.modelReport({job_id:job.id,status:'progress',summary:'tests 40/92'});
  clock.t+=20*MIN; await q.tick();
  assert.equal(q.status(job.id).execution,'progress');
  assert.equal(q.status(job.id).model_progress,'tests 40/92');
  clock.t+=31*MIN; await q.tick(); await q.tick(); await flush(q,sender);
  assert.equal(q.status(job.id).execution,'unconfirmed');
  assert.equal(sent.length,2,'one event per silence, no storm');
  await q.modelReport({job_id:job.id,status:'done',summary:'92 PASS'});
  await q.modelReport({job_id:job.id,status:'progress'}); // a late progress cannot undo done
  await flush(q,sender);
  assert.equal(q.status(job.id).execution,'done');
  assert.equal(sent.at(-1).data.summary,'92 PASS');
});

test('coordination reminds only after the idle threshold, respects a timed pause and stops when closed',async t=>{
  const {q,clock,sent,sender}=harness(await tempFile(t));
  await subscribeTo(q,sender,REMINDER_EVENT);
  await assert.rejects(q.coordinationSet({}),/goal is required/);
  const opened=await q.coordinationSet({goal:'RKB night work',min_agents:2,idle_minutes:15});
  assert.equal(opened.open,true);
  const job=await q.enqueue({action:'start',prompt:'agent A'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:job.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:job.id,status:'started'});
  await q.tick();
  clock.t+=14*MIN; await q.tick(); await flush(q,sender);
  assert.equal(sent.length,0,'not before the threshold');
  clock.t+=2*MIN; await q.tick(); await flush(q,sender);
  assert.equal(sent.length,1);
  assert.deepEqual([sent[0].data.goal,sent[0].data.active_agents,sent[0].data.min_agents],['RKB night work',1,2]);
  assert.equal(sent[0].data.unfinished[0].job_id,job.id);
  clock.t+=5*MIN; await q.tick(); await flush(q,sender);
  assert.equal(sent.length,1,'at most one reminder per threshold');
  await assert.rejects(q.coordinationSet({pause_minutes:30}),/pause_reason/);
  await q.coordinationSet({pause_minutes:30,pause_reason:'waiting for the Kaggle build'});
  clock.t+=29*MIN; await q.tick(); await flush(q,sender);
  assert.equal(sent.length,1,'quiet while paused');
  clock.t+=2*MIN; await q.tick(); await flush(q,sender);
  assert.equal(sent.length,1,'idle time restarts after the pause');
  clock.t+=15*MIN; await q.tick(); await flush(q,sender);
  assert.equal(sent.length,2,'the pause expired, so reminders resume');
  await q.coordinationClose('result delivered');
  clock.t+=60*MIN; await q.tick(); await flush(q,sender);
  assert.equal(sent.length,2);
  assert.equal(q.coordinationStatus().open,false);
});

test('enough active agents means no reminder; diagnostics show subscriptions and coordination',async t=>{
  const {q,clock,sent,sender}=harness(await tempFile(t));
  await subscribeTo(q,sender,REMINDER_EVENT);
  await q.coordinationSet({goal:'two agents',min_agents:1,idle_minutes:1});
  const job=await q.enqueue({action:'start',prompt:'agent'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:job.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:job.id,status:'started'});
  clock.t+=10*MIN; await q.tick(); await flush(q,sender);
  assert.equal(sent.length,0);
  const status=q.deviceStatus('desktop');
  assert.equal(status.events.subscriptions[0].name,REMINDER_EVENT);
  assert.equal(status.coordination.active_agents.length,1);
  assert.equal(JSON.stringify(status).includes(SECRET),false,'the webhook secret is never shown');
});

test('subscription accepts a missing delivery mode and the optional device_id filter, like projects-hub',async t=>{
  const {q,sender}=harness(await tempFile(t));
  const sub=await q.subscribe({name:JOB_EVENT,arguments:{device_id:'desktop'},delivery:{url:'https://callback.example/hook',secret:SECRET}},sender);
  assert.match(sub.id,/^sub_/);
  await assert.rejects(q.subscribe({name:JOB_EVENT,arguments:{project_id:'x'},delivery:{url:'https://callback.example/hook',secret:SECRET}},sender),/unexpected_arguments/);
});

test('callback address filter: public OpenAI addresses pass, private and mapped ones do not',async()=>{
  const {isPublic}=await import('../relay/events.mjs');
  for(const [a,f] of [['104.18.38.184',4],['172.64.149.72',4],['2a06:98c1:3103::6812:26b8',6]]) assert.equal(isPublic(a,f),true,a);
  for(const [a,f] of [['127.0.0.1',4],['10.1.2.3',4],['172.16.5.5',4],['192.168.1.1',4],['169.254.1.1',4],['100.64.0.1',4],
    ['::1',6],['fd00::1',6],['fe80::1',6],['::ffff:127.0.0.1',6],['::ffff:104.18.38.184',6]]) assert.equal(isPublic(a,f),false,a);
});
