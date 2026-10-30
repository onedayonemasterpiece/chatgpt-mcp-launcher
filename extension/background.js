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
      trigger:['manual','install','scheduled'].includes(updater?.trigger) ? updater.trigger : 'unknown',
    },
  };
}
// The local Windows sync helper writes this marker only after git fast-forward succeeds.
// Chrome re-reads the unpacked extension's local resource and reloads itself.
// No executable code is downloaded or evaluated at runtime.
async function checkDevReload({fromPoll=false}={}) {
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
    if(pendingReport || (polling && !fromPoll)) return {pending:true};
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
  // ChatGPT can stay "loading" for minutes while its analytics requests hang.
  // After 30 seconds on a committed chatgpt.com page, go on: the page driver
  // waits for the composer itself. Fail only if the page never arrived.
  for(let i=0;i<450;i++) {
    const tab=await chrome.tabs.get(tabId);
    if(tab.status==='complete') return;
    if(i>=150 && /^https:\/\/chatgpt\.com\//.test(tab.url||'')) return;
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error('ChatGPT page did not open within 90 seconds');
}
async function waitAfterOpening() {
  // Give the newly opened or focused chat a short, varied settling interval
  // before the page driver starts interacting with it.
  const ms=1500+Math.floor(Math.random()*2001);
  await new Promise(resolve=>setTimeout(resolve,ms));
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
function isNewChatTab(url) {
  try {const u=new URL(url);return u.origin==='https://chatgpt.com' && u.pathname==='/' && !u.search && !u.hash;}
  catch {return false;}
}
async function openChatTab(job,{fresh=false}={}) {
  // Reuse the tab that is already open: the same conversation, or for a new
  // chat an empty "New chat" page. Never navigate an unrelated ChatGPT tab;
  // the page driver refuses to overwrite an unsent draft.
  if(!fresh) {
    const candidates=await chrome.tabs.query({url:'https://chatgpt.com/*'});
    const match=job.action==='start' ?
      candidates.filter(t=>Number.isInteger(t.id) && isNewChatTab(t.url) && t.status==='complete').at(-1) :
      candidates.find(t=>Number.isInteger(t.id) && sameConversationUrl(t.url,job.chat_url));
    if(match) {
      await chrome.tabs.update(match.id,{active:true});
      if(Number.isInteger(match.windowId)) await chrome.windows.update(match.windowId,{focused:true});
      return {...match,reused:true};
    }
  }
  const tab=await chrome.tabs.create({url:job.action==='start'?'https://chatgpt.com/':job.chat_url,active:true});
  // An active tab can still belong to an unfocused Chrome window.
  if(Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId,{focused:true});
  return tab;
}
function driverScript() {
  return BOOT_BUILD?.driver_file && /^page-driver-[a-f0-9]{40}\.js$/.test(BOOT_BUILD.driver_file) ? BOOT_BUILD.driver_file : 'page-driver.js';
}
async function runDriver(script,tab,payload) {
  const invoke=async()=>{
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:[script]});
    const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},
      func:async payload=>payload.action==='probe' ? globalThis.chatGPTLauncherProbe() :
        payload.action==='read' ? globalThis.chatGPTLauncherRead(payload) :
        payload.action==='reconcile' ? globalThis.chatGPTLauncherReconcile(payload) :
        payload.action==='book_stop' ? globalThis.chatGPTLauncherStopBook(payload) :
        globalThis.chatGPTLauncherRun(payload),args:[payload]});
    return result;
  };
  if(!['read','reconcile','probe','book_stop'].includes(payload.action)) return invoke();
  // Composer (90s) + history (60s) + settling (1s), with Chrome API headroom.
  let timer;
  try {
    return await Promise.race([invoke(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(payload.action==='book_stop' ?
        'Book Stop observation timed out; outcome unconfirmed' :
        'Read-only browser inspection timed out; no prompt submitted')),180000);
    })]);
  } finally {clearTimeout(timer);}
}
async function closeChat(job,script) {
  // Optional housekeeping: never close a tab holding someone's unsent draft
  // or a reply that ChatGPT is still writing.
  const tabs=(await chrome.tabs.query({url:'https://chatgpt.com/*'}))
    .filter(t=>Number.isInteger(t.id) && sameConversationUrl(t.url,job.chat_url));
  if(!tabs.length) return {status:'closed',chat_url:job.chat_url,message:'No open tab for this conversation'};
  let closed=0; const kept=[];
  for(const tab of tabs) {
    let probe=null;
    try {probe=(await runDriver(script,tab,{action:'probe'}))?.result;} catch {}
    if(!probe) kept.push('page not ready');
    else if(probe.draft) kept.push('unsent draft');
    else if(probe.answering) kept.push('ChatGPT still answering');
    else {await chrome.tabs.remove(tab.id);closed++;}
  }
  if(!closed) return {status:'blocked',chat_url:job.chat_url,message:'Tab left open: '+kept.join(', ')+'; try again later'};
  return {status:kept.length?'blocked':'closed',chat_url:job.chat_url,
    message:`Closed ${closed} tab(s)`+(kept.length?`; left open: ${kept.join(', ')}`:'')};
}
function validPluginUrl(url) {
  try {const u=new URL(url);return u.origin==='https://chatgpt.com' && /^\/settings\/plugins-settings\/plugin_[a-z0-9_]+$/i.test(u.pathname) && !u.search && !u.hash;}
  catch {return false;}
}
// Runs inside the plugin settings page: press "Refresh tools" once and wait
// until ChatGPT re-enables the button (about 10 s on average).
async function pressRefreshTools() {
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const label=/^(обновить инструменты|refresh tools|update tools)$/i;
  const find=()=>[...document.querySelectorAll('button')].find(b=>label.test((b.textContent||'').trim()));
  let button=null;
  for(let i=0;i<60&&!button;i++){button=find();if(!button)await sleep(500);}
  if(!button) {
    const labels=[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length)
      .slice(0,12).map(b=>(b.textContent||b.getAttribute('aria-label')||'').trim().slice(0,60));
    return {status:'blocked',message:'Refresh tools button not found; nothing was pressed. Path: '+
      location.pathname+'; visible button labels: '+JSON.stringify(labels)};
  }
  button.click();
  await sleep(10000);
  let ready=false;
  for(let i=0;i<40&&!ready;i++){
    const b=find();
    ready=!!b&&!b.disabled&&b.getAttribute('aria-busy')!=='true';
    if(!ready) await sleep(500);
  }
  const notes=[...document.querySelectorAll('[role="alert"],[role="status"]')]
    .map(n=>(n.textContent||'').trim()).filter(Boolean).join(' | ').slice(0,300);
  // A button still busy after 30 s is not proof of success: say so, keep the tab.
  return ready ? {status:'refreshed',message:'Refresh tools pressed and finished'+(notes?': '+notes:'')} :
    {status:'needs_review',message:'Refresh tools pressed, but the button did not become ready within 30 s; check the plugin page'+(notes?': '+notes:'')};
}
async function refreshPluginTools(job) {
  if(!validPluginUrl(job.chat_url))throw Error('Invalid ChatGPT plugin settings URL');
  const tab=await chrome.tabs.create({url:job.chat_url,active:true});
  if(Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId,{focused:true});
  await awaitTab(tab.id);
  const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:pressRefreshTools,args:[{action:'refresh_tools'}]});
  const out=result?.result&&typeof result.result.status==='string'?result.result:
    {status:'needs_review',message:'No result from the plugin page; check whether tools were refreshed'};
  if(out.status==='refreshed') await chrome.tabs.remove(tab.id);
  return {status:out.status,chat_url:null,message:out.message||''};
}
async function execute(job) {
  if(job.action==='refresh_tools') return refreshPluginTools(job);
  if(!['start','continue','open','read','close','reconcile','book_stop'].includes(job.action))throw Error('Unsupported browser action');
  const prompt=['open','read','close','reconcile','book_stop'].includes(job.action)?null:preparePrompt(job);
  if(job.action!=='start'&&!validChatUrl(job.chat_url))throw Error('Invalid ChatGPT conversation URL');
  if(job.action==='close') return closeChat(job,driverScript());
  if(job.action==='book_stop') {
    const tabs=(await chrome.tabs.query({url:'https://chatgpt.com/*'}))
      .filter(t=>Number.isInteger(t.id)&&sameConversationUrl(t.url,job.chat_url));
    if(tabs.length>1)return {status:'blocked',chat_url:job.chat_url,message:'Exact book tab is ambiguous'};
    const tab=tabs[0]||await openChatTab(job);
    await awaitTab(tab.id);
    const observed=(await runDriver(driverScript(),tab,job))?.result;
    if(!observed||!['stopped','read','blocked','needs_review'].includes(observed.status))
      return {status:'needs_review',chat_url:job.chat_url,message:'Book Stop result not confirmed'};
    return {status:observed.status,chat_url:observed.chat_url||null,message:observed.message||'',
      execution_evidence:observed.execution_evidence==='page_completed'?'page_completed':'unknown'};
  }
  const tab=await openChatTab(job);
  await awaitTab(tab.id);
  if(job.action==='open')return {status:'opened',chat_url:job.chat_url,
    message:'ChatGPT tab opened or reused; no prompt submitted or model response read'};
  const script=driverScript();
  let result;
  if(job.action==='start'||job.action==='continue') await waitAfterOpening();
  try { result=await runDriver(script,tab,{...job,prompt}); }
  catch(err) {
    // A single Send click can navigate/unmount Chrome's execution frame before
    // executeScript returns. Re-inject READ-ONLY into the live frame: an exact
    // job marker proves delivery; an unreadable or absent marker stays unknown.
    if(!['start','continue'].includes(job.action) || !/frame.*removed|frame.*navigat/i.test(String(err.message||err))) throw err;
    try {
      await awaitTab(tab.id);
      const probe=await runDriver(script,tab,{action:'reconcile',verify_job_id:job.id});
      const observed=probe?.result;
      if(observed?.delivery_evidence==='sent' &&
          (job.action==='start'?validChatUrl(observed.chat_url):sameConversationUrl(observed.chat_url,job.chat_url))) {
        return {status:'sent',chat_url:observed.chat_url,
          message:'Delivery recovered after frame navigation from a visible per-job marker; no retry'};
      }
    } catch {} // Recovery itself is advisory: NEVER send or assume not sent.
    throw err;
  }
  if(job.action==='start' && result?.result?.reason==='draft') {
    // A reused "New chat" tab holds someone's unsent draft; nothing was typed
    // there, so start once more in a fresh tab instead of blocking.
    const fresh=await openChatTab(job,{fresh:true});
    await awaitTab(fresh.id);
    await waitAfterOpening();
    result=await runDriver(script,fresh,{...job,prompt});
  }
  if(!result?.result||typeof result.result.status!=='string')throw Error('Missing browser action result');
  const out={status:result.result.status,chat_url:result.result.chat_url||null,
    ...(result.result.page_state&&typeof result.result.page_state==='object'?{page_state:result.result.page_state}:{}),
    ...(result.result.dom_probe&&typeof result.result.dom_probe==='object'?{dom_probe:result.result.dom_probe}:{}),
    message:result.result.message||''};
  if(job.action==='reconcile') {
    out.delivery_evidence=result.result.delivery_evidence==='sent'?'sent':'unknown';
    out.evidence_kind=['user_message_marker','conversation_marker'].includes(result.result.evidence_kind)?
      result.result.evidence_kind:'unconfirmed';
    out.execution_evidence=result.result.execution_evidence==='page_completed'?'page_completed':'unknown';
  }
  if(job.action==='read') {
    out.reply_text=typeof result.result.reply_text==='string' ? result.result.reply_text.slice(0,20000) : null;
    out.reply_generating=result.result.reply_generating===true;
    out.last_user_text=typeof result.result.last_user_text==='string' ? result.result.last_user_text.slice(0,2000) : null;
  }
  return out;
}
async function flushPending(config) {
  const {pendingReport}=await api.get('pendingReport');
  if(!pendingReport) return;
  const {job_id,status,chat_url,message,reply_text,reply_generating,last_user_text,page_state,dom_probe,delivery_evidence,evidence_kind,execution_evidence}=pendingReport;
  try {await relayFetch(config,'POST','/device/report',{job_id,status,chat_url,message,reply_text,reply_generating,last_user_text,page_state,dom_probe,delivery_evidence,evidence_kind,execution_evidence});}
  catch(err) {
    // A report the relay refuses outright would be resent forever and block
    // heartbeats and every later job. Network errors and 401 stay pending.
    if(!/^Relay HTTP 400:/.test(err.message)) throw err;
    await api.set({pendingReport:null,lastResult:{job_id,status,chat_url,message,
      rejected:String(err.message).slice(0,200),at:new Date().toISOString()}});
    return;
  }
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
    // Activate newly installed files here, where no job is running. The separate
    // revision alarm fires together with this one and then always sees a poll in
    // progress, so on its own it may never get a turn.
    if(version.update_state!=='current') await checkDevReload({fromPoll:true});
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
        installed_revision:typeof updater?.installed_revision==='string' ? updater.installed_revision : null,
        trigger:['manual','install','scheduled'].includes(updater?.trigger) ? updater.trigger : 'unknown'};
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
