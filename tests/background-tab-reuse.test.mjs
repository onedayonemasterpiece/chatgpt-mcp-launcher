import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const CHAT='https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';

function fixture(openTabs=[],opts={}) {
  const calls={created:[],updated:[],windows:[],injections:[],reloads:[],delays:[]};
  const state=opts.state||{}, deadlines=new Map();
  let releaseScript;
  const tabs=new Map(openTabs.map(t=>[t.id,{status:'complete',windowId:1,...t}]));
  let newTabId=100;
  let reads=0;
  const chrome={
    storage:{local:{get:async()=>({...state}),set:async value=>Object.assign(state,value)}},
    alarms:{create:async()=>{},clear:async()=>{},onAlarm:{addListener:()=>{}}},
    runtime:{getURL:()=>'',reload:()=>{},onInstalled:{addListener:()=>{}},
      onStartup:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
    tabs:{
      query:async()=>[...tabs.values()],
      update:async(id,params)=>{calls.updated.push({id,...params});return tabs.get(id);},
      reload:async id=>{calls.reloads.push(id);},
      remove:async id=>{calls.removed=(calls.removed||[]).concat(id);tabs.delete(id);},
      get:async(id)=>{
        const tab=tabs.get(id);
        if(opts.slowLoadReads && reads++ < opts.slowLoadReads) return {...tab,status:'loading',...(opts.loadingUrl!==undefined?{url:opts.loadingUrl}:{})};
        return {...tab,status:'complete'};
      },
      create:async(params)=>{
        calls.created.push(params);
        const tab={id:newTabId++,windowId:3,status:'complete',url:params.url};
        tabs.set(tab.id,tab);
        return tab;
      },
    },
    windows:{update:async(id,params)=>calls.windows.push({id,...params})},
    scripting:{executeScript:async(params)=>{
      calls.injections.push(params.target.tabId);
      if(calls.injections.length===opts.hangAt) return new Promise(resolve=>{releaseScript=resolve;});
      if(params.files) return [];
      if(params.args[0].action==='probe') return [{result:opts.probe||{draft:false,answering:false}}];
      if(opts.frameRemovedOnce && !calls.frameRemoved && ['start','continue'].includes(params.args[0].action)) {
        calls.frameRemoved=true;
        throw Error('Frame 0 was removed');
      }
      if(params.args[0].action==='reconcile') return [{result:opts.recoveryEvidence||
        {status:'read',chat_url:CHAT,delivery_evidence:'unknown',evidence_kind:'unconfirmed'}}];
      if(opts.driverResults?.length) return [{result:opts.driverResults.shift()}];
      return [{result:{
        status:'sent',chat_url:params.args[0].chat_url??CHAT,message:'fixture send clicked',
      }}];
    }},
  };
  const random=Object.create(Math);
  if(opts.random!==undefined) random.random=()=>opts.random;
  const sandbox={chrome,URL,Date,Number,Math:random,AbortController,
    setTimeout:(cb,ms)=>{calls.delays.push(ms);if(ms===180000){const id={};deadlines.set(id,cb);return id;}Promise.resolve().then(cb);return 1;},
    clearTimeout:id=>deadlines.delete(id),fetch:opts.fetch||async function(){throw Error('Unexpected fetch');}};
  runInNewContext(source,sandbox,{filename:'background.js',timeout:2000});
  return {execute:sandbox.execute,awaitTab:sandbox.awaitTab,calls,getReads:()=>reads,
    sandbox,state,deadlines,releaseScript:()=>releaseScript?.([]),
    fireDeadline:()=>{assert.equal(deadlines.size,1);[...deadlines.values()][0]();}};
}

for(const action of ['read','reconcile']) for(const hangAt of [1,2]) {
  test(`${action} Chrome call ${hangAt} timeout releases poll for later heartbeat`,async()=>{
    const reports=[];
    let delivered=false;
    const job={action,id:'read-only-job',chat_url:CHAT};
    const f=fixture([{id:21,url:CHAT}],{hangAt,
      state:{config:{url:'https://relay.example',token:'fixture',deviceId:'desktop',enabled:true}},
      fetch:async(url,options)=>({ok:true,json:async()=>{
        if(url.endsWith('/device/poll')){const next=delivered?null:job;delivered=true;return {job:next};}
        const body=JSON.parse(options.body);reports.push(body);return {ok:true};
      }}),
    });
    f.sandbox.runningVersion=async()=>({update_state:'current'});
    const pending=f.sandbox.poll();
    for(let i=0;i<100 && f.calls.injections.length<hangAt;i++) await Promise.resolve();
    assert.equal(f.calls.injections.length,hangAt);
    assert.equal((await f.sandbox.poll()).busy,true);
    f.fireDeadline();
    const result=await pending;
    assert.equal(result.status,'needs_review');
    assert.match(result.message,/read-only.*timed out/i);
    assert.equal(f.state.pendingReport,null);
    assert.equal(f.deadlines.size,0,'deadline timer cleaned up');
    assert.equal(reports.filter(r=>r.type==='heartbeat').length,1);
    assert.equal((await f.sandbox.poll()).idle,true);
    assert.equal(reports.filter(r=>r.type==='heartbeat').length,2);
    assert.equal(reports.filter(r=>r.job_id===job.id).length,1);
    f.releaseScript();
    for(let i=0;i<20;i++) await Promise.resolve();
    assert.equal(reports.filter(r=>r.job_id===job.id).length,1,'late read does not resend or overwrite timeout report');
  });
}

test('probe deadline bounds inspection while start/continue stay outside it',async()=>{
  for(const action of ['probe','start','continue']) {
    const f=fixture([{id:21,url:CHAT}],{hangAt:1});
    const pending=f.sandbox.runDriver('page-driver.js',{id:21},{action,chat_url:CHAT});
    await Promise.resolve();
    if(action==='probe') {
      f.fireDeadline();
      await assert.rejects(pending,/read-only.*timed out/i);
      assert.equal(f.deadlines.size,0);
    } else {
      assert.equal(f.deadlines.size,0,'prompt actions have no inspection timeout');
      f.releaseScript();
      assert.equal((await pending).result.status,'sent');
    }
  }
});


test('private book Stop uses the exact existing tab; never creates one or visits another conversation',async()=>{
  const id='6ed884fe-1026-4728-2017-d6c47282017a';
  const job={action:'book_stop',chat_url:CHAT,after_job_id:id};
  const f=fixture([{id:19,url:OTHER},{id:21,url:CHAT}],{driverResults:[
    {status:'stopped',chat_url:CHAT,message:'Exact book turn stopped in ChatGPT UI'}]});
  const result=await f.execute(job);
  assert.equal(result.status,'stopped');
  assert.deepEqual(f.calls.created,[]);
  assert.deepEqual(f.calls.updated,[]);
  assert.deepEqual(f.calls.injections,[21,21]);
  const missing=fixture([{id:19,url:OTHER}]);
  const blocked=await missing.execute(job);
  assert.equal(blocked.status,'blocked');
  assert.deepEqual(missing.calls.created,[]);
  assert.deepEqual(missing.calls.injections,[]);
  const ambiguous=fixture([{id:19,url:CHAT},{id:21,url:CHAT}]);
  assert.equal((await ambiguous.execute(job)).status,'blocked');
  assert.deepEqual(ambiguous.calls.injections,[]);
});
test('continue reuses matching open ChatGPT conversation and focuses its window',async()=>{
  const f=fixture([{id:21,url:CHAT+'/'}]);
  const result=await f.execute({action:'continue',chat_url:CHAT,prompt:'Continue the work',effort:'auto'});
  assert.equal(result.status,'sent');
  assert.deepEqual(f.calls.created,[]);
  assert.deepEqual(f.calls.updated,[{id:21,active:true}]);
  assert.deepEqual(f.calls.windows,[{id:1,focused:true}]);
  assert.deepEqual(f.calls.reloads,[],'never reload: it can leave ChatGPT stuck mid-answer');
  assert.deepEqual(f.calls.injections,[21,21]);
});

test('continue opens target conversation without navigating an unrelated open chat',async()=>{
  const f=fixture([{id:19,url:OTHER}]);
  const result=await f.execute({action:'continue',chat_url:CHAT,prompt:'Continue the work',effort:'auto'});
  assert.equal(result.status,'sent');
  assert.deepEqual(f.calls.updated,[]);
  assert.equal(f.calls.created.length,1);
  assert.equal(f.calls.created[0].url,CHAT);
  assert.deepEqual(f.calls.injections,[100,100]);
});

test('start and continue wait a varied few seconds after opening or focusing a chat',async()=>{
  for(const [random,expected] of [[0,1500],[0.5,2500],[0.9999,3500]]) {
    const f=fixture([{id:21,url:CHAT}],{random});
    await f.execute({action:'continue',chat_url:CHAT,prompt:'Continue'});
    assert.deepEqual(f.calls.delays,[expected]);
  }
  const f=fixture([],{random:0.5});
  await f.execute({action:'start',prompt:'New conversation'});
  assert.deepEqual(f.calls.delays,[2500]);
});

test('open-only reuses existing conversation and never touches composer or Send button',async()=>{
  const f=fixture([{id:21,url:CHAT}]);
  const result=await f.execute({action:'open',chat_url:CHAT,id:'open-job-1'});
  assert.equal(result.status,'opened');
  assert.equal(result.chat_url,CHAT);
  assert.deepEqual(f.calls.created,[]);
  assert.deepEqual(f.calls.updated,[{id:21,active:true}]);
  assert.deepEqual(f.calls.injections,[],'open-only must not inject page driver');
});

test('open-only creates target tab if absent and never submits a prompt',async()=>{
  const f=fixture([{id:10,url:OTHER}]);
  const result=await f.execute({action:'open',chat_url:CHAT,id:'open-job-2'});
  assert.equal(result.status,'opened');
  assert.equal(f.calls.created.length,1);
  assert.equal(f.calls.created[0].url,CHAT);
  assert.deepEqual(f.calls.injections,[]);
});

test('a URL outside ChatGPT is rejected before browser tab access',async()=>{
  const f=fixture([{id:19,url:OTHER}]);
  await assert.rejects(()=>f.execute({action:'continue',chat_url:'https://example.com/c/abc',prompt:'x'}),/Invalid ChatGPT conversation URL/);
  assert.deepEqual(f.calls.created,[]);
  assert.deepEqual(f.calls.updated,[]);
});

test('start continues to create a new chat',async()=>{
  const f=fixture([{id:21,url:CHAT}]);
  await f.execute({action:'start',prompt:'New conversation',effort:'auto'});
  assert.equal(f.calls.created[0].url,'https://chatgpt.com/');
  assert.deepEqual(f.calls.updated,[]);
  assert.deepEqual(f.calls.windows,[{id:3,focused:true}]);
});

test('slow ChatGPT tab still loads after a simulated 70-second navigation',async()=>{
  const f=fixture([{id:50,url:CHAT,status:'loading'}],{slowLoadReads:350,instantTimers:true});
  await f.awaitTab(50);
  assert.ok(f.getReads()>50,'must wait past the old 10-second window');
});

test('a ChatGPT page that never finishes loading still proceeds after 30 seconds',async()=>{
  const f=fixture([{id:51,url:CHAT,status:'loading'}],{slowLoadReads:10_000,instantTimers:true});
  await f.awaitTab(51);
  assert.ok(f.getReads()>150 && f.getReads()<200,'goes on once the chatgpt.com page is committed');
});

test('a tab that never reaches chatgpt.com fails after 90 seconds',async()=>{
  const f=fixture([{id:52,url:'about:blank',status:'loading'}],{slowLoadReads:10_000,instantTimers:true,loadingUrl:'about:blank'});
  await assert.rejects(()=>f.awaitTab(52),/did not open within 90 seconds/);
});

const HOME='https://chatgpt.com/';
test('start reuses an already open empty New chat tab',async()=>{
  const f=fixture([{id:30,url:CHAT},{id:31,url:HOME}]);
  const result=await f.execute({action:'start',prompt:'New conversation',effort:'auto'});
  assert.equal(result.status,'sent');
  assert.deepEqual(f.calls.created,[]);
  assert.deepEqual(f.calls.updated,[{id:31,active:true}]);
  assert.deepEqual(f.calls.injections,[31,31]);
});

test('start falls back to a fresh tab when the open New chat tab holds a draft',async()=>{
  const f=fixture([{id:32,url:HOME}],{random:0.5,driverResults:[
    {status:'blocked',reason:'draft',message:'An unsent draft already exists; not overwriting it'},
    {status:'sent',chat_url:CHAT,message:'New chat created via Send button.'}]});
  const result=await f.execute({action:'start',prompt:'New conversation',effort:'auto'});
  assert.equal(result.status,'sent');
  assert.equal(f.calls.created.length,1);
  assert.equal(f.calls.created[0].url,HOME);
  assert.deepEqual(f.calls.injections,[32,32,100,100]);
  assert.deepEqual(f.calls.delays,[2500,2500]);
});

test('Frame 0 removed after Send is recovered only from a matching read-only job marker',async()=>{
  const f=fixture([{id:36,url:CHAT}],{frameRemovedOnce:true,recoveryEvidence:{
    status:'read',chat_url:CHAT,delivery_evidence:'sent',evidence_kind:'user_message_marker'}});
  const job='6ed884fe-1026-4728-2017-d6c47282017a';
  const result=await f.execute({id:job,action:'continue',chat_url:CHAT,prompt:'Do once'});
  assert.equal(result.status,'sent');
  assert.match(result.message,/no retry/);
  assert.deepEqual(f.calls.injections,[36,36,36,36],
    'one send attempt and one read-only recovery, no additional send');
  assert.deepEqual(f.calls.created,[]);
});

test('Frame 0 removed with an unreadable or mismatched conversation remains unknown, never retried',async()=>{
  for(const evidence of [
    {status:'read',chat_url:CHAT,delivery_evidence:'unknown'},
    {status:'read',chat_url:OTHER,delivery_evidence:'sent',evidence_kind:'user_message_marker'}
  ]) {
    const f=fixture([{id:37,url:CHAT}],{frameRemovedOnce:true,recoveryEvidence:evidence});
    await assert.rejects(()=>f.execute({id:'6ed884fe-1026-4728-2017-d6c47282017a',
      action:'continue',chat_url:CHAT,prompt:'Do once'}),/Frame 0 was removed/);
    assert.deepEqual(f.calls.injections,[37,37,37,37]);
  }
});

test('a queued reconcile job performs no Send and forwards only boolean evidence',async()=>{
  const f=fixture([{id:38,url:CHAT}],{recoveryEvidence:{status:'read',chat_url:CHAT,
    delivery_evidence:'sent',evidence_kind:'user_message_marker',execution_evidence:'page_completed'}});
  const out=await f.execute({action:'reconcile',chat_url:CHAT,
    verify_job_id:'6ed884fe-1026-4728-2017-d6c47282017a'});
  assert.equal(out.status,'read');
  assert.equal(out.delivery_evidence,'sent');
  assert.equal(out.evidence_kind,'user_message_marker');
  assert.equal(out.execution_evidence,'page_completed');
  assert.deepEqual(f.calls.injections,[38,38]);
  assert.deepEqual(f.calls.created,[]);
});

test('read reuses the conversation tab and passes the reply through',async()=>{
  const f=fixture([{id:33,url:CHAT}],{driverResults:[
    {status:'read',chat_url:CHAT,reply_text:'PONG',reply_generating:false,message:'Last ChatGPT reply read'}]});
  const result=await f.execute({action:'read',chat_url:CHAT,id:'read-1'});
  assert.equal(result.status,'read');
  assert.equal(result.reply_text,'PONG');
  assert.equal(result.reply_generating,false);
  assert.deepEqual(f.calls.created,[]);
});

test('open-only never reloads or probes the tab',async()=>{
  const f=fixture([{id:35,url:CHAT}]);
  await f.execute({action:'open',chat_url:CHAT,id:'open-3'});
  assert.deepEqual(f.calls.reloads,[]);
  assert.deepEqual(f.calls.injections,[]);
});

test('close-chat closes only idle tabs of that conversation',async()=>{
  const f=fixture([{id:40,url:CHAT},{id:41,url:OTHER}]);
  const result=await f.execute({action:'close',chat_url:CHAT,id:'close-1'});
  assert.equal(result.status,'closed');
  assert.deepEqual(f.calls.removed,[40]);
  assert.deepEqual(f.calls.created,[]);
});

test('close-chat leaves a tab with a draft or a reply in progress open',async()=>{
  for(const probe of [{draft:true,answering:false},{draft:false,answering:true}]) {
    const f=fixture([{id:42,url:CHAT}],{probe});
    const result=await f.execute({action:'close',chat_url:CHAT,id:'close-2'});
    assert.equal(result.status,'blocked',JSON.stringify(probe));
    assert.equal(f.calls.removed,undefined);
  }
});

test('close-chat with no open tab is simply done',async()=>{
  const f=fixture([{id:43,url:OTHER}]);
  const result=await f.execute({action:'close',chat_url:CHAT,id:'close-3'});
  assert.equal(result.status,'closed');
  assert.match(result.message,/No open tab/);
});

test('close-chat reports partial closure truthfully when another matching tab is still answering',async()=>{
  const f=fixture([{id:44,url:CHAT},{id:45,url:CHAT},{id:46,url:OTHER}]);
  const execute=f.sandbox.chrome.scripting.executeScript;
  f.sandbox.chrome.scripting.executeScript=async params=>
    params.target.tabId===45&&!params.files?[{result:{draft:false,answering:true}}]:execute(params);
  const result=await f.execute({action:'close',chat_url:CHAT,id:'close-partial'});
  assert.equal(result.status,'blocked');
  assert.deepEqual(f.calls.removed,[44]);
  assert.match(result.message,/still answering/);
});

test('refresh_tools opens the plugin settings page, presses once and closes the tab',async()=>{
  const PLUGIN='https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_6ac1800f87d081918bf59ecffa242499';
  const f=fixture([{id:21,url:CHAT}],{driverResults:[{status:'refreshed',message:'Refresh tools pressed and finished'}]});
  const result=await f.execute({action:'refresh_tools',chat_url:PLUGIN,id:'refresh-job'});
  assert.equal(result.status,'refreshed');
  assert.equal(result.chat_url,null);
  assert.deepEqual(f.calls.created.map(c=>c.url),[PLUGIN]);
  assert.deepEqual(f.calls.removed,[100],'only the plugin tab is closed, never a chat');
  await assert.rejects(f.execute({action:'refresh_tools',chat_url:CHAT,id:'bad'}),/plugin settings URL/);
});

test('missing refresh button reports bounded visible labels and path without clicking',async()=>{
  const f=fixture();let clicks=0;
  f.sandbox.location={pathname:'/settings/plugins-settings/plugin_fixture',search:'?private=omitted'};
  const button=(text,visible=true)=>({textContent:text,getClientRects:()=>visible?[{}]:[],
    getAttribute:()=>null,click:()=>clicks++});
  f.sandbox.document={querySelectorAll:()=>[button('Reconnect'),button('hidden-secret',false),
    ...Array.from({length:15},()=>button('x'.repeat(100)))]};
  const result=await f.sandbox.pressRefreshTools();
  assert.equal(result.status,'blocked');assert.equal(clicks,0);
  assert.match(result.message,/Path: \/settings\/plugins-settings\/plugin_fixture/);
  const labels=JSON.parse(result.message.split('visible button labels: ')[1]);
  assert.equal(labels.length,12);assert.equal(labels[0],'Reconnect');
  assert.ok(labels.every(label=>label.length<=60));
  assert.equal(result.message.includes('hidden-secret'),false);
  assert.equal(result.message.includes('private=omitted'),false);
});
