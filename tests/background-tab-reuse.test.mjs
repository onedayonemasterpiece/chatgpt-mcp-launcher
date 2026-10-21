import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const CHAT='https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';

function fixture(openTabs=[],opts={}) {
  const calls={created:[],updated:[],windows:[],injections:[]};
  const tabs=new Map(openTabs.map(t=>[t.id,{status:'complete',windowId:1,...t}]));
  let newTabId=100;
  let reads=0;
  const chrome={
    storage:{local:{get:async()=>({}),set:async()=>{}}},
    alarms:{create:async()=>{},clear:async()=>{},onAlarm:{addListener:()=>{}}},
    runtime:{getURL:()=>'',reload:()=>{},onInstalled:{addListener:()=>{}},
      onStartup:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
    tabs:{
      query:async()=>[...tabs.values()],
      update:async(id,params)=>{calls.updated.push({id,...params});return tabs.get(id);},
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
      return params.files?[]:[{result:{
        status:'sent',chat_url:params.args[0].chat_url??CHAT,message:'fixture send clicked',
      }}];
    }},
  };
  const sandbox={chrome,URL,Date,Number,AbortController,
    setTimeout:opts.instantTimers ? (cb)=>{Promise.resolve().then(cb);return 1;} : setTimeout,
    clearTimeout,fetch:async()=>{throw Error('Unexpected fetch')}};
  runInNewContext(source,sandbox,{filename:'background.js',timeout:2000});
  return {execute:sandbox.execute,awaitTab:sandbox.awaitTab,calls,getReads:()=>reads};
}

test('continue reuses matching open ChatGPT conversation and focuses its window',async()=>{
  const f=fixture([{id:21,url:CHAT+'/'}]);
  const result=await f.execute({action:'continue',chat_url:CHAT,prompt:'Continue the work',effort:'auto'});
  assert.equal(result.status,'sent');
  assert.deepEqual(f.calls.created,[]);
  assert.deepEqual(f.calls.updated,[{id:21,active:true}]);
  assert.deepEqual(f.calls.windows,[{id:1,focused:true}]);
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
