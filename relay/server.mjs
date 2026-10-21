import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { FileQueue } from './queue.mjs';

const VERSION = '2025-11-25';
const INSTRUCTIONS = [
  'Drives ChatGPT in the owner\'s own Chrome. Every action is a job: the call returns job_id at once, the browser does the work within seconds to a few minutes.',
  'Workflow:',
  '1. New conversation: chatgpt_start(prompt). Then call chatgpt_task_status(job_id) every ~20 s until status is no longer queued/claimed. On "sent" keep chat_id: it identifies this conversation from now on.',
  '2. Result: ChatGPT itself reports back through MCP. chatgpt_task_status(job_id) shows model_status (started, then done/failed) and model_summary. Fallback if it never reports: chatgpt_read_reply(chat_ref = chat_id).',
  '3. Follow-up in the same conversation: chatgpt_continue(chat_ref = chat_id, prompt). Never use chatgpt_start for a follow-up.',
  '4. Lost a chat_id: chatgpt_list_chats.',
  '5. Optional: when a conversation is finished, chatgpt_close_chat(chat_ref = chat_id) closes its tab to save memory; the chat itself stays.',
  'Rules: each result has next_step; follow it. Give every start/continue a unique request_id and reuse the same request_id only to repeat a call whose result you did not get. After needs_review, check with chatgpt_read_reply (last_user_text) before resending. Jobs stuck in queued: check chatgpt_device_status (Chrome offline or commands disabled).',
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
    inputSchema:{type:'object', properties:PROPS, required:['prompt'], additionalProperties:false},
  },
  {
    name:'chatgpt_continue', description:'Send a follow-up prompt into an EXISTING conversation (chat_ref = chat_id). Finds the open tab or opens it; no need to call chatgpt_open first. Returns job_id; poll chatgpt_task_status. After needs_review, check with chatgpt_read_reply before resending.',
    inputSchema:{type:'object',properties:{chat_ref:CHAT_REF,chat_url:CHAT_URL,...PROPS},required:['prompt'],additionalProperties:false},
  },
  {
    name:'chatgpt_read_reply',description:'Fallback when ChatGPT did not report back via model_status: get the text of the last ChatGPT reply in a conversation (chat_ref = chat_id). Never types or sends. Returns job_id; chatgpt_task_status then has reply_text, last_user_text (the last message sent in that chat: use it to check whether your prompt arrived), and reply_generating = true while ChatGPT is still writing (read again later).',
    inputSchema:{type:'object',properties:{chat_ref:CHAT_REF,chat_url:CHAT_URL,...COMMON},additionalProperties:false},
  },
  {
    name:'chatgpt_task_status', description:'Status of a job by job_id: queued/claimed = in progress; sent = prompt delivered, then model_status started/done/failed and model_summary as ChatGPT reports back; read = reply_text ready; opened; blocked = nothing sent; expired = Chrome did not pick it up within 15 min, nothing sent; needs_review = may have been sent, check with chatgpt_read_reply before resending; failed. No job stays in progress longer than 15 minutes. Always includes next_step, plus chat_id when known.',
    inputSchema:{type:'object',properties:{job_id:{type:'string',description:'job_id returned by start/continue/read_reply/open.'}},required:['job_id'],additionalProperties:false},
  },
  {
    name:'chatgpt_list_chats',description:'Conversations started or continued through this launcher, newest first, with chat_id and chat_url. Use it to find a chat_id you lost. No message text.',
    inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:50,description:'Default 20.'},device_id:COMMON.device_id},additionalProperties:false},
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
    name:'chatgpt_report',description:'For the ChatGPT conversation that received a launcher prompt ONLY: confirm with status "started" as soon as you begin, then "done" with a short summary (or "failed" with the reason). Use the job_id quoted in the prompt. Agents that launch tasks must not call this; they read the result via chatgpt_task_status.',
    inputSchema:{type:'object',properties:{job_id:{type:'string',description:'job_id quoted in the prompt.'},status:{type:'string',enum:['started','done','failed']},summary:{type:'string',maxLength:20000,description:'Short result (done) or reason (failed).'}},required:['job_id','status'],additionalProperties:false},
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
function rpcError(id, code, message) {return {jsonrpc:'2.0', id, error:{code,message}};}
function resultText(data, isError = false) {
  return {content:[{type:'text',text:JSON.stringify(data)}], ...(isError ? {isError:true} : {})};
}
function targetOrigin(req) {
  const origin = req.headers.origin;
  // Reject browser-originated MCP mutations; Chrome device API uses bearer + host permissions.
  return !origin;
}
export async function makeRelay({file, mcpToken, devices}) {
  if (typeof mcpToken !== 'string' || mcpToken.length < 24) throw new Error('MCP token must have >= 24 characters');
  if (!devices || Object.keys(devices).length===0 || Object.values(devices).some(t => typeof t !== 'string' || t.length < 24)) {
    throw new Error('Configure device token(s) (>= 24 characters)');
  }
  const queue = new FileQueue(file, devices);
  await queue.initialize();
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
        if (data.method==='initialize') {
          out=rpcOk(data.id,{protocolVersion:VERSION,capabilities:{tools:{listChanged:false}},serverInfo:{name:'chatgpt-local-chrome-launcher',version:'0.2.9'},instructions:INSTRUCTIONS});
        } else if (data.method==='ping') out=rpcOk(data.id,{});
        else if (data.method==='tools/list') out=rpcOk(data.id,{tools:TOOL_LIST});
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
            } else if (name==='chatgpt_close_chat') {
              value=await queue.enqueue({...args,action:'close'});
            } else if (name==='chatgpt_report') {
              value=await queue.modelReport(args);
            } else if (name==='chatgpt_read_reply') {
              value=await queue.enqueue({...args,action:'read'});
            } else throw new Error('Unknown tool');
            out=rpcOk(data.id,resultText(value));
          } catch(err) {out=rpcOk(data.id,resultText({error:err.message},true));}
        } else out=rpcError(data.id,-32601,'Unknown method');
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
