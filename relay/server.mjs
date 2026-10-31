import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { FileQueue } from './queue.mjs';
import { DeliveryError, sealer, webhookSender } from './events.mjs';

const VERSION = '2025-11-25';
// MCP 2026-07-28 (needed for OpenAI MCP Events) is served next to the
// 2025-11-25 handshake; a client picks one with server/discover.
const MODERN = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO = {name:'chatgpt-local-chrome-launcher',version:'0.3.18'};
const INSTRUCTIONS = [
  'Drives ChatGPT in the owner\'s own Chrome. Every action is a job: the call returns job_id at once, the browser does the work within seconds to a few minutes.',
  'Workflow:',
  '1. New conversation: chatgpt_start(prompt). Then call chatgpt_task_status(job_id) every ~20 s until status is no longer queued/claimed. On "sent" keep chat_id: it identifies this conversation from now on.',
  '2. Result: ChatGPT itself reports back through MCP. chatgpt_task_status(job_id) shows model_status (started, then done/failed) and model_summary. Fallback if it never reports: chatgpt_read_reply(chat_ref = chat_id). For needs_review or unconfirmed execution, use chatgpt_reconcile(job_id): read-only proof of the exact job marker and (if observable) its finished assistant reply. Page completion is separate from model done; no proof keeps uncertainty.',
  '3. Follow-up: chatgpt_continue(chat_ref = chat_id, prompt). The launcher permits at most FIVE delivered continuations per real chat_id; at count 5, or whenever an old count is unknown/missing/null, this call automatically creates ONE new ChatGPT chat with context. Follow the NEW chat_id in chatgpt_task_status. A new start begins at count 0.',
  '4. Lost a chat_id: chatgpt_list_chats.',
  'Autonomous RKB books: chatgpt_start(book: {books:[{ingestion_id}], continuation_prompt}) keeps an ordered list. RKB import activity (not ChatGPT/model) determines book finalization/blocker. Completion of a ChatGPT turn can start another turn; after RKB finalized/done the next book starts in a new chat. Two replacement chats without RKB operations produce one factual Slack alert.',
  '5. Optional: when a conversation is finished, chatgpt_close_chat(chat_ref = chat_id) closes its tab to save memory; the chat itself stays.',
  'Events: subscribe to chatgpt_launcher.job_update to be woken when a job finishes, is blocked/failed/needs review/expired, its tab is closed, or the agent goes silent. execution separates work from delivery: awaiting_confirmation, started, progress, page_completed (read-only observation, not model done), done, failed, unconfirmed (no confirmation).',
  'Coordination (optional reminder): chatgpt_coordination_set(goal, min_agents, idle_minutes) and subscribe to chatgpt_launcher.coordination_reminder; you are reminded while fewer agents than min_agents report started/progress for longer than idle_minutes. Pause only with a reason and a duration; close it explicitly when the whole work is done or cancelled.',
  'A job that sent nothing (blocked/expired/failed) is repeated with chatgpt_retry(job_id): exact same prompt, same chat.',
  'Rules: each result has next_step; follow it. Give every start/continue a unique request_id, reuse it for a lost response. Continuation count changes only once on confirmed delivery, not on queued/blocked attempts. Never continue/handoff an active or uncertain job (needs_review/unconfirmed): first reconcile it, never blind retry. No old tab is automatically closed. Jobs stuck queued: check chatgpt_device_status.',
].join('\n');
const CHAT_REF = {type:'string',description:'Which conversation: the chat_id from chatgpt_task_status or chatgpt_list_chats (preferred), a full https://chatgpt.com/c/... URL, or the job_id that created the chat.'};
const CHAT_URL = {type:'string',description:'Alternative to chat_ref: full https://chatgpt.com/c/... URL. Pass chat_ref or chat_url, not both.'};
const COMMON = {
  device_id: {type:'string',description:'Leave unset (default desktop).'},
  request_id: {type:'string',description:'Your unique ID for this action, e.g. a UUID. Repeating a call with the same request_id returns the same job instead of acting twice: use it after a timeout or lost response.'},
};
const PROPS = {
  prompt: {type:'string',minLength:1,maxLength:30000,description:'Message to send to ChatGPT.'},
  effort: {type:'string',enum:['auto','medium','high','xhigh'],description:'Leave unset: ChatGPT keeps its current reasoning level. An explicit level is tried once and never blocks sending.'},
  slack_thread_url: {type:'string',description:'Optional Slack thread permalink; ChatGPT is asked to post its result there (not guaranteed).'},
  ...COMMON,
};
const TOOL_LIST = [
  {
    name:'chatgpt_start', description:'Start a NEW ChatGPT conversation and send the prompt. Returns job_id at once; poll chatgpt_task_status until "sent", which gives chat_id for chatgpt_continue and chatgpt_read_reply. For a follow-up in an existing conversation use chatgpt_continue instead.',
    inputSchema:{type:'object', properties:{...PROPS,book:{type:'object',
      description:'Durable ordered reading of 1-32 books; RKB authoritative for progress and completion.',
      properties:{books:{type:'array',minItems:1,maxItems:32,items:{type:'object',properties:{
        ingestion_id:{type:'string',description:'Canonical ingestion UUID required by RKB read-only activity API.'},
        telegram_original:{type:'string',description:'Optional saved Telegram original locator associated with ingestion_id.'}},
        required:['ingestion_id'],additionalProperties:false}},
        continuation_prompt:{type:'string',description:'Full follow-up text; each new chat begins with book_ingest(status) on current ingestion.'}},
      required:['books','continuation_prompt'],additionalProperties:false}},
      required:['prompt'], additionalProperties:false},
  },
  {
    name:'chatgpt_continue', description:'Continue a line of work by chat_id. At most 5 confirmed continuations are delivered to one existing chat. If it already has 5, OR its legacy count is missing/null/unknown, the launcher automatically sends this prompt in a NEW chat (with source link and available original prompt). Poll chatgpt_task_status and switch to the returned NEW chat_id/url; previous_chat_url links the predecessor. Once successor_chat_url is known, continuing the old predecessor is rejected with that successor link, not forked. In-flight/uncertain work blocks handoff; duplicate request_id stays idempotent even after bounded job pruning. Never retry needs_review blindly. No old tab is closed.',
    inputSchema:{type:'object',properties:{chat_ref:CHAT_REF,chat_url:CHAT_URL,...PROPS},required:['prompt'],additionalProperties:false},
  },
  {
    name:'chatgpt_read_reply',description:'Unreliable fallback (ChatGPT page markup often cannot be read; prefer model_status/model_summary): get the text of the last ChatGPT reply in a conversation (chat_ref = chat_id). Never types or sends. Returns job_id; chatgpt_task_status then has reply_text, last_user_text (the last message sent in that chat: use it to check whether your prompt arrived), and reply_generating = true while ChatGPT is still writing (read again later).',
    inputSchema:{type:'object',properties:{chat_ref:CHAT_REF,chat_url:CHAT_URL,...COMMON},additionalProperties:false},
  },
  {
    name:'chatgpt_reconcile',description:'Read-only check of an existing needs_review delivery OR sent job with unconfirmed execution. A visible exact job marker proves delivery. Only a visible assistant answer after the matching user turn, with generation finished, records execution=page_completed on the ORIGINAL job; model_status is NOT changed to done. No marker, incomplete answer or unreadable DOM never clears uncertainty. Does not submit, retry or create chats. Poll the reconciliation job and inspect the ORIGINAL job_id.',
    inputSchema:{type:'object',properties:{job_id:{type:'string',description:'Exact needs_review or sent/unconfirmed start/continue job_id; not a conversation ID.'},...COMMON},required:['job_id'],additionalProperties:false},
  },
  {
    name:'chatgpt_task_status', description:'Status by job_id: queued/claimed, sent, read, opened, blocked (nothing sent), expired (never claimed), needs_review (may be sent; reconcile before any repeat/continue), failed. Exposes current chat_id/chat_url, continuation_count (integer 0..5 or null unknown), and for automatic new-chat handoff previous_chat_url plus delivery_action=start; model_status is separate. Never invent a new chat ID; no in-flight job stays claimed over 15 min.',
    inputSchema:{type:'object',properties:{job_id:{type:'string',description:'job_id returned by start/continue/read_reply/open.'}},required:['job_id'],additionalProperties:false},
  },
  {
    name:'chatgpt_list_chats',description:'Known ChatGPT conversations with chat_id/url, persistent continuation_count (0..5, null for legacy unknown), and previous_chat_url/successor_chat_url when a new chat was created. No message text. Never infer unknown counts from old jobs.',
    inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:50,description:'Default 20.'},device_id:COMMON.device_id},additionalProperties:false},
  },
  {
    name:'chatgpt_retry',description:'Retry a job proven not sent (blocked/expired/failed) with its stored exact prompt and original chat reference; the five-continuation/legacy rollover policy still applies, so it may open a NEW chat. Refused if unknown needs_review, model-confirmed, or fallback already started; never duplicate a sent task.',
    inputSchema:{type:'object',properties:{job_id:{type:'string',description:'job_id of the job that sent nothing.'},request_id:COMMON.request_id},required:['job_id'],additionalProperties:false},
  },
  {
    name:'chatgpt_close_chat',description:'Optional housekeeping: close the Chrome tab of a conversation you no longer need, to save the owner\'s memory (RAM). The conversation stays in ChatGPT; chatgpt_continue reopens it any time. Tabs with an unsent draft or with ChatGPT still answering are left open (status blocked, try later).',
    inputSchema:{type:'object',properties:{chat_ref:CHAT_REF,chat_url:CHAT_URL,...COMMON},additionalProperties:false},
  },
  {
    name:'chatgpt_open',description:'Only show a conversation to the owner: bring its tab to the front in Chrome without sending anything. Not needed before chatgpt_continue or chatgpt_read_reply.',
    inputSchema:{type:'object',properties:{chat_ref:CHAT_REF,chat_url:CHAT_URL,...COMMON},additionalProperties:false},
  },
  {
    name:'chatgpt_refresh_plugin_tools',description:'After a deploy that adds or changes MCP tools: open the owner\'s ChatGPT plugin settings page, press "Refresh tools", wait for it to finish and close the tab. Sends nothing to any chat. Then verify the new tools in a chat and report in the coordination thread and to the owner.',
    inputSchema:{type:'object',properties:{plugin_url:{type:'string',description:'https://chatgpt.com/settings/plugins-settings/plugin_<id> of the plugin to refresh.'},...COMMON},required:['plugin_url'],additionalProperties:false},
  },
  {
    name:'chatgpt_coordination_set',description:'Optional reminder for a coordinator: open or update the coordination of a complex piece of work. While it is open and fewer than min_agents agents report started/progress for longer than idle_minutes, a chatgpt_launcher.coordination_reminder event is sent. It never starts agents. Pause with pause_minutes + pause_reason (0 ends the pause). Returns the current state.',
    inputSchema:{type:'object',properties:{goal:{type:'string',maxLength:500,description:'What is being coordinated (required when opening).'},
      min_agents:{type:'integer',minimum:1,maximum:20,description:'Default 2.'},idle_minutes:{type:'number',minimum:1,maximum:240,description:'Default 15.'},
      pause_minutes:{type:'number',minimum:0,maximum:1440},pause_reason:{type:'string',maxLength:300}},additionalProperties:false},
  },
  {
    name:'chatgpt_coordination_close',description:'Close the coordination when the whole work is done or cancelled; reminders stop. Finishing one of your own replies does not close it.',
    inputSchema:{type:'object',properties:{reason:{type:'string',maxLength:300}},additionalProperties:false},
  },
  {
    name:'chatgpt_report',description:'For the ChatGPT conversation that received a launcher prompt ONLY: confirm with status "started" as soon as you begin; during long work you may send "progress" with a short note; at the end "done" with a short summary, "failed" with the reason, or "blocked" when you cannot go on without a decision by someone else (say exactly which decision and from whom). Use the job_id quoted in the prompt. Agents that launch tasks must not call this; they read the result via chatgpt_task_status.',
    inputSchema:{type:'object',properties:{job_id:{type:'string',description:'job_id quoted in the prompt.'},status:{type:'string',enum:['started','progress','done','failed','blocked']},summary:{type:'string',maxLength:20000,description:'Short progress note, result (done), reason (failed), or for blocked: exactly which decision is needed and from whom.'},failure_kind:{type:'string',enum:['client_safety_rejection'],description:'Only for status=blocked on a book task after an explicit OpenAI client-side tool safety rejection before the RKB handler. Provide the exact refusal in summary; never infer from ordinary errors.'}},required:['job_id','status'],additionalProperties:false},
  },
  {
    name:'chatgpt_device_status', description:'Diagnostics: whether the owner\'s Chrome is online and accepting commands, and which launcher version it runs. Use when jobs stay queued.',
    inputSchema:{type:'object',properties:{device_id:COMMON.device_id},additionalProperties:false},
  },
];

function equalSecrets(expected, actual) {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected), b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a,b);
}
function token(req) {
  const authorization = req.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}
function send(res, status, json, headers = {}) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
  res.end(JSON.stringify(json));
}
async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []; let len=0;
  for await (const chunk of req) {
    len += chunk.length;
    if (len > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function rpcOk(id, result) {return {jsonrpc:'2.0', id, result};}
function rpcError(id, code, message, data) {return {jsonrpc:'2.0', id, error:{code,message,...(data?{data}:{})}};}
// The extra fields a 2026-07-28 result carries (cacheable lists add cacheScope/ttlMs).
function modern(result, cacheable=false) {
  return {...result,resultType:'complete',...(cacheable?{cacheScope:'private',ttlMs:0}:{}),
    _meta:{'io.modelcontextprotocol/serverInfo':SERVER_INFO}};
}
function resultText(data, isError = false) {
  return {content:[{type:'text',text:JSON.stringify(data)}], ...(isError ? {isError:true} : {})};
}
function targetOrigin(req) {
  const origin = req.headers.origin;
  // Reject browser-originated MCP mutations; Chrome device API uses bearer + host permissions.
  return !origin;
}

export function bookActivityReaderFromEnv() {
  const address=process.env.LAUNCHER_RKB_ACTIVITY_URL;
  if(!address)return null;
  const token=process.env.LAUNCHER_RKB_ACTIVITY_TOKEN;
  const credential=process.env.LAUNCHER_RKB_SERVICE_CREDENTIAL_ID;
  const epoch=process.env.LAUNCHER_RKB_SERVICE_CREDENTIAL_EPOCH;
  if(!token||!credential||!epoch) {
    console.error('RKB activity disabled: missing dedicated service credential');
    return null;
  }
  const endpoint=new URL(address);
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||
    endpoint.pathname!=='/internal/import/activity'||endpoint.search||endpoint.hash||
    endpoint.username||endpoint.password)throw Error('RKB activity URL must be loopback /internal/import/activity');
  return async ingestionId=>{
    const url=new URL(endpoint);
    url.searchParams.set('ingestion_id',ingestionId);
    const response=await fetch(url,{headers:{
      Authorization:'Bearer '+token,
      'X-RKB-Service':'launcher-import-watch',
      'X-RKB-Service-Credential':credential,
      'X-RKB-Service-Epoch':epoch
    },signal:AbortSignal.timeout(3_000)});
    if(!response.ok)throw Error('RKB activity HTTP '+response.status);
    return response.json();
  };
}
function slackBookNotifierFromEnv() {
  const secret=process.env.LAUNCHER_SLACK_BOT_TOKEN;
  if(!secret)return null;
  return async task=>{
    const url=new URL(task.slack_thread_url);
    const m=/^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url.pathname);
    if(url.protocol!=='https:'||!url.hostname.endsWith('.slack.com')||!m)
      throw Error('Invalid book Slack thread');
    const message=task.kind==='no_progress'?
      'Два новых окна подряд без новых операций RKB; задача остаётся активной':
      task.state==='done'?'Список книг дочитан':'Импорт остановлен';
    const response=await fetch('https://slack.com/api/chat.postMessage',{
      method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},
      body:JSON.stringify({channel:m[1],thread_ts:m[2]+'.'+m[3],
        client_msg_id:task.notice_id,
        text:'[Launcher book-task / '+(task.kind==='no_progress'?'NO_PROGRESS':task.state.toUpperCase())+'] '+message+
          '; ingestion_id='+task.ingestion_id+'; book='+(task.current_book_index+1)+'/'+task.total_books+
          '; last_operation_at='+(task.last_operation_at||'null')+
          '; accepted_pages='+(task.accepted_pages??'unknown')+
          '; new_chats_without_progress='+task.no_progress_new_chats+
          '; '+(task.terminal_summary||'')}),
      signal:AbortSignal.timeout(10_000)
    });
    const result=await response.json();
    if(!response.ok||!result.ok)throw Error('Slack notification failed: '+(result.error||response.status));
  };
}

export async function makeRelay({file, mcpToken, devices, sender=webhookSender(), queueOptions={}, deliveryMs=1000, tickMs=60_000,
  bookActivityReader=bookActivityReaderFromEnv(),bookNotifier=slackBookNotifierFromEnv()}) {
  if (typeof mcpToken !== 'string' || mcpToken.length < 24) throw new Error('MCP token must have >= 24 characters');
  if (!devices || Object.keys(devices).length===0 || Object.values(devices).some(t => typeof t !== 'string' || t.length < 24)) {
    throw new Error('Configure device token(s) (>= 24 characters)');
  }
  const queue = new FileQueue(file, devices, {seal:sealer(mcpToken),...queueOptions});
  await queue.initialize();
  // Book tasks share the existing queue and relay timer; no external driver.
  let bookTicking=false,bookPolledAt=0;
  async function relayTick() {
    if(bookTicking)return;
    bookTicking=true;
    try {
      const pollBooks=bookActivityReader&&Date.now()-bookPolledAt>=5*60_000;
      if(pollBooks) {
        bookPolledAt=Date.now();
        for(const book of queue.activeBooks()) {
          try {
            const result=await bookActivityReader(book.ingestion_id);
            await queue.bookActivity({book_task_id:book.book_task_id,...result});
          } catch(err) {
            await queue.bookActivity({book_task_id:book.book_task_id,state:'unavailable'});
            console.error('RKB activity',err?.message);
          }
        }
      }
      await queue.tick();
      if(pollBooks)await queue.closeRetiredBookChats();
      if(bookNotifier)for(const notice of queue.pendingBookNotices()) {
        try {await bookNotifier(notice);await queue.bookNoticeSent(notice.book_task_id,notice.notice_id);}
        catch(err) {console.error('book Slack notice',err?.message);}
      }
    } finally {bookTicking=false;}
  }
  // Background work: deliver due events, and check silence/coordination.
  let delivering=false;
  const timers=[
    setInterval(async()=>{
      if(delivering) return;
      delivering=true;
      try {while(await queue.deliverDue(sender));} catch(err) {console.error('event delivery',err?.message);}
      finally {delivering=false;}
    },deliveryMs),
    setInterval(()=>relayTick().catch(err=>console.error('tick',err?.message)),tickMs),
  ];
  for(const t of timers) t.unref?.();
  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') {
        return send(res,200,{ok:true,queued:queue.counts().queued || 0});
      }
      if (url.pathname === '/mcp') {
        if (!targetOrigin(req)) return send(res,403,{error:'Browser Origin denied on MCP endpoint'});
        if (!equalSecrets(mcpToken,token(req))) return send(res,401,{error:'Unauthorized'});
        if (req.method !== 'POST') return send(res,405,{error:'Method not allowed'});
        const data = await readJson(req);
        if (data.jsonrpc !== '2.0' || typeof data.method !== 'string') return send(res,400,rpcError(data.id??null,-32600,'Invalid JSON-RPC'));
        if (data.method.startsWith('notifications/')) {res.writeHead(202);return res.end();}
        let out;
        const requested=data.params?._meta?.[META_VERSION];
        // One line per MCP request: method, protocol, outcome. Never URLs, secrets or arguments.
        const logged=()=>{
          const e=out?.error, r=out?.result;
          console.log(JSON.stringify({event:'mcp_request',method:data.method,
            tool:data.method==='tools/call'?String(data.params?.name||'').slice(0,60):undefined,
            event_name:data.method.startsWith('events/')?String(data.params?.name||'').slice(0,80):undefined,
            protocol:requested===undefined?'legacy':String(requested).slice(0,20),
            result:e?'error':r?.isError?'tool_error':'ok',code:e?.code,reason:e?.data?.reason,
            delivery_mode:data.method==='events/subscribe'?String(data.params?.delivery?.mode??'(none)').slice(0,20):undefined,
            argument_keys:data.method.startsWith('events/')?Object.keys(data.params?.arguments||{}).slice(0,5):undefined}));
        };
        const isModern=requested!==undefined;
        if (isModern && requested!==MODERN) {
          out=rpcError(data.id,-32022,'Unsupported protocol version',{supported:[MODERN],requested});
          logged();
          return send(res,200,out);
        }
        const wrap=(result,cacheable)=>isModern?modern(result,cacheable):result;
        if (data.method==='initialize') {
          out=rpcOk(data.id,{protocolVersion:VERSION,capabilities:{tools:{listChanged:false}},serverInfo:SERVER_INFO,instructions:INSTRUCTIONS});
        } else if (data.method==='server/discover') {
          out=rpcOk(data.id,modern({supportedVersions:[MODERN],capabilities:{tools:{listChanged:false},events:{}},instructions:INSTRUCTIONS},true));
        } else if (data.method==='ping') out=rpcOk(data.id,{});
        else if (data.method==='tools/list') out=rpcOk(data.id,wrap({tools:TOOL_LIST},true));
        else if (data.method==='events/list') out=rpcOk(data.id,wrap(queue.listEvents(),true));
        else if (data.method==='events/subscribe'||data.method==='events/unsubscribe') {
          try {
            const result=data.method==='events/subscribe' ? await queue.subscribe(data.params,sender) : await queue.unsubscribe(data.params);
            out=rpcOk(data.id,wrap(result));
          } catch(err) {
            const reason=err instanceof DeliveryError ? err.reason : 'invalid_params';
            const invalid=['invalid_secret','invalid_url','unknown_event','unexpected_arguments','invalid_ttl','invalid_params'].includes(reason);
            out=rpcError(data.id,invalid?-32602:-32015,invalid?'Invalid subscription':'Callback verification failed',{reason});
          }
        }
        else if (data.method==='tools/call') {
          const {name, arguments:args={}} = data.params || {};
          try {
            let value;
            if (name==='chatgpt_device_status') {
              value=queue.deviceStatus(args.device_id || 'desktop');
            } else if (name==='chatgpt_task_status') {
              if (!args.job_id) throw new Error('job_id is required');
              value=queue.status(args.job_id);
              if (!value) throw new Error('Job not found');
            } else if(name==='chatgpt_list_chats') {
              value=queue.listChats(args.device_id||'desktop',args.limit||20);
            } else if (name==='chatgpt_start'||name==='chatgpt_continue'||name==='chatgpt_open') {
              value=await queue.enqueue({...args,action:name==='chatgpt_start'?'start':name==='chatgpt_open'?'open':'continue'});
            } else if (name==='chatgpt_reconcile') {
              if(!args.job_id) throw new Error('job_id is required');
              value=await queue.reconcile(args.job_id,args.request_id,args.device_id||'desktop');
            } else if (name==='chatgpt_retry') {
              if(!args.job_id) throw new Error('job_id is required');
              value=await queue.retry(args.job_id,args.request_id);
            } else if (name==='chatgpt_refresh_plugin_tools') {
              value=await queue.enqueue({...args,action:'refresh_tools'});
            } else if (name==='chatgpt_close_chat') {
              value=await queue.enqueue({...args,action:'close'});
            } else if (name==='chatgpt_report') {
              value=await queue.modelReport(args);
              if(queue.status(args.job_id)?.book_task&&['done','failed','blocked'].includes(value.model_status))
                bookPolledAt=0;
            } else if (name==='chatgpt_read_reply') {
              value=await queue.enqueue({...args,action:'read'});
            } else if (name==='chatgpt_coordination_set') {
              value=await queue.coordinationSet(args);
            } else if (name==='chatgpt_coordination_close') {
              value=await queue.coordinationClose(args.reason);
            } else throw new Error('Unknown tool');
            out=rpcOk(data.id,wrap(resultText(value)));
          } catch(err) {out=rpcOk(data.id,wrap(resultText({error:err.message},true)));}
        } else out=rpcError(data.id,-32601,'Unknown method');
        logged();
        return send(res,200,out);
      }
      if (url.pathname==='/device/poll' || url.pathname==='/device/report') {
        const deviceId = req.headers['x-launcher-device-id'];
        if (typeof deviceId !== 'string' || !Object.hasOwn(devices,deviceId) || !equalSecrets(devices[deviceId],token(req))) {
          return send(res,401,{error:'Unauthorized device'});
        }
        queue.observeDevice(deviceId,req.headers['x-launcher-revision']);
        if (url.pathname==='/device/poll' && req.method==='GET') {
          // Fail closed: old/unverified Chrome workers can report their heartbeat
          // but cannot claim work until they prove a loaded & matching build
          // during the current relay process lifetime.
          const status=queue.deviceStatus(deviceId);
          const verified=status.heartbeat_current_session &&
            status.commands_enabled===true && status.active_revision &&
            status.installed_revision===status.active_revision &&
            req.headers['x-launcher-revision']===status.active_revision &&
            status.runtime_integrity==='ok';
          return send(res,200,{job:verified ? await queue.claim(deviceId) : null});
        }
        if (url.pathname==='/device/report' && req.method==='POST') {
          const data = await readJson(req,256*1024); // room for a reply of up to 20,000 characters
          if(data?.type==='heartbeat') {
            const status=await queue.observeHeartbeat(deviceId,data,req.headers['x-launcher-revision']);
            return send(res,200,{ok:true,reported_revision:status.active_revision,commands_enabled:status.commands_enabled});
          }
          return send(res,200,{job:await queue.report(deviceId,data)});
        }
        return send(res,405,{error:'Method not allowed'});
      }
      return send(res,404,{error:'Not found'});
    } catch (err) {return send(res,400,{error:err.message || 'Bad request'});}
  });
  server.on('close',()=>timers.forEach(clearInterval));
  return {server,queue};
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const port = Number(process.env.LAUNCHER_PORT || '8177');
  const host = process.env.LAUNCHER_HOST || '127.0.0.1';
  let devices;
  try {devices = JSON.parse(process.env.LAUNCHER_DEVICES_JSON || '{}');}
  catch {throw new Error('LAUNCHER_DEVICES_JSON is not valid JSON');}
  makeRelay({file:process.env.LAUNCHER_STATE_FILE || './var/queue.json',mcpToken:process.env.LAUNCHER_MCP_TOKEN,devices}).then(({server})=>{
    server.listen(port,host,()=>console.log(`ChatGPT launcher relay on ${host}:${port}`));
  }).catch(err=>{console.error(err.message);process.exitCode=1;});
}
