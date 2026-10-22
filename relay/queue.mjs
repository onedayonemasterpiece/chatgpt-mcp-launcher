import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {MAX_CHATS,canonicalChatUrl,chatIdFromUrl,referenceToUrl,recordedChat} from './conversations.mjs';
import {DeliveryError,EVENT_DEFINITIONS,JOB_EVENT,REMINDER_EVENT,eventId,subscriptionId,validSecret} from './events.mjs';

const EFFORTS = ['auto', 'medium', 'high', 'xhigh'];
const REPORT_STATES = ['sent','opened','read','closed','blocked','failed','needs_review'];
const MAX_REPLY = 20_000;
// No job may stay "in progress" forever: after this long it gets a final status.
const STALE_MS = 15 * 60_000;
const TERMINAL = ['sent','opened','read','closed','blocked','failed','needs_review','expired'];
const MAX_JOBS = 500;
const MAX_PROMPT = 30_000;
const SHA40 = /^[a-f0-9]{40}$/;
const UPDATER_STATES = ['current','updated','error','checking','unknown'];
const asRevision = s => typeof s==='string' && SHA40.test(s) ? s : null;
const safeDate = s => typeof s==='string' && s.length <= 40 && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;

export function validChatUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' &&
      /^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

// blocked: the agent stopped because it needs a decision (summary says which, from whom).
const MODEL_STATES = ['started','progress','done','failed','blocked'];
const MODEL_FINAL = ['done','failed','blocked'];
// Statuses that always produce a job_update event for subscribers.
const NOTIFY_STATUSES = ['blocked','failed','needs_review','expired','closed'];
const MAX_SUBSCRIPTION_MS = 86_400_000;
const MAX_OUTBOX = 1000;
const MAX_ATTEMPTS = 5;
const iso = ms => ms ? new Date(ms).toISOString() : null;
// Appended to every prompt Chrome sends: the ChatGPT conversation itself
// confirms through MCP that it got the prompt and reports its result.
// This needs no reading of the ChatGPT page.
// The ChatGPT app (this MCP server) as it is named in the owner's ChatGPT.
export const APP_NAME = 'Chatgpt task lancher';
export function callbackFooter(jobId) {
  // One short line; the extension then mentions the app itself (job.mention).
  return ' (Служебное: сразу вызови chatgpt_report приложения '+APP_NAME+' с job_id='+jobId+
    ' status=started, в конце status=done и summary; если нужно чьё-то решение — status=blocked и в summary какое и от кого.)';
}

// One plain instruction per state, so a calling agent always knows what to do next.
function nextStep(job) {
  switch(job.status) {
    case 'queued': case 'claimed':
      return 'In progress in the owner\'s Chrome. Call chatgpt_task_status again in about 20 seconds. Do not repeat the request. '+
        'If Chrome does not finish within 15 minutes, the job gets a final status automatically.';
    case 'expired':
      return 'Chrome did not pick this job up within 15 minutes, so nothing was sent. Check chatgpt_device_status, then repeat the call with a new request_id.';
    case 'sent':
      if(job.model_status==='blocked') return 'The agent is BLOCKED and needs a decision: model_summary says which and from whom. '+
        'Pass that exact question to the owner now (do not just wait), then pause the coordination with that reason.';
      if(job.model_status==='done') return 'ChatGPT finished: model_summary holds its own short result.';
      if(job.model_status==='failed') return 'ChatGPT reported it could not do the task: see model_summary.';
      if(job.model_status==='started') return 'ChatGPT confirmed it started working. Check chatgpt_task_status again in a few minutes for model_status = done.';
      return 'Delivered. ChatGPT has been asked to confirm via MCP (model_status started, then done with model_summary). Check chatgpt_task_status again in about a minute.';
    case 'closed':
      return 'The tab is closed to save memory. The conversation itself stays in ChatGPT: chatgpt_continue with this chat_id reopens it.';
    case 'opened':
      return 'The conversation is open in Chrome. Nothing was sent.';
    case 'read':
      if(job.reply_generating) return 'ChatGPT is still writing. Call chatgpt_read_reply again in about 30 seconds.';
      // last_user_text tells whether a prompt sent earlier actually arrived.
      return job.reply_text ? 'reply_text holds the last ChatGPT reply.' :
        'No reply yet. If a prompt was just sent, call chatgpt_read_reply again in about 30 seconds.';
    case 'blocked':
      if(job.fallback_job_id) return 'Nothing was sent in this chat, so the launcher already started the same prompt in a NEW chat: follow chatgpt_task_status('+
        job.fallback_job_id+'); its chat_id is this line of work from now on. Do not retry here.';
      return 'Nothing was sent. Read message for the reason; once it is resolved, chatgpt_retry(job_id) sends the exact same prompt again into the same chat.';
    case 'needs_review':
      return 'The prompt may or may not have been sent. Do NOT resend blindly: call chatgpt_read_reply for this chat and compare last_user_text with your prompt. '+
        'If it is there, it was sent; if not, send it with chatgpt_continue and a new request_id.';
    default:
      return 'Failed. Read message and report it to the owner.';
  }
}

// Only known keys with plain values: what the window looked like, never page text.
function pageState(raw) {
  if(!raw||typeof raw!=='object') return undefined;
  const pick=(v,allowed)=>allowed.includes(v)?v:'unknown';
  const count=v=>Number.isInteger(v)&&v>=0&&v<100000?v:null;
  return {url_kind:pick(raw.url_kind,['conversation','other']),composer:pick(raw.composer,['present','missing','ambiguous']),
    composer_text:pick(raw.composer_text,['empty','our_prompt','other_draft']),answering:raw.answering===true,
    connection_lost:raw.connection_lost===true,user_messages:count(raw.user_messages),assistant_messages:count(raw.assistant_messages)};
}

const PROBE_KEYS=['author_any','author_assistant','author_user','article','turn_testid','message_id','markdown',
  'turn_assistant','turn_user','stop_testid','stop_aria','send_testid','send_aria'];
function domProbe(raw) {
  if(!raw||typeof raw!=='object') return undefined;
  const counts={};
  for(const k of PROBE_KEYS) counts[k]=Number.isInteger(raw.counts?.[k])?raw.counts[k]:null;
  const str=v=>typeof v==='string'?v.slice(0,60):'';
  const buttons=Array.isArray(raw.composer_buttons)?raw.composer_buttons.slice(0,12).map(b=>({testid:str(b?.testid),aria:str(b?.aria),
    id:str(b?.id),disabled:b?.disabled===true})):[];
  const testids=Array.isArray(raw.testids)?raw.testids.slice(0,80).map(str):[];
  const layout={};
  for(const k of ['elements','main','iframes','shadow_roots','role_article','role_log','prose'])
    layout[k]=Number.isInteger(raw.layout?.[k])?raw.layout[k]:null;
  return {counts,composer_buttons:buttons,testids,layout};
}

function requireString(value, name, maxLen = 256) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLen) {
    throw new Error(`${name} must be a nonempty string <= ${maxLen} chars`);
  }
  return value.trim();
}

export class FileQueue {
  #state = { jobs: [], device_status: {}, chats: [], subscriptions: [], outbox: [], coordination: null };
  #serial = Promise.resolve();
  // silenceMs: no report from the agent for this long after started/progress
  // means "unconfirmed"; confirmMs: the same for a sent prompt never confirmed.
  constructor(file, devices, {now=()=>Date.now(),silenceMs=30*60_000,confirmMs=10*60_000,seal=null}={}) {
    this.file = file;
    this.devices = devices;
    this.now = now;
    this.silenceMs = silenceMs;
    this.confirmMs = confirmMs;
    this.seal = seal;
    this.deviceObservations = new Map();
    this.lastPersistedHeartbeat = new Map();
    this.seenThisProcess = new Set();
    this.verifiedThisProcess = new Set();
  }
  observeDevice(deviceId, reportedRevision = 'unknown') {
    if (!Object.hasOwn(this.devices, deviceId)) throw new Error('Unknown device');
    this.seenThisProcess.add(deviceId);
    const previous=this.deviceObservations.get(deviceId)||{};
    this.deviceObservations.set(deviceId,{
      ...previous,
      last_seen_at:new Date().toISOString(),
      // Legacy header is not trustworthy evidence of which worker is loaded.
      revision:previous.active_revision || asRevision(reportedRevision) || 'unknown',
    });
  }
  async observeHeartbeat(deviceId, data, reportedRevision) {
    return this.#run(async()=>{
      if (!Object.hasOwn(this.devices,deviceId)) throw new Error('Unknown device');
      if (data?.type!=='heartbeat' || data.schema_version!==1 ||
        typeof data.commands_enabled!=='boolean' ||
        !['ok','mismatch','unknown'].includes(data.runtime_integrity)) {
        throw new Error('Invalid device heartbeat contract');
      }
      for(const key of ['active_revision','installed_revision']) {
        if(data[key]!==null && data[key]!=='unknown' && !asRevision(data[key])) {
          throw new Error('Invalid '+key);
        }
      }
      const active=asRevision(data.active_revision);
      if(active && asRevision(reportedRevision) && active!==asRevision(reportedRevision)) {
        throw new Error('Runtime revision/header mismatch');
      }
      const installed=asRevision(data.installed_revision);
      const manifest=typeof data.manifest_version==='string' &&
        /^\d{1,3}(?:\.\d{1,3}){1,3}$/.test(data.manifest_version) ?
        data.manifest_version : 'unknown';
      const updater=data.updater && typeof data.updater==='object' ? data.updater : {};
      const previous=this.deviceObservations.get(deviceId)||{};
      const current={
        last_seen_at:new Date().toISOString(),
        revision:active||'unknown',
        active_revision:active,
        installed_revision:installed,
        manifest_version:manifest,
        commands_enabled:data.commands_enabled,
        runtime_integrity:data.runtime_integrity,
        runtime_loaded_at:safeDate(data.runtime_loaded_at),
        updater_state:UPDATER_STATES.includes(updater.state)?updater.state:'unknown',
        updater_checked_at:safeDate(updater.checked_at),
        updater_trigger:['manual','scheduled','install'].includes(updater.trigger)?updater.trigger:null,
        updater_error:typeof updater.error_code==='string' &&
          /^[a-z0-9_-]{1,60}$/i.test(updater.error_code) ? updater.error_code : null,
        heartbeat_schema:1,
      };
      this.seenThisProcess.add(deviceId);
      this.verifiedThisProcess.add(deviceId);
      this.deviceObservations.set(deviceId,current);
      this.#state.device_status ||= {};
      this.#state.device_status[deviceId]=current;
      const persisted=this.lastPersistedHeartbeat.get(deviceId)||0;
      const changed=Object.entries(current).some(([key,val])=>
        key!=='last_seen_at' && previous[key]!==val);
      if(changed || Date.now()-persisted>=120_000) {
        await this.#save();
        this.lastPersistedHeartbeat.set(deviceId,Date.now());
      }
      return this.deviceStatus(deviceId);
    });
  }
  deviceStatus(deviceId) {
    if (!Object.hasOwn(this.devices, deviceId)) throw new Error('Unknown device');
    const observation = this.deviceObservations.get(deviceId) || null;
    const lastJob = [...this.#state.jobs].reverse().find(j=>j.device_id===deviceId);
    return {
      device_id:deviceId,
      online:this.seenThisProcess.has(deviceId) && !!observation && Date.now()-Date.parse(observation.last_seen_at)<120_000,
      last_seen_at:observation?.last_seen_at || null,
      revision:observation?.revision || null,
      active_revision:observation?.active_revision || null,
      heartbeat_current_session:this.verifiedThisProcess.has(deviceId),
      installed_revision:observation?.installed_revision || null,
      manifest_version:observation?.manifest_version || null,
      commands_enabled:observation?.commands_enabled ?? null,
      runtime_integrity:observation?.runtime_integrity || null,
      runtime_loaded_at:observation?.runtime_loaded_at || null,
      updater_state:observation?.updater_state || null,
      updater_checked_at:observation?.updater_checked_at || null,
      updater_trigger:observation?.updater_trigger || null,
      updater_error:observation?.updater_error || null,
      last_job:lastJob ? this.#public(lastJob) : null,
      events:this.eventsStatus(),
      coordination:this.coordinationStatus(),
    };
  }
  async initialize() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(parsed.jobs)) throw new Error('Invalid state');
      this.#state = {...parsed,device_status:parsed.device_status||{},chats:Array.isArray(parsed.chats)?parsed.chats:[],
        subscriptions:Array.isArray(parsed.subscriptions)?parsed.subscriptions:[],
        outbox:Array.isArray(parsed.outbox)?parsed.outbox:[],coordination:parsed.coordination||null};
      // A delivery interrupted by a restart is simply retried with the same eventId.
      for(const item of this.#state.outbox) if(item.state==='sending') item.state='pending';
      for(const old of parsed.jobs) {
        const url=canonicalChatUrl(old.result_chat_url);
        if(url && !this.#state.chats.some(c=>c.device_id===old.device_id&&c.chat_url===url))
          this.#recordChat(url,old.device_id,old.id,old.status);
      }
      for(const [deviceId,item] of Object.entries(this.#state.device_status)) {
        if(Object.hasOwn(this.devices,deviceId) && item && typeof item==='object') {
          this.deviceObservations.set(deviceId,item);
          this.lastPersistedHeartbeat.set(deviceId,Date.parse(item.last_seen_at)||0);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  async #save() {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
  #run(fn) {
    const promise = this.#serial.then(fn);
    this.#serial = promise.catch(() => undefined);
    return promise;
  }
  async enqueue(args) {
    return this.#run(async()=>{
      const action=args.action;
      if(!['start','continue','open','read','close'].includes(action))throw Error('Invalid action');
      const noPrompt=action==='open'||action==='read'||action==='close';
      const prompt=noPrompt?null:requireString(args.prompt,'prompt',MAX_PROMPT);
      // Default keeps the level already selected in ChatGPT (it remembers the last one).
      const effort=noPrompt?null:(args.effort??'auto');
      if(effort!==null&&!EFFORTS.includes(effort))throw Error('Invalid effort');
      const deviceId=args.device_id||'desktop';
      if(!Object.hasOwn(this.devices,deviceId))throw Error('Unknown device_id');
      const hasUrl=typeof args.chat_url==='string'&&args.chat_url.trim().length>0;
      const hasRef=typeof args.chat_ref==='string'&&args.chat_ref.trim().length>0;
      if(action!=='start' && (hasUrl===hasRef))throw Error('Exactly one chat_url or chat_ref is required');
      let target=null;
      if(action!=='start') {
        target=hasUrl?canonicalChatUrl(args.chat_url):this.resolveChat(args.chat_ref,deviceId);
        if(!target)throw Error('Unknown or invalid ChatGPT conversation reference. Pass the chat_id from chatgpt_task_status or chatgpt_list_chats, or a full https://chatgpt.com/c/... URL');
      }
      if(args.slack_thread_url!==undefined && !/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p[0-9]+(?:\?.*)?$/i.test(args.slack_thread_url))
        throw Error('Invalid Slack thread URL');
      const requestId=args.request_id===undefined?undefined:requireString(args.request_id,'request_id',128);
      if(requestId) {
        const existing=this.#state.jobs.find(j=>j.request_id===requestId&&j.device_id===deviceId);
        if(existing) {
          if(existing.action!==action||existing.prompt!==prompt||existing.chat_url!==target)
            throw Error('Idempotency key belongs to a different operation');
          return this.#public(existing);
        }
      }
      this.#expire(this.now());
      // Whether the agent is still working is known from its own reports, not
      // from the ChatGPT page (its markup changes and cannot be relied on).
      if(action==='continue') {
        const same=[...this.#state.jobs].reverse().filter(j=>(j.action==='start'||j.action==='continue')&&(j.result_chat_url||j.chat_url)===target);
        const pending=same.find(j=>j.status==='queued'||j.status==='claimed');
        if(pending) throw Error('A prompt to this chat is already on its way (job '+pending.id+'). Wait for its result instead of sending another.');
        const busy=same.find(j=>['started','progress'].includes(this.#execution(j)));
        if(busy) throw Error('The agent in this chat is still working (job '+busy.id+', '+this.#execution(busy)+'). '+
          'Wait for its job_update with done, failed or blocked: sending now would land in the middle of its answer. '+
          'If it goes silent it becomes unconfirmed and continuing is allowed again.');
      }
      if(this.#state.jobs.length>=MAX_JOBS) {
        const removable=this.#state.jobs.findIndex(j=>TERMINAL.includes(j.status));
        if(removable<0)throw Error('Queue capacity reached; review in-flight and uncertain work');
        this.#state.jobs.splice(removable,1);
      }
      const now=new Date(this.now()).toISOString();
      const job={
        id:randomUUID(),action,prompt,effort,device_id:deviceId,
        chat_url:target,slack_thread_url:args.slack_thread_url||null,
        request_id:requestId||null,status:'queued',created_at:now
      };
      this.#state.jobs.push(job);
      await this.#save();
      return this.#public(job);
    });
  }
  // Re-sends the exact stored prompt of a job that certainly sent nothing, into
  // the same chat. The caller never sees the prompt, so it cannot retype it;
  // the same text also lets Chrome recognise and replace its own unsent draft.
  async retry(jobId,requestId) {
    const original=this.#state.jobs.find(j=>j.id===jobId);
    if(!original) throw Error('Unknown job_id');
    if(original.action!=='start'&&original.action!=='continue') throw Error('Only start and continue jobs can be retried');
    if(!['blocked','expired','failed'].includes(original.status)) {
      throw Error(original.status==='needs_review' ?
        'This prompt may already have been sent: check with chatgpt_read_reply (last_user_text) instead of retrying' :
        'Only a job that sent nothing (blocked, expired, failed) can be retried; this one is '+original.status);
    }
    if(original.model_status) throw Error('ChatGPT already confirmed this prompt; nothing to retry');
    if(original.fallback_job_id) throw Error('Already restarted in a new chat as job '+original.fallback_job_id+'; follow that job');
    const job=await this.enqueue({action:original.action,prompt:original.prompt,effort:original.effort,
      device_id:original.device_id,slack_thread_url:original.slack_thread_url||undefined,
      ...(original.chat_url?{chat_url:original.chat_url}:{}),
      request_id:requestId||('retry-'+original.id)});
    return {...job,retry_of:original.id};
  }
  resolveChat(reference,deviceId='desktop') {
    const jobs=this.#state.jobs.filter(j=>j.device_id===deviceId);
    const chats=this.#state.chats.filter(c=>c.device_id===deviceId);
    return referenceToUrl(reference,chats,jobs);
  }
  listChats(deviceId='desktop',limit=20) {
    if(!Object.hasOwn(this.devices,deviceId))throw Error('Unknown device');
    if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('limit must be 1-50');
    const chats=this.#state.chats.filter(c=>c.device_id===deviceId);
    return {device_id:deviceId,total:chats.length,
      chats:chats.slice().sort((a,b)=>b.last_seen_at.localeCompare(a.last_seen_at)).slice(0,limit)};
  }
  #recordChat(chatUrl,deviceId,jobId,transport='observed') {
    const url=canonicalChatUrl(chatUrl);
    if(!url)return null;
    const i=this.#state.chats.findIndex(c=>c.chat_url===url&&c.device_id===deviceId);
    const previous=i>=0?this.#state.chats[i]:null;
    const next=recordedChat(url,deviceId,jobId,previous,new Date().toISOString(),transport);
    if(i>=0)this.#state.chats[i]=next;else this.#state.chats.push(next);
    if(this.#state.chats.length>MAX_CHATS) {
      this.#state.chats.sort((a,b)=>b.last_seen_at.localeCompare(a.last_seen_at));
      this.#state.chats.length=MAX_CHATS;
    }
    return next;
  }
  #public(job) {
    if (!job) return null;
    const {prompt, ...publicJob} = job;
    return {job_id:job.id,...publicJob,chat_id:chatIdFromUrl(job.result_chat_url||job.chat_url),
      execution:this.#execution(job),next_step:nextStep(job)};
  }
  // What is known about the work itself, separate from delivery of the prompt.
  // Only real reports from the agent count; silence is reported as such.
  #execution(job,now=this.now()) {
    if(job.action!=='start'&&job.action!=='continue') return null;
    if(MODEL_FINAL.includes(job.model_status)) return job.model_status;
    if(job.model_status==='started'||job.model_status==='progress') {
      return now-Date.parse(job.model_last_report_at||job.model_started_at)>this.silenceMs ? 'unconfirmed' : job.model_status;
    }
    if(['queued','claimed','blocked','expired','failed'].includes(job.status)) return 'not_started';
    if(job.status==='sent') return now-Date.parse(job.reported_at)>this.confirmMs ? 'unconfirmed' : 'awaiting_confirmation';
    return 'unknown';
  }
  #notifyJob(job,reason) {
    const execution=this.#execution(job);
    const summary=(MODEL_FINAL.includes(job.model_status) ? job.model_summary : job.message) || '';
    this.#emit(JOB_EVENT,[job.id,job.status,job.model_status||'',reason].join('|'),{
      job_id:job.id,request_id:job.request_id||null,fallback_job_id:job.fallback_job_id||null,fallback_of:job.fallback_of||null,
      page_state:job.page_state||null,
      chat_id:chatIdFromUrl(job.result_chat_url||job.chat_url),
      chat_url:job.result_chat_url||job.chat_url||null,action:job.action,status:job.status,execution,
      summary:String(summary).slice(0,500)});
  }
  // Queues one event per active subscription. The eventId is derived from what
  // happened, so the same fact never produces two different events.
  #emit(name,key,data) {
    const now=this.now();
    const id=eventId(name,key);
    const subscribers=this.#state.subscriptions.filter(s=>s.name===name&&s.state==='active'&&s.expires_at>now);
    if(!subscribers.length) {
      this.#state.events_without_subscriber=(this.#state.events_without_subscriber||0)+1;
      this.#state.last_event_without_subscriber={event_id:id,name,at:iso(now)};
    }
    for(const sub of subscribers) {
      if(this.#state.outbox.some(e=>e.event_id===id&&e.subscription_id===sub.id)) continue;
      this.#state.outbox.push({event_id:id,subscription_id:sub.id,name,timestamp:iso(now),
        data:{...data,at:iso(now)},state:'pending',attempts:0,next_at:now});
    }
    while(this.#state.outbox.length>MAX_OUTBOX) {
      const done=this.#state.outbox.findIndex(e=>e.state!=='pending');
      this.#state.outbox.splice(done>=0?done:0,1);
    }
  }
  listEvents() {return {events:EVENT_DEFINITIONS};}
  async subscribe(params,sender) {
    const {name,arguments:args={},delivery,ttlMs}=params||{};
    if(!EVENT_DEFINITIONS.some(e=>e.name===name)) throw new DeliveryError('unknown_event');
    const extra=args&&typeof args==='object'?Object.keys(args).filter(k=>!(k==='device_id'&&args[k]==='desktop')):[];
    if(extra.length) throw new DeliveryError('unexpected_arguments');
    if((delivery?.mode??'webhook')!=='webhook'||typeof delivery?.url!=='string') throw new DeliveryError('invalid_url');
    if(!validSecret(delivery.secret)) throw new DeliveryError('invalid_secret');
    if(ttlMs!==undefined&&ttlMs!==null&&!(Number.isInteger(ttlMs)&&ttlMs>0)) throw new DeliveryError('invalid_ttl');
    const id=subscriptionId(name,delivery.url);
    const old=this.#state.subscriptions.find(s=>s.id===id);
    const cached=old&&old.state==='active'&&old.verified_at>this.now()-300_000&&this.seal.open(old.secret)===delivery.secret;
    if(!cached) await sender.verify(delivery.url,id,delivery.secret);
    return this.#run(async()=>{
      const now=this.now();
      const expires=now+Math.min(ttlMs??MAX_SUBSCRIPTION_MS,MAX_SUBSCRIPTION_MS);
      const sub={...(old||{}),id,name,url:delivery.url,secret:this.seal.seal(delivery.secret),state:'active',
        verified_at:cached?old.verified_at:now,expires_at:expires,updated_at:now};
      const i=this.#state.subscriptions.findIndex(s=>s.id===id);
      if(i>=0)this.#state.subscriptions[i]=sub;else this.#state.subscriptions.push(sub);
      await this.#save();
      return {id,refreshBefore:iso(expires),cursor:null,truncated:false};
    });
  }
  async unsubscribe(params) {
    return this.#run(async()=>{
      const id=subscriptionId(params?.name,params?.delivery?.url);
      const sub=this.#state.subscriptions.find(s=>s.id===id);
      if(sub) {
        sub.state='inactive';
        for(const e of this.#state.outbox) if(e.subscription_id===id&&e.state==='pending') e.state='cancelled';
        await this.#save();
      }
      return {};
    });
  }
  // Sends at most one due event. Returns false when nothing is due.
  async deliverDue(sender) {
    const picked=await this.#run(async()=>{
      const now=this.now();
      const item=this.#state.outbox.find(e=>e.state==='pending'&&e.next_at<=now);
      if(!item) return null;
      const sub=this.#state.subscriptions.find(s=>s.id===item.subscription_id);
      if(!sub||sub.state!=='active'||sub.expires_at<=now) {
        Object.assign(item,{state:'cancelled',last_error:'subscription_inactive'});
        await this.#save();
        return {skip:true};
      }
      item.state='sending';
      item.attempts++;
      return {item,sub};
    });
    if(!picked) return false;
    if(picked.skip) return true;
    const {item,sub}=picked;
    let status=null,reason=null;
    try {
      ({status}=await sender.send(sub.url,sub.id,
        {eventId:item.event_id,name:item.name,timestamp:item.timestamp,cursor:null,data:item.data},this.seal.open(sub.secret)));
      if(status<200||status>=300) reason='http_'+status;
    } catch(err) {reason=err?.reason||'delivery_failed';}
    await this.#run(async()=>{
      const now=this.now();
      const accepted=!reason;
      // Same eventId on every attempt; no retry on 410/413 or other permanent errors.
      const retry=!accepted&&item.attempts<MAX_ATTEMPTS&&(status===null||status>=500||[408,425,429].includes(status));
      Object.assign(item,{state:accepted?'accepted':retry?'pending':'error',last_status:status,last_error:reason,
        next_at:now+Math.min(60_000,1000*2**item.attempts),...(accepted?{accepted_at:now}:{})});
      if(status===410) sub.state='gone';
      Object.assign(sub,{last_delivery_at:now,last_status:status,last_error:reason});
      await this.#save();
      console.log(JSON.stringify({event:'mcp_event_delivery',event_id:item.event_id,name:item.name,
        subscription_id:sub.id,attempt:item.attempts,status,reason,result:item.state}));
    });
    return true;
  }
  eventsStatus() {
    const count=state=>this.#state.outbox.filter(e=>e.state===state).length;
    const failed=[...this.#state.outbox].reverse().find(e=>e.state==='error');
    return {
      subscriptions:this.#state.subscriptions.map(s=>({id:s.id,name:s.name,state:s.state,
        expires_at:iso(s.expires_at),verified_at:iso(s.verified_at),last_delivery_at:iso(s.last_delivery_at),
        last_status:s.last_status??null,last_error:s.last_error??null})),
      outbox:{pending:count('pending')+count('sending'),accepted:count('accepted'),error:count('error'),cancelled:count('cancelled')},
      last_undelivered:failed?{event_id:failed.event_id,name:failed.name,attempts:failed.attempts,last_error:failed.last_error}:null,
      events_without_subscriber:this.#state.events_without_subscriber||0,
      last_event_without_subscriber:this.#state.last_event_without_subscriber||null,
    };
  }
  // Coordination is only a reminder for the coordinator: it never starts agents.
  async coordinationSet(args={}) {
    return this.#run(async()=>{
      const now=this.now();
      const current=this.#state.coordination;
      const goal=args.goal===undefined ? current?.goal : requireString(args.goal,'goal',500);
      if(!goal) throw Error('goal is required to open a coordination');
      const minAgents=args.min_agents??current?.min_agents??2;
      const idle=args.idle_minutes??current?.idle_minutes??15;
      if(!Number.isInteger(minAgents)||minAgents<1||minAgents>20) throw Error('min_agents must be 1-20');
      if(typeof idle!=='number'||idle<1||idle>240) throw Error('idle_minutes must be 1-240');
      let pausedUntil=current?.paused_until??null, pauseReason=current?.pause_reason??null;
      if(args.pause_minutes!==undefined) {
        if(typeof args.pause_minutes!=='number'||args.pause_minutes<0||args.pause_minutes>1440) throw Error('pause_minutes must be 0-1440');
        if(args.pause_minutes>0) {
          pauseReason=requireString(args.pause_reason,'pause_reason',300);
          pausedUntil=now+args.pause_minutes*60_000;
        } else {pausedUntil=null;pauseReason=null;}
      }
      this.#state.coordination={id:current?.id||'coord_'+randomUUID(),goal,min_agents:minAgents,idle_minutes:idle,
        paused_until:pausedUntil,pause_reason:pauseReason,opened_at:current?.opened_at||now,updated_at:now,
        below_since:current?.below_since??null,last_reminder_at:current?.last_reminder_at??null,reminders:current?.reminders||0};
      await this.#save();
      return this.coordinationStatus();
    });
  }
  async coordinationClose(reason) {
    return this.#run(async()=>{
      const current=this.#state.coordination;
      if(!current) return {open:false};
      this.#state.last_coordination={...current,closed_at:this.now(),close_reason:typeof reason==='string'?reason.slice(0,300):null};
      this.#state.coordination=null;
      await this.#save();
      return {open:false,closed:current.id};
    });
  }
  #activeAgents(now) {
    const latest=new Map();
    for(const job of this.#state.jobs) {
      const exec=this.#execution(job,now);
      if(exec!=='started'&&exec!=='progress') continue;
      latest.set(job.result_chat_url||job.chat_url||job.id,job);
    }
    return [...latest.values()];
  }
  coordinationStatus() {
    const c=this.#state.coordination;
    if(!c) return {open:false};
    const now=this.now();
    return {open:true,id:c.id,goal:c.goal,min_agents:c.min_agents,idle_minutes:c.idle_minutes,
      paused_until:c.paused_until>now?iso(c.paused_until):null,pause_reason:c.paused_until>now?c.pause_reason:null,
      active_agents:this.#activeAgents(now).map(j=>({job_id:j.id,chat_id:chatIdFromUrl(j.result_chat_url||j.chat_url),
        execution:this.#execution(j,now),last_report_at:j.model_last_report_at||j.model_started_at||null})),
      below_minimum_since:iso(c.below_since),last_reminder_at:iso(c.last_reminder_at),opened_at:iso(c.opened_at)};
  }
  // Runs about once a minute: silence and coordination checks.
  async tick() {
    return this.#run(async()=>{
      const now=this.now();
      let changed=this.#expire(now);
      for(const job of this.#state.jobs) {
        if(this.#execution(job,now)!=='unconfirmed') continue;
        const key=job.model_last_report_at||job.model_started_at||job.reported_at;
        if(job.unconfirmed_for===key) continue;
        job.unconfirmed_for=key;
        this.#notifyJob(job,'unconfirmed|'+key);
        changed=true;
      }
      const c=this.#state.coordination;
      if(c && !(c.paused_until>now)) {
        const active=this.#activeAgents(now);
        if(active.length>=c.min_agents) {
          if(c.below_since||c.last_reminder_at) {c.below_since=null;c.last_reminder_at=null;changed=true;}
        } else {
          // Time spent paused does not count as idle.
          const start=Math.max(c.below_since||now,c.paused_until||0);
          if(c.below_since!==start) {c.below_since=start;changed=true;}
          const idle=c.idle_minutes*60_000;
          if(now-start>=idle && (!c.last_reminder_at||now-c.last_reminder_at>=idle)) {
            c.reminders=(c.reminders||0)+1;
            c.last_reminder_at=now;
            const unfinished=this.#state.jobs.filter(j=>(j.action==='start'||j.action==='continue')&&
              !['done','failed','blocked','not_started'].includes(this.#execution(j,now))).slice(-10)
              .map(j=>({job_id:j.id,chat_id:chatIdFromUrl(j.result_chat_url||j.chat_url),execution:this.#execution(j,now)}));
            this.#emit(REMINDER_EVENT,c.id+'|'+c.reminders,{coordination_id:c.id,goal:c.goal,active_agents:active.length,
              min_agents:c.min_agents,idle_minutes:c.idle_minutes,below_minimum_since:iso(start),unfinished,
              // Night of 22 Oct: the work waited for the owner and 21 reminders in a row were noise.
              next_step:'Give useful work to idle agents. If everything is waiting for the owner or another external decision, '+
                'first make sure the owner has been asked that exact question, then call chatgpt_coordination_set(pause_minutes, pause_reason) '+
                'with that reason; reminders resume when the pause ends. '+
                'If the work is finished or cancelled, call chatgpt_coordination_close.'});
            changed=true;
          }
        }
      }
      if(changed) await this.#save();
    });
  }
  // Called by the ChatGPT conversation itself (see callbackFooter).
  async modelReport(data) {
    return this.#run(async()=>{
      const id=requireString(data.job_id,'job_id',100);
      if(!MODEL_STATES.includes(data.status))throw Error('status must be started, progress, done, failed or blocked');
      const job=this.#state.jobs.find(j=>j.id===id&&(j.action==='start'||j.action==='continue'));
      if(!job)throw Error('Unknown job_id: use the job_id given in the prompt');
      const now=new Date(this.now()).toISOString();
      // A late "started" or "progress" never undoes a finished report.
      // done/failed are final; blocked is not: once the decision is given (in
      // the agent's own chat), the agent goes on and reports started/progress.
      const finished=job.model_status==='done'||job.model_status==='failed';
      const ongoing=data.status==='started'||data.status==='progress';
      if(job.model_status==='blocked'&&ongoing) job.model_episode=(job.model_episode||0)+1;
      if(!(finished&&ongoing)) job.model_status=data.status;
      job.model_last_report_at=now;
      if(data.status==='started') job.model_started_at||=now;
      if(!ongoing) job.model_finished_at=now;
      if(typeof data.summary==='string') {
        if(ongoing) job.model_progress=data.summary.slice(0,500);
        else job.model_summary=data.summary.slice(0,MAX_REPLY);
      }
      // The conversation answering is proof the prompt arrived: no more uncertainty.
      if(['claimed','needs_review','failed'].includes(job.status)) {
        Object.assign(job,{status:'sent',timed_out:false,reported_at:job.reported_at||now,
          message:'Delivery confirmed by ChatGPT itself via chatgpt_report'});
      }
      // One event per outcome per episode: a repeated identical report is not news,
      // a second blocked after resuming is.
      if(!ongoing) this.#notifyJob(job,'model|'+(job.model_episode||0));
      await this.#save();
      return {ok:true,job_id:id,model_status:job.model_status};
    });
  }
  status(jobId) {
    if(this.#expire(this.now())) void this.#run(()=>this.#save());
    return this.#public(this.#state.jobs.find(j=>j.id===jobId));
  }
  // Gives every job that has waited too long a final, unambiguous status.
  #expire(now=this.now()) {
    let changed=false;
    for(const job of this.#state.jobs) {
      const since=Date.parse(job.status==='queued' ? job.created_at : job.claimed_at);
      if(!['queued','claimed'].includes(job.status) || !(now-since>STALE_MS)) continue;
      const at=new Date(now).toISOString();
      if(job.status==='queued') {
        Object.assign(job,{status:'expired',reported_at:at,
          message:'Chrome did not pick this job up within 15 minutes; nothing was sent'});
      } else {
        const sends=job.action==='start'||job.action==='continue';
        Object.assign(job,{status:sends?'needs_review':'failed',timed_out:true,reported_at:at,
          message:sends ? 'Chrome did not report back within 15 minutes; the prompt may or may not have been sent' :
            'Chrome did not report back within 15 minutes; nothing was sent, repeating is safe'});
      }
      this.#notifyJob(job,'timeout');
      changed=true;
    }
    return changed;
  }
  counts() {
    return this.#state.jobs.reduce((o,j)=>{o[j.status]=(o[j.status]||0)+1;return o;},{});
  }
  async claim(deviceId) {
    return this.#run(async()=>{
      if(this.#expire(this.now())) await this.#save(); // an expired prompt must never be handed out
      const job=this.#state.jobs.find(j=>j.device_id===deviceId&&j.status==='queued');
      if(!job)return null;
      job.status='claimed';
      job.claimed_at=new Date(this.now()).toISOString();
      await this.#save();
      const sends=job.action==='start'||job.action==='continue';
      return {...job,request_id:undefined,prompt:sends?job.prompt+callbackFooter(job.id):job.prompt,
        mention:sends?APP_NAME:undefined,
        own_text:sends?job.prompt:undefined}; // lets Chrome recognise its own unsent earlier attempt
    });
  }
  async report(deviceId,data) {
    return this.#run(async()=>{
      const id=requireString(data.job_id,'job_id',100);
      if(!REPORT_STATES.includes(data.status))throw Error('Invalid report status');
      const job=this.#state.jobs.find(j=>j.id===id&&j.device_id===deviceId);
      if(!job)throw Error('Unknown job');
      if(data.status==='opened' && job.action!=='open')throw Error('Only open jobs can report opened');
      if(data.status==='read' && job.action!=='read')throw Error('Only read jobs can report read');
      if(data.status==='closed' && job.action!=='close')throw Error('Only close jobs can report closed');
      if(['open','read','close'].includes(job.action)&&data.status==='sent')throw Error('Open and read jobs can never report sent');
      // A late real report replaces the status given on timeout: it is more accurate.
      if(job.status!=='claimed' && !job.timed_out) {
        if(job.status===data.status) {
          // ChatGPT may confirm via chatgpt_report before Chrome reports back:
          // still take the conversation address from Chrome's report.
          const late=canonicalChatUrl(data.chat_url);
          if(late && !job.result_chat_url && (!job.chat_url || late===job.chat_url)) {
            job.result_chat_url=late;
            this.#recordChat(late,deviceId,id,data.status);
            await this.#save();
          }
          return this.#public(job);
        }
        throw Error('Job is not claimed');
      }
      job.timed_out=false;
      // Rejecting a final report would wedge the browser worker, so an invalid
      // or unexpected URL is dropped instead of failing the whole report.
      let url=canonicalChatUrl(data.chat_url);
      if(job.chat_url&&url&&url!==job.chat_url)url=null;
      job.status=data.status;
      job.result_chat_url=url;
      if(url)this.#recordChat(url,deviceId,id,data.status);
      job.message=typeof data.message==='string'?data.message.slice(0,500):'';
      job.page_state=pageState(data.page_state);
      job.dom_probe=domProbe(data.dom_probe);
      if(job.action==='read') {
        job.reply_text=typeof data.reply_text==='string'?data.reply_text.slice(0,MAX_REPLY):null;
        job.reply_generating=data.reply_generating===true;
        job.last_user_text=typeof data.last_user_text==='string'?data.last_user_text.slice(0,2000):null;
      }
      job.reported_at=new Date(this.now()).toISOString();
      // A continue that could not be delivered must not lose the line of work:
      // start the same prompt in a new chat right away (owner decision, 22 Oct).
      if(job.action==='continue'&&job.status==='blocked'&&!job.fallback_job_id) {
        const fallback={id:randomUUID(),action:'start',effort:job.effort,device_id:job.device_id,chat_url:null,
          prompt:'(Продолжение работы из чата '+job.chat_url+': продолжить там не удалось, поэтому задача запущена в новом окне.)\n\n'+job.prompt,
          slack_thread_url:job.slack_thread_url||null,request_id:'fallback-'+job.id,status:'queued',
          created_at:new Date(this.now()).toISOString(),fallback_of:job.id};
        this.#state.jobs.push(fallback);
        job.fallback_job_id=fallback.id;
      }
      if(NOTIFY_STATUSES.includes(job.status)) this.#notifyJob(job,'chrome');
      await this.#save();
      return this.#public(job);
    });
  }
}
