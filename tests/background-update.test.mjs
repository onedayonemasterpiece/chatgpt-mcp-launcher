import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const REVISION_A='a'.repeat(40),REVISION_B='b'.repeat(40);

test('unpacked Windows sync marker triggers a single safe Chrome extension reload',async()=>{
  const state={appliedDevRevision:REVISION_A};
  let marker=REVISION_B;
  let reloads=0;
  const listeners=[];
  const chrome={
    storage:{local:{
      async get(keys){
        if(typeof keys==='string') return {[keys]:state[keys]};
        return Object.fromEntries(keys.map(key=>[key,state[key]]));
      },
      async set(value){Object.assign(state,value);},
    }},
    alarms:{
      create:async()=>{},clear:async()=>{},
      onAlarm:{addListener:(cb)=>listeners.push(cb)},
    },
    runtime:{
      getURL:(path)=>'chrome-extension://fixture-id/'+path,
      reload:()=>reloads++,
      onInstalled:{addListener:()=>{}},
      onStartup:{addListener:()=>{}},
      onMessage:{addListener:()=>{}},
    },
  };
  const sandbox={
    chrome,URL,Date,AbortController,setTimeout,clearTimeout,
    fetch:async()=>({ok:true,json:async()=>({revision:marker})}),
  };
  runInNewContext(source,sandbox,{timeout:2000,filename:'background.js'});
  assert.equal(listeners.length,1);
  let response=await sandbox.checkDevReload();
  assert.equal(response.reloading,true);
  assert.equal(state.appliedDevRevision,REVISION_B);
  assert.equal(reloads,1);
  response=await sandbox.checkDevReload();
  assert.equal(response.current,true);
  assert.equal(reloads,1);
  state.pendingReport={job_id:'pending',status:'needs_review'};
  marker=REVISION_A;
  response=await sandbox.checkDevReload();
  assert.equal(response.pending,true);
  assert.equal(reloads,1);
  state.pendingReport=null;
  response=await sandbox.checkDevReload();
  assert.equal(response.reloading,true);
  assert.equal(reloads,2);
});

test('malformed update marker never triggers reload',async()=>{
  const state={appliedDevRevision:REVISION_A};
  let reloads=0;
  const chrome={
    storage:{local:{get:async()=>({...state}),set:async()=>{}}},
    alarms:{create:async()=>{},clear:async()=>{},onAlarm:{addListener:()=>{}}},
    runtime:{getURL:p=>'chrome-extension://fixture/'+p,reload:()=>reloads++,
      onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
  };
  const sandbox={chrome,URL,Date,AbortController,setTimeout,clearTimeout,
    fetch:async()=>({ok:true,json:async()=>({revision:'invalid'})})};
  runInNewContext(source,sandbox,{timeout:2000});
  const result=await sandbox.checkDevReload();
  assert.equal(result.invalidMarker,true);
  assert.equal(reloads,0);
});
