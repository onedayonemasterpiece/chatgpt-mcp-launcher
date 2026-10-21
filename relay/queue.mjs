import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {MAX_CHATS,canonicalChatUrl,chatIdFromUrl,referenceToUrl,recordedChat} from './conversations.mjs';

const EFFORTS = ['auto', 'medium', 'high', 'xhigh'];
const REPORT_STATES = ['sent','opened','blocked','failed','needs_review'];
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

function requireString(value, name, maxLen = 256) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLen) {
    throw new Error(`${name} must be a nonempty string <= ${maxLen} chars`);
  }
  return value.trim();
}

export class FileQueue {
  #state = { jobs: [], device_status: {}, chats: [] };
  #serial = Promise.resolve();
  constructor(file, devices) {
    this.file = file;
    this.devices = devices;
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
    };
  }
  async initialize() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(parsed.jobs)) throw new Error('Invalid state');
      this.#state = {...parsed,device_status:parsed.device_status||{},chats:Array.isArray(parsed.chats)?parsed.chats:[]};
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
      if(!['start','continue','open'].includes(action))throw Error('Invalid action');
      const prompt=action==='open'?null:requireString(args.prompt,'prompt',MAX_PROMPT);
      // Default keeps the level already selected in ChatGPT (it remembers the last one).
      const effort=action==='open'?null:(args.effort??'auto');
      if(effort!==null&&!EFFORTS.includes(effort))throw Error('Invalid effort');
      const deviceId=args.device_id||'desktop';
      if(!Object.hasOwn(this.devices,deviceId))throw Error('Unknown device_id');
      const hasUrl=typeof args.chat_url==='string'&&args.chat_url.trim().length>0;
      const hasRef=typeof args.chat_ref==='string'&&args.chat_ref.trim().length>0;
      if(action!=='start' && (hasUrl===hasRef))throw Error('Exactly one chat_url or chat_ref is required');
      let target=null;
      if(action!=='start') {
        target=hasUrl?canonicalChatUrl(args.chat_url):this.resolveChat(args.chat_ref,deviceId);
        if(!target)throw Error('Unknown or invalid ChatGPT conversation reference');
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
      if(this.#state.jobs.length>=MAX_JOBS) {
        const removable=this.#state.jobs.findIndex(j=>['sent','opened','failed','blocked'].includes(j.status));
        if(removable<0)throw Error('Queue capacity reached; review in-flight and uncertain work');
        this.#state.jobs.splice(removable,1);
      }
      const now=new Date().toISOString();
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
    return {...publicJob,chat_id:chatIdFromUrl(job.result_chat_url||job.chat_url)};
  }
  status(jobId) {
    return this.#public(this.#state.jobs.find(j=>j.id===jobId));
  }
  counts() {
    return this.#state.jobs.reduce((o,j)=>{o[j.status]=(o[j.status]||0)+1;return o;},{});
  }
  async claim(deviceId) {
    return this.#run(async()=>{
      const job=this.#state.jobs.find(j=>j.device_id===deviceId&&j.status==='queued');
      if(!job)return null;
      job.status='claimed';
      job.claimed_at=new Date().toISOString();
      await this.#save();
      return {...job,request_id:undefined};
    });
  }
  async report(deviceId,data) {
    return this.#run(async()=>{
      const id=requireString(data.job_id,'job_id',100);
      if(!REPORT_STATES.includes(data.status))throw Error('Invalid report status');
      const job=this.#state.jobs.find(j=>j.id===id&&j.device_id===deviceId);
      if(!job)throw Error('Unknown job');
      if(data.status==='opened' && job.action!=='open')throw Error('Only open jobs can report opened');
      if(job.action==='open'&&data.status==='sent')throw Error('Open-only jobs can never report sent');
      if(job.status!=='claimed') {
        if(job.status===data.status)return this.#public(job);
        throw Error('Job is not claimed');
      }
      // Rejecting a final report would wedge the browser worker, so an invalid
      // or unexpected URL is dropped instead of failing the whole report.
      let url=canonicalChatUrl(data.chat_url);
      if(job.chat_url&&url&&url!==job.chat_url)url=null;
      job.status=data.status;
      job.result_chat_url=url;
      if(url)this.#recordChat(url,deviceId,id,data.status);
      job.message=typeof data.message==='string'?data.message.slice(0,500):'';
      job.reported_at=new Date().toISOString();
      await this.#save();
      return this.#public(job);
    });
  }
}
