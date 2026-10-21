import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeRelay} from '../relay/server.mjs';

const SERVER_TOKEN='m'.repeat(40);
const DEVICE_TOKEN='d'.repeat(40);
const REV='a'.repeat(40);
const INSTALLED='b'.repeat(40);

test('device heartbeat tracks loaded vs installed SHA independently and disabled devices cannot claim jobs',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launcher-version-test-'));
  const file=join(dir,'queue.json');
  const {server,queue}=await makeRelay({
    file,mcpToken:SERVER_TOKEN,devices:{desktop:DEVICE_TOKEN},
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const headers={'Authorization':'Bearer '+DEVICE_TOKEN,
    'X-Launcher-Device-Id':'desktop','X-Launcher-Revision':REV,
    'Content-Type':'application/json'};
  async function request(path,method='GET',body=null,head=headers){
    const res=await fetch(base+path,{method,headers:head,body:body?JSON.stringify(body):undefined});
    return {status:res.status,data:await res.json()};
  }
  const job=await queue.enqueue({action:'start',prompt:'one harmless test',device_id:'desktop'});
  const heartbeat={
    type:'heartbeat',schema_version:1,active_revision:REV,installed_revision:INSTALLED,
    manifest_version:'0.2.0',commands_enabled:false,runtime_integrity:'ok',
    runtime_loaded_at:'2026-10-21T11:30:00Z',
    updater:{state:'error',checked_at:'2026-10-21T11:32:00Z',error_code:'git_auth_failed',trigger:'manual'},
  };
  let out=await request('/device/report','POST',heartbeat);
  assert.equal(out.status,200);
  assert.equal(out.data.reported_revision,REV);
  let status=queue.deviceStatus('desktop');
  assert.equal(status.online,true);
  assert.equal(status.active_revision,REV);
  assert.equal(status.revision,REV);
  assert.equal(status.installed_revision,INSTALLED);
  assert.equal(status.runtime_integrity,'ok');
  assert.equal(status.manifest_version,'0.2.0');
  assert.equal(status.commands_enabled,false);
  assert.equal(status.updater_error,'git_auth_failed');
  assert.equal(status.updater_trigger,'manual');
  out=await request('/device/poll');
  assert.equal(out.status,200);
  assert.equal(out.data.job,null);
  assert.equal(queue.status(job.id).status,'queued');
  const mismatch={...heartbeat,active_revision:'c'.repeat(40)};
  assert.equal((await request('/device/report','POST',mismatch)).status,400);
  status=queue.deviceStatus('desktop');
  assert.equal(status.active_revision,REV);
  out=await request('/device/report','POST',{
    ...heartbeat,commands_enabled:true,installed_revision:REV,
    updater:{state:'current',checked_at:'2026-10-21T11:35:00Z',trigger:'scheduled'},
  });
  assert.equal(out.status,200);
  assert.equal(queue.deviceStatus('desktop').updater_trigger,'scheduled');
  out=await request('/device/poll');
  assert.equal(out.data.job.id,job.id);
  assert.equal(queue.status(job.id).status,'claimed');
  const {server:second,queue:reloaded}=await makeRelay({
    file,mcpToken:SERVER_TOKEN,devices:{desktop:DEVICE_TOKEN},
  });
  assert.equal(reloaded.deviceStatus('desktop').online,false,
    'after process restart old persisted heartbeat cannot count as a live connection');
  assert.equal(reloaded.deviceStatus('desktop').active_revision,REV);
  second.close();
});
