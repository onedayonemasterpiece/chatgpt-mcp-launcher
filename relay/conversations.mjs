// Pure, privacy-minimal ChatGPT conversation identity helpers.
// This module never reads page content, model output or browser cookies.
export const MAX_CHATS=2000;
// ChatGPT shows a temporary "local" ID before the real one exists.
const ID=/^(?!local)[a-zA-Z0-9-]{8,90}$/i;
const PROJECT=/^[a-zA-Z0-9-]{5,160}$/;
export function canonicalChatUrl(input) {
  if(typeof input!=='string' || input.length>1000) return null;
  try {
    const u=new URL(input);
    if(u.protocol!=='https:' || u.hostname!=='chatgpt.com' || u.username ||
       u.password || u.port || u.search || u.hash) return null;
    const parts=u.pathname.replace(/\/+$/,'').split('/').filter(Boolean);
    if(parts.length===2 && parts[0]==='c' && ID.test(parts[1]))
      return 'https://chatgpt.com/c/'+parts[1];
    if(parts.length===4 && parts[0]==='g' && PROJECT.test(parts[1]) &&
       parts[2]==='c' && ID.test(parts[3]))
      return 'https://chatgpt.com/g/'+parts[1]+'/c/'+parts[3];
  } catch {}
  return null;
}
export function chatIdFromUrl(url) {
  const canonical=canonicalChatUrl(url);
  return canonical?canonical.split('/').at(-1):null;
}
export function referenceToUrl(reference,chats=[],jobs=[]) {
  if(typeof reference!=='string' || reference.length>1024) return null;
  const ref=reference.trim();
  const url=canonicalChatUrl(ref);
  if(url) return url;
  const job=jobs.find(j=>j.id===ref);
  const fromJob=canonicalChatUrl(job?.result_chat_url);
  if(fromJob) return fromJob;
  // The registry keeps job IDs after old jobs are pruned from the queue.
  const known=chats.find(c=>[c.chat_id,c.source_job_id,c.last_job_id].includes(ref));
  if(known) return canonicalChatUrl(known.chat_url);
  if(job) return null; // a known job that never reached a conversation
  // A caller with an exact bare slug may open it, but existence is not assumed.
  if(ID.test(ref)) return 'https://chatgpt.com/c/'+ref;
  return null;
}
export function recordedChat(chatUrl,deviceId,jobId,previous=null,now=new Date().toISOString(),transport='observed') {
  const canonical=canonicalChatUrl(chatUrl);
  if(!canonical)throw Error('Invalid canonical ChatGPT conversation URL');
  if(typeof deviceId!=='string'||!deviceId)throw Error('Invalid device id');
  return {
    chat_url:canonical,
    chat_id:chatIdFromUrl(canonical),
    device_id:deviceId,
    first_seen_at:previous?.first_seen_at||now,
    last_seen_at:now,
    source_job_id:previous?.source_job_id||jobId||null,
    last_job_id:jobId||previous?.last_job_id||null,
    transport_status:transport
  };
}
