import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const TARGET='https://chatgpt.com/c/6ad89e0c-b984-83ea-88ba-dd29b57ee40b';
const OTHER='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
function runtimeFixture() {
  const state={
    config:{url:'https://relay.example.test',deviceId:'desktop',token:'x'.repeat(40),enabled:true},
    trackedChatTabs:{
      '11':{job_id:'job-1',action:'start',expected_chat_url:null,observed_url:null},
      '12':{job_id:'job-2',action:'continue',expected_chat_url:OTHER,observed_url:null}
    }
  };
  let onUpdate;
  const sent=[];
  const chrome={
    storage:{local:{
      get:async keys=>typeof keys==='string'?{[keys]:state[keys]}:
        Object.fromEntries(keys.map(key=>[key,state[key]])),
      set:async value=>Object.assign(state,value)
    }},
    alarms:{create:async()=>{},clear:async()=>{},onAlarm:{addListener:()=>{}}},
    runtime:{onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}},
      onMessage:{addListener:()=>{}},getURL:p=>'chrome-extension://ext/'+p},
    tabs:{onUpdated:{addListener:cb=>onUpdate=cb}}
  };
  const fetch=async(url,options={})=>{
    assert.equal(String(url),'https://relay.example.test/device/report');
    assert.equal(options.method,'POST');
    sent.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({chat:{recorded:true}})};
  };
  const ctx={chrome,URL,Date,Number,AbortController,setTimeout,clearTimeout,fetch};
  runInNewContext(source,ctx,{filename:'background.js',timeout:1500});
  if(typeof onUpdate!=='function')throw Error('Chrome navigation observer was not installed');
  return {state,sent,onUpdate};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,50));

test('new ChatGPT /c/ route is reported as safe metadata, without response or prompt content',async()=>{
  const f=runtimeFixture();
  f.onUpdate(11,{url:TARGET},{url:TARGET});
  await settle();
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].type,'chat_seen');
  assert.equal(f.sent[0].job_id,'job-1');
  assert.equal(f.sent[0].chat_url,TARGET);
  assert.equal(JSON.stringify(f.sent[0]).includes('prompt'),false);
  f.onUpdate(11,{url:TARGET},{url:TARGET});
  await settle();
  assert.equal(f.sent.length,1,'navigation should not be reported twice');
});
test('tab observer ignores untrusted external destinations and wrong existing conversations',async()=>{
  const f=runtimeFixture();
  f.onUpdate(11,{url:'https://chatgpt.com.evil.test/c/abcdef0123'},{});
  f.onUpdate(12,{url:TARGET},{});
  f.onUpdate(999,{url:TARGET},{});
  await settle();
  assert.equal(f.sent.length,0);
});
