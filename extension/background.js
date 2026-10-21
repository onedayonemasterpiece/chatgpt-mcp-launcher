// An untracked, generated build-info.js is loaded *into this worker* at
// startup. Unlike a file-marker read on every poll, this is the running build.
// Windows Git sync writes it after a verified fast-forward and before marker.
try { if(typeof importScripts==='function') importScripts('build-info.js'); } catch {}
const BOOT_BUILD=globalThis.CHATGPT_LAUNCHER_BUILD || null;
const WORKER_LOADED_AT=new Date().toISOString();
const VALID_SHA=/^[a-f0-9]{40}$/;
const VALID_SHA256=/^[a-f0-9]{64}$/;
const ALARM = 'chatgpt-mcp-launcher-poll';
const REVISION_ALARM = 'chatgpt-mcp-launcher-revision';
let polling = false;
const api = {get: keys=>chrome.storage.local.get(keys),set: value=>chrome.storage.local.set(value)};

function validateBase(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash) throw new Error('Relay URL must not contain credentials, query or hash');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) {
    throw new Error('HTTPS is required except for local testing');
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}
async function readLocalJson(file) {
  try {
    const response=await fetch(chrome.runtime.getURL(file)+'?v='+Date.now(),{cache:'no-store'});
    if(!response.ok) return null;
    return await response.json();
  } catch {return null;}
}
async function fileSha256(file) {
  const response=await fetch(chrome.runtime.getURL(file)+'?v='+Date.now(),{cache:'no-store'});
  if(!response.ok) return null;
  const bytes=await response.arrayBuffer();
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
async function runningVersion() {
  const marker=await readLocalJson('dev-revision.json');
  const updater=await readLocalJson('updater-status.json');
  const active=VALID_SHA.test(BOOT_BUILD?.revision||'') ? BOOT_BUILD.revision : null;
  const installed=VALID_SHA.test(marker?.revision||'') ? marker.revision : null;
  let integrity='unknown';
  const file=BOOT_BUILD?.driver_file;
  if(active && /^page-driver-[a-f0-9]{40}\.js$/.test(file||'') &&
      VALID_SHA256.test(BOOT_BUILD?.driver_sha256||'') &&
      VALID_SHA256.test(BOOT_BUILD?.background_sha256||'')) {
    try {
      const [background,driver]=await Promise.all([
        fileSha256('background.js'),fileSha256(file),
      ]);
      integrity=(background===BOOT_BUILD.background_sha256 &&
        driver===BOOT_BUILD.driver_sha256) ? 'ok' : 'mismatch';
    } catch {integrity='mismatch';}
  }
  return {
    active_revision:active,installed_revision:installed,
    manifest_version:chrome.runtime.getManifest?.().version || 'unknown',
    runtime_integrity:integrity,
    runtime_loaded_at:WORKER_LOADED_AT,
    update_state:active && installed && active===installed && integrity==='ok' ?
      'current' : !active ? 'unverified' : 'pending_or_mismatch',
    updater:{
      state:['current','updated','error','checking'].includes(updater?.state) ? updater.state : 'unknown',
      checked_at:typeof updater?.checked_at==='string' ? updater.checked_at : null,
      error_code:typeof updater?.error_code==='string' ? updater.error_code : null,
      check_id:typeof updater?.check_id==='string' && /^[a-f0-9]{32}$/i.test(updater.check_id) ? updater.check_id : null,
      started_at:typeof updater?.started_at==='string' ? updater.started_at : null,
    },
  };
}
// The local Windows sync helper writes this marker only after git fast-forward succeeds.
// Chrome re-reads the unpacked extension's local resource and reloads itself.
// No executable code is downloaded or evaluated at runtime.
async function checkDevReload() {
  try {
    const data=await readLocalJson('dev-revision.json');
    if(!data) return {notInstalled:true};
    if(!VALID_SHA.test(data.revision||'')) return {invalidMarker:true};
    const {appliedDevRevision,pendingReport,lastReloadAttempt}=await api.get(
      ['appliedDevRevision','pendingReport','lastReloadAttempt']);
    // BOOT_BUILD is captured when the worker actually loads, not from disk.
    const active=BOOT_BUILD ? BOOT_BUILD.revision : appliedDevRevision;
    const legacyMarker=!BOOT_BUILD && data.schema_version!==2;
    if(data.revision===active && (BOOT_BUILD||legacyMarker)) {
      if(BOOT_BUILD && lastReloadAttempt) await api.set({lastReloadAttempt:null,appliedDevRevision:active});
      return {current:true,active_revision:active};
    }
    if(pendingReport || polling) return {pending:true};
    // Avoid infinite reload loops if Chrome cannot load the new code.
    if(lastReloadAttempt?.revision===data.revision &&
      Date.now()-Date.parse(lastReloadAttempt.at||'')<300000) {
      return {reload_stalled:true,target_revision:data.revision};
    }
    const attempt={revision:data.revision,at:new Date().toISOString()};
    await api.set({lastReloadAttempt:attempt,...(!BOOT_BUILD?{appliedDevRevision:data.revision}:{})});
    chrome.runtime.reload();
    return {reloading:true,target_revision:data.revision};
  } catch (err) {return {error:String(err?.message || err).slice(0,160)};}
}
async function armDevReload() {
  await chrome.alarms.create(REVISION_ALARM,{periodInMinutes:0.5});
}
async function setAlarm() {
  const { config } = await api.get('config');
  // Version heartbeat continues even with command acceptance switched off.
  if (!config?.token || !config?.url) return chrome.alarms.clear(ALARM);
  // MV3 service workers are ephemeral. Alarms reawaken them when Chrome is open.
  await chrome.alarms.create(ALARM, {periodInMinutes:0.5});
}
async function relayFetch(config,method,path,body) {
  const controller = new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  try {
    const revision=VALID_SHA.test(BOOT_BUILD?.revision||'') ? BOOT_BUILD.revision : 'unknown';
    const response=await fetch(validateBase(config.url)+path,{
      method,cache:'no-store',signal:controller.signal,
      headers:{'Authorization':`Bearer ${config.token}`,'X-Launcher-Device-Id':config.deviceId,
        'X-Launcher-Revision':revision,
        ...(body ? {'Content-Type':'application/json'}:{})},
      ...(body ? {body:JSON.stringify(body)} : {}),
    });
    const data=await response.json();
    if(!response.ok) throw new Error(`Relay HTTP ${response.status}: ${data.error||'unknown'}`);
    return data;
  } finally {clearTimeout(timeout);}
}
async function awaitTab(tabId) {
  for(let i=0;i<50;i++) {
    const tab=await chrome.tabs.get(tabId);
    if(tab.status==='complete') return;
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error('ChatGPT tab load timeout');
}
function validChatUrl(url) {
  try {const u=new URL(url);return u.origin==='https://chatgpt.com' && /^\/(?:g\/[^/]+\/)?c\/[a-z0-9-]+\/?$/i.test(u.pathname) && !u.search && !u.hash;}
  catch {return false;}
}
function preparePrompt(job) {
  if(typeof job.prompt !== 'string' || !job.prompt.trim() || job.prompt.length>30000) throw new Error('Invalid job prompt');
  let prompt=job.prompt;
  if(job.slack_thread_url) {
    const u=new URL(job.slack_thread_url);
    if(u.protocol!=='https:' || !/^[a-z0-9-]+\.slack\.com$/i.test(u.hostname) || !u.pathname.startsWith('/archives/')) {
      throw new Error('Invalid Slack thread URL');
    }
    prompt += '\n\nПо завершении задачи опубликуй результат в треде Slack: '+job.slack_thread_url+
      '. Используй доступный инструмент Slack. Если он недоступен, напиши об этом в чате; не утверждай, что сообщение отправлено без подтверждения.';
  }
  return prompt;
}
function sameConversationUrl(a,b) {
  if(!validChatUrl(b)) return false;
  try {
    const actual=new URL(a), expected=new URL(b);
    return actual.origin===expected.origin &&
      actual.pathname.replace(/\/+$/,'')===expected.pathname.replace(/\/+$/,'');
  } catch {return false;}
}
async function openChatTab(job) {
  // Reuse the *same conversation* in the user's logged-in Chrome; never
  // navigate an unrelated ChatGPT tab or overwrite its unsent draft.
  if(job.action==='continue') {
    const candidates=await chrome.tabs.query({url:'https://chatgpt.com/*'});
    const match=candidates.find(t=>Number.isInteger(t.id) && sameConversationUrl(t.url,job.chat_url));
    if(match) {
      await chrome.tabs.update(match.id,{active:true});
      if(Number.isInteger(match.windowId)) await chrome.windows.update(match.windowId,{focused:true});
      return match;
    }
  }
  return chrome.tabs.create({url:job.action==='start'?'https://chatgpt.com/':job.chat_url,active:true});
}
async function execute(job) {
  const prompt=preparePrompt(job);
  if(job.action==='continue' && !validChatUrl(job.chat_url)) throw new Error('Invalid ChatGPT continuation URL');
  const tab=await openChatTab(job);
  await awaitTab(tab.id);
  const script=BOOT_BUILD?.driver_file && /^page-driver-[a-f0-9]{40}\.js$/.test(BOOT_BUILD.driver_file) ? BOOT_BUILD.driver_file : 'page-driver.js';
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:[script]});
  const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async job=>globalThis.chatGPTLauncherRun(job),args:[{...job,prompt}]});
  return {status:result.result.status,chat_url:result.result.chat_url||null,message:result.result.message||''};
}
async function flushPending(config) {
  const {pendingReport}=await api.get('pendingReport');
  if(!pendingReport) return;
  const {job_id,status,chat_url,message}=pendingReport;
  await relayFetch(config,'POST','/device/report',{job_id,status,chat_url,message});
  await api.set({pendingReport:null,lastResult:{job_id,status,chat_url,message,at:new Date().toISOString()}});
}
async function sendHeartbeat(config) {
  const version=await runningVersion();
  const status={
    type:'heartbeat',schema_version:1,
    commands_enabled:!!config.enabled,
    active_revision:version.active_revision || 'unknown',
    installed_revision:version.installed_revision || 'unknown',
    manifest_version:version.manifest_version,
    runtime_integrity:version.runtime_integrity,
    runtime_loaded_at:version.runtime_loaded_at,
    updater:version.updater,
  };
  const response=await relayFetch(config,'POST','/device/report',status);
  if(!response.ok) throw new Error('Heartbeat was not acknowledged');
  await api.set({lastHeartbeatAt:new Date().toISOString(),
    lastReportedRevision:response.reported_revision||null,lastError:null});
  return version;
}
async function poll() {
  if(polling) return {busy:true};
  polling=true;
  try {
    const {config}=await api.get('config');
    if(!config?.token || !config?.url) return {unconfigured:true};
    await flushPending(config);
    const version=await sendHeartbeat(config);
    if(!config.enabled) return {commands_disabled:true,heartbeat_sent:true,version};
    if(version.update_state!=='current') return {
      commands_blocked:true,reason:'Running version is not verified against installed files',
      heartbeat_sent:true,version,
    };
    const data=await relayFetch(config,'GET','/device/poll');
    const job=data.job;
    if(!job) return {idle:true,heartbeat_sent:true,version};
    await api.set({pendingReport:{job_id:job.id,status:'needs_review',
      message:'Browser action interrupted; verify before retrying'}});
    let result;
    try {result=await execute(job);}
    catch(err) {result={status:'needs_review',
      message:'Automation failed or was interrupted: '+err.message+'. Check the tab before retrying.'};}
    await api.set({pendingReport:{job_id:job.id,...result}});
    await flushPending(config);
    return {job_id:job.id,...result,version};
  } catch(err) {
    await api.set({lastError:{message:String(err.message||err).slice(0,350),at:new Date().toISOString()}});
    return {error:String(err.message||err)};
  } finally {polling=false;}
}
chrome.runtime.onInstalled.addListener(()=>{void setAlarm();void armDevReload();void poll();});
chrome.runtime.onStartup.addListener(()=>{void setAlarm();void armDevReload();void poll();});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name===ALARM) void poll();
  if(alarm.name===REVISION_ALARM) void checkDevReload();
});
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  (async()=>{
    if(message.type==='CONFIGURE') {
      const c=message.config;
      validateBase(c.url);
      if(!c.token || c.token.length<24 || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.deviceId)) throw new Error('Invalid token or device ID');
      await api.set({config:c,lastError:null});await setAlarm();
      return {ok:true};
    }
    if(message.type==='POLL_NOW') return await poll();
    if(message.type==='PING') {
      const {config}=await api.get('config');
      if(!config) throw new Error('First configure the relay');
      return await sendHeartbeat(config); // Read-only, never claims queued work.
    }
    if(message.type==='GET_UPDATE_STATUS') {
      // A tiny local file only, no GitHub network call or repeated file hashes.
      const updater=await readLocalJson('updater-status.json');
      return {state:updater?.state||'unknown',
        check_id:typeof updater?.check_id==='string' ? updater.check_id : null,
        checked_at:typeof updater?.checked_at==='string' ? updater.checked_at : null,
        error_code:typeof updater?.error_code==='string' ? updater.error_code : null,
        installed_revision:typeof updater?.installed_revision==='string' ? updater.installed_revision : null};
    }
    if(message.type==='GET_VERSION') {
      const version=await runningVersion();
      const {config,lastHeartbeatAt,lastError,pendingReport}=await api.get(
        ['config','lastHeartbeatAt','lastError','pendingReport']);
      return {...version,accepting_commands:!!config?.enabled,
        last_heartbeat_at:lastHeartbeatAt||null,last_connection_error:lastError?.message||null,
        pending_send:!!pendingReport};
    }
    throw new Error('Unknown action');
  })().then(reply,err=>reply({error:err.message}));
  return true;
});
void setAlarm();
void armDevReload();
