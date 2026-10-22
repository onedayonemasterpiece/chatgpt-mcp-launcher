// MCP Events (OpenAI, protocol 2026-07-28): signed webhook delivery.
// Same contract as projects-hub: verification challenge, Standard Webhooks
// signatures, HTTPS to public addresses only, no redirects.
import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes,timingSafeEqual} from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const JOB_EVENT='chatgpt_launcher.job_update';
export const REMINDER_EVENT='chatgpt_launcher.coordination_reminder';
const STRING={type:'string'};
// Same shape as the working projects-hub events: one optional filter argument.
const NO_ARGUMENTS={type:'object',properties:{device_id:{type:'string',description:'Leave unset (default desktop).'}},additionalProperties:false};
export const EVENT_DEFINITIONS=[
  {name:JOB_EVENT,delivery:['webhook'],inputSchema:NO_ARGUMENTS,
    description:'A launcher job needs attention: ChatGPT reported done/failed, the job was blocked, failed, needs review or expired, '+
      'its tab was closed, or the agent went silent (execution unconfirmed). Read chatgpt_task_status(job_id) and continue with chatgpt_continue(chat_ref = chat_id).',
    payloadSchema:{type:'object',properties:{job_id:STRING,request_id:{type:['string','null']},chat_id:{type:['string','null']},
      chat_url:{type:['string','null']},action:STRING,status:STRING,execution:{type:['string','null']},
      summary:{type:'string',maxLength:500},at:STRING},required:['job_id','status','at'],additionalProperties:false}},
  {name:REMINDER_EVENT,delivery:['webhook'],inputSchema:NO_ARGUMENTS,
    description:'Coordination reminder: fewer agents are working than the coordinator asked for, for longer than its idle threshold. '+
      'Check unfinished work and assign useful tasks, explain the wait with a pause, or close the coordination.',
    payloadSchema:{type:'object',properties:{coordination_id:STRING,goal:STRING,active_agents:{type:'integer'},
      min_agents:{type:'integer'},idle_minutes:{type:'number'},below_minimum_since:STRING,
      unfinished:{type:'array',maxItems:10},next_step:STRING,at:STRING},required:['coordination_id','goal','active_agents','min_agents','at'],
      additionalProperties:false}},
];

export function eventId(...parts) {
  return 'evt_'+createHash('sha256').update(parts.join('|')).digest('hex').slice(0,32);
}
export function subscriptionId(name,url) {
  return 'sub_'+createHash('sha256').update(name+'|'+url).digest('hex').slice(0,40);
}
export function validSecret(value) {
  if(typeof value!=='string' || !value.startsWith('whsec_')) return false;
  const raw=value.slice(6);
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  const key=Buffer.from(raw,'base64');
  return key.length>=24 && key.length<=64;
}
// Standard Webhooks 1.0: base64(HMAC-SHA256(key, "id.timestamp.body")).
export function sign(secret,id,timestamp,body) {
  const key=Buffer.from(secret.slice(6),'base64');
  return 'v1,'+createHmac('sha256',key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

// Webhook secrets are stored encrypted with a key derived from the relay's
// private MCP token, so a copy of the state file alone does not reveal them.
export function sealer(mcpToken) {
  const key=Buffer.from(hkdfSync('sha256',mcpToken,'chatgpt-launcher-events','webhook-secret-v1',32));
  return {
    seal(text) {
      const iv=randomBytes(12);
      const c=createCipheriv('aes-256-gcm',key,iv);
      const data=Buffer.concat([c.update(text,'utf8'),c.final()]);
      return [iv,c.getAuthTag(),data].map(b=>b.toString('base64')).join('.');
    },
    open(sealed) {
      const [iv,tag,data]=sealed.split('.').map(s=>Buffer.from(s,'base64'));
      const d=createDecipheriv('aes-256-gcm',key,iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data),d.final()]).toString('utf8');
    },
  };
}

// Separate lists: in one net.BlockList an IPv6 rule such as ::ffff:0:0/96
// also matches every plain IPv4 address (that blocked all IPv4 callbacks).
const PRIVATE4=new net.BlockList(), PRIVATE6=new net.BlockList();
for(const [a,p] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',3]]) PRIVATE4.addSubnet(a,p,'ipv4');
for(const [a,p] of [['::',127],['::ffff:0:0',96],['64:ff9b::',96],['2002::',16],['2001::',32],['fc00::',7],['fe80::',10],['ff00::',8]])
  PRIVATE6.addSubnet(a,p,'ipv6');
export const isPublic=(address,family)=>family===6||family==='IPv6' ?
  !PRIVATE6.check(address,'ipv6') : !PRIVATE4.check(address,'ipv4');

export class DeliveryError extends Error {
  constructor(reason) {super(reason);this.reason=reason;}
}
function checkUrl(value,allowLocal) {
  let u;
  try {u=new URL(value);} catch {throw new DeliveryError('invalid_url');}
  const local=allowLocal && u.protocol==='http:' && ['127.0.0.1','localhost'].includes(u.hostname);
  if((u.protocol!=='https:' && !local) || u.username || u.password || u.hash || value.length>2048)
    throw new DeliveryError('invalid_url');
  return u;
}
// Resolve once, refuse the whole answer if any address is not public.
function publicLookup(host,options,callback) {
  dns.lookup(host,{all:true},(err,addresses)=>{
    if(err || !addresses.length) return callback(err||new DeliveryError('invalid_url'));
    if(!addresses.every(a=>isPublic(a.address,a.family))) return callback(new DeliveryError('invalid_url'));
    if(options?.all) return callback(null,addresses);
    callback(null,addresses[0].address,addresses[0].family);
  });
}

// POSTs one signed JSON body. Returns {status, body}; never follows redirects.
export function postSigned(url,subscription,id,body,secret,{allowLocal=false,timeoutMs=10_000}={}) {
  const u=checkUrl(url,allowLocal);
  const timestamp=Math.floor(Date.now()/1000);
  const headers={'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':String(timestamp),
    'webhook-signature':sign(secret,id,timestamp,body),'X-MCP-Subscription-Id':subscription,
    'Content-Length':Buffer.byteLength(body)};
  const lib=u.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{
    const req=lib.request(u,{method:'POST',headers,timeout:timeoutMs,
      ...(u.protocol==='https:'?{lookup:publicLookup}:{})},res=>{
      const chunks=[];let size=0;
      res.on('data',c=>{size+=c.length;if(size<=65536)chunks.push(c);});
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('timeout',()=>req.destroy(new DeliveryError('timeout')));
    req.on('error',err=>reject(err instanceof DeliveryError?err:new DeliveryError(
      err?.code==='ECONNREFUSED'?'connection_refused':/CERT|SSL|TLS/i.test(err?.code||'')?'tls_error':'connection_failed')));
    req.end(body);
  });
}

export function webhookSender(options={}) {
  return {
    async send(url,subscription,event,secret) {
      const body=JSON.stringify(event);
      if(Buffer.byteLength(body)>262_144) throw new DeliveryError('payload_too_large');
      return postSigned(url,subscription,event.eventId,body,secret,options);
    },
    // The callback must echo the challenge before any event is delivered.
    async verify(url,subscription,secret) {
      const challenge=randomBytes(32).toString('base64url');
      const id='msg_verification_'+randomBytes(16).toString('hex');
      const {status,body}=await postSigned(url,subscription,id,JSON.stringify({type:'verification',challenge}),secret,options);
      let echoed='';
      try {echoed=JSON.parse(body).challenge;} catch {}
      const ok=status>=200 && status<300 && typeof echoed==='string' && echoed.length===challenge.length &&
        timingSafeEqual(Buffer.from(echoed),Buffer.from(challenge));
      if(!ok) throw new DeliveryError('challenge_failed');
    },
  };
}
