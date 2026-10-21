import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { FileQueue } from './queue.mjs';

const VERSION = '2025-11-25';
const EFFORT_SCHEMA = { type: 'string', enum: ['auto', 'medium', 'high', 'xhigh'], description: 'Thinking effort: xhigh = Extra High.' };
const PROPS = {
  prompt: {type:'string',minLength:1,maxLength:30000},
  effort: EFFORT_SCHEMA,
  device_id: {type:'string',description:'Configured local Chrome (default desktop)'},
  slack_thread_url: {type:'string',description:'Optional Slack permalink; appended to prompt as a reporting request, not guaranteed.'},
  request_id: {type:'string',description:'Idempotency key; reuse to prevent duplicate chat submissions.'},
};
const TOOL_LIST = [
  {
    name:'chatgpt_start', description:'Queue a new ordinary ChatGPT browser chat in the authenticated local Chrome. Returns job_id; use chatgpt_task_status to check delivery. Does not read model output.',
    inputSchema:{type:'object', properties:PROPS, required:['prompt'], additionalProperties:false},
  },
  {
    name:'chatgpt_continue', description:'Queue a prompt into an existing ordinary ChatGPT chat. Never sends twice automatically after an uncertain delivery.',
    inputSchema:{type:'object', properties:{...PROPS, chat_url:{type:'string',description:'Full https://chatgpt.com/c/... or project conversation URL'}}, required:['chat_url','prompt'], additionalProperties:false},
  },
  {
    name:'chatgpt_device_status', description:'Inspect local Chrome heartbeat, running and installed Git revisions, updater health, enabled state, and last dispatch. Does not read conversation content.',
    inputSchema:{type:'object',properties:{device_id:{type:'string'}},additionalProperties:false},
  },
  {
    name:'chatgpt_task_status', description:'Check delivery status of a queued browser action (queued/claimed/sent/blocked/failed/needs_review), with final chat URL when known.',
    inputSchema:{type:'object',properties:{job_id:{type:'string'}},required:['job_id'],additionalProperties:false},
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
          out=rpcOk(data.id,{protocolVersion:VERSION,capabilities:{tools:{listChanged:false}},serverInfo:{name:'chatgpt-local-chrome-launcher',version:'0.2.0'}});
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
            } else if (name==='chatgpt_start' || name==='chatgpt_continue') {
              value=await queue.enqueue({...args,action:name==='chatgpt_start'?'start':'continue'});
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
          const data = await readJson(req);
          if(data?.type==='heartbeat') {
            const status=await queue.observeHeartbeat(deviceId,data,req.headers['x-launcher-revision']);
            return send(res,200,{ok:true,reported_revision:status.active_revision,
              commands_enabled:status.commands_enabled});
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
