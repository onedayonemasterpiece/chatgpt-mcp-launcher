import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const src=await readFile(new URL('../extension/popup.js',import.meta.url),'utf8');
const html=await readFile(new URL('../extension/popup.html',import.meta.url),'utf8');

test('popup requests Chrome match-pattern without port, preserves exact fetch origin',async()=>{
 const elements=new Map();
 for(const id of ['url','device','token','enabled','save','poll','status','refresh','activeRevision','installedRevision','manifestVersion','integrity','updateStatus','heartbeatStatus','updateNow']){
   elements.set(id,{value:'',checked:false,disabled:false,textContent:'',handlers:{},
     addEventListener(event,fn){this.handlers[event]=fn;}});
 }
 const popup=id=>elements.get(id);
 const config={};
 const requests=[];
 const chrome={
   storage:{local:{get:async()=>({}),set:async()=>{}}},
   permissions:{request:async(req)=>{requests.push(req.origins[0]);return true;}},
   runtime:{sendMessage:async(msg)=>{
     if(msg.type==='GET_VERSION') return {
       active_revision:'a'.repeat(40),installed_revision:'b'.repeat(40),
       manifest_version:'0.2.0',runtime_integrity:'ok',
       updater:{state:'current',checked_at:'2026-10-21T13:00:00Z'},
       last_heartbeat_at:'2026-10-21T13:01:00Z'
     };
     if(msg.config) Object.assign(config,msg.config);
     return {ok:true};
   }},
 };
 runInNewContext(src,{chrome,document:{getElementById:popup},URL,console});
 popup('url').value='http://127.0.0.1:8177';
 popup('device').value='desktop';
 popup('token').value='x'.repeat(24);
 popup('enabled').checked=true;
 await popup('save').handlers.click();
 assert.equal(requests[0],'http://127.0.0.1/*');
 assert.equal(config.url,'http://127.0.0.1:8177');
 assert.equal(config.enabled,true);
 assert.match(popup('status').textContent,/Настройки сохранены/);
 assert.equal(popup('activeRevision').textContent,'a'.repeat(40));
 assert.equal(popup('installedRevision').textContent,'b'.repeat(40));
 popup('url').value='https://relay.example.org:8443/path';
 await popup('save').handlers.click();
 assert.equal(requests[1],'https://relay.example.org/*');
 assert.equal(config.url,'https://relay.example.org:8443/path');
 assert.match(html,/id="updateNow"[^>]+href="chatgpt-mcp-update:\/\/check"/);
 assert.equal(typeof popup('updateNow').handlers.click,'function');
 popup('updateNow').handlers.click();
 assert.match(popup('status').textContent,/Запускаю обновлятор Windows/);
});
