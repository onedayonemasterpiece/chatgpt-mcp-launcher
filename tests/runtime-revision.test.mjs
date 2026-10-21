import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../extension/background.js',import.meta.url));
const driver=await readFile(new URL('../extension/page-driver.js',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const REV='a'.repeat(40);
function fixture() {
  const state={config:{enabled:false,url:'https://relay.example.org',deviceId:'desktop',token:'x'.repeat(40)}};
  const events={heartbeats:[],polls:0,reloads:0};
  let installed=REV,corrupt=false;
  const chrome={
    storage:{local:{get:async keys=>typeof keys==='string' ? {[keys]:state[keys]} :
      Object.fromEntries(keys.map(k=>[k,state[k]])),set:async obj=>Object.assign(state,obj)}},
    runtime:{getManifest:()=>({version:'0.2.0'}),
      getURL:p=>'chrome-extension://fixture-id/'+p,reload:()=>events.reloads++,
      onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
    alarms:{create:async()=>{},clear:async()=>{},onAlarm:{addListener:()=>{}}},
  };
  const sandbox={chrome,URL,Date,Number,AbortController,crypto:webcrypto,setTimeout,clearTimeout};
  sandbox.importScripts=()=>{
    sandbox.CHATGPT_LAUNCHER_BUILD={
      revision:REV,background_sha256:hash(source),driver_sha256:hash(driver),
      driver_file:'page-driver-'+REV+'.js',
    };
  };
  sandbox.fetch=async url=>{
    const str=String(url),path=str.split('?')[0];
    if(path.startsWith('chrome-extension://')) {
      if(path.endsWith('/dev-revision.json')) return {ok:true,json:async()=>({revision:installed,schema_version:2})};
      if(path.endsWith('/updater-status.json')) return {ok:true,json:async()=>({
        state:'current',checked_at:'2026-10-21T12:00:00Z'
      })};
      if(path.endsWith('/background.js')) return {ok:true,arrayBuffer:async()=>Uint8Array.from(source).buffer};
      if(path.endsWith('/page-driver-'+REV+'.js')) {
        const b=corrupt?Buffer.from('changed'):driver;
        return {ok:true,arrayBuffer:async()=>Uint8Array.from(b).buffer};
      }
      throw new Error('Unexpected extension resource '+path);
    }
    if(path.endsWith('/device/report')) return {ok:true,status:200,
      json:async()=>({ok:true,reported_revision:REV})};
    if(path.endsWith('/device/poll')) {
      events.polls++;
      return {ok:true,status:200,json:async()=>({job:null})};
    }
    throw new Error('Unexpected network request '+str);
  };
  // Observe outgoing authenticated JSON heartbeat without disclosing tokens.
  const underlying=sandbox.fetch;
  sandbox.fetch=async (url,init={})=>{
    if(String(url).includes('/device/report')) events.heartbeats.push(JSON.parse(init.body));
    return underlying(url,init);
  };
  runInNewContext(source.toString('utf8'),sandbox,{filename:'background.js',timeout:2000});
  return {sandbox,events,state,setInstalled:v=>installed=v,setCorrupt:v=>corrupt=v};
}

test('running worker SHA is distinct from disk marker and posted when disabled',async()=>{
  const f=fixture();
  const result=await f.sandbox.poll();
  assert.equal(result.commands_disabled,true);
  assert.equal(f.events.polls,0,'disabled mode never claims work');
  assert.equal(f.events.heartbeats.length,1);
  assert.equal(f.events.heartbeats[0].active_revision,REV);
  assert.equal(f.events.heartbeats[0].installed_revision,REV);
  assert.equal(f.events.heartbeats[0].runtime_integrity,'ok');
  assert.equal(f.events.heartbeats[0].commands_enabled,false);
  f.state.config.enabled=true;
  const again=await f.sandbox.poll();
  assert.equal(again.idle,true);
  assert.equal(f.events.polls,1);
  f.setInstalled('b'.repeat(40));
  const mismatch=await f.sandbox.poll();
  assert.equal(mismatch.commands_blocked,true);
  assert.equal(mismatch.version.active_revision,REV);
  assert.equal(mismatch.version.installed_revision,'b'.repeat(40));
  assert.equal(f.events.polls,1);
});

test('changed driver bytes block commands even when revision markers match',async()=>{
  const f=fixture();
  f.state.config.enabled=true;
  f.setCorrupt(true);
  const result=await f.sandbox.poll();
  assert.equal(result.commands_blocked,true);
  assert.equal(result.version.runtime_integrity,'mismatch');
  assert.equal(f.events.polls,0);
});
