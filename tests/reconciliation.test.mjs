import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {FileQueue} from '../relay/queue.mjs';

const ID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const URL='https://chatgpt.com/c/'+ID;
const KEY='test-'+'x'.repeat(32);
async function setup(t,options={}) {
  const dir=await mkdtemp(join(tmpdir(),'launcher-reconcile-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'queue.json');
  const q=new FileQueue(file,{desktop:KEY},options);
  await q.initialize();
  return {q,file};
}
async function ambiguous(q) {
  const first=await q.enqueue({action:'start',prompt:'original'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:first.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:first.id,status:'done'});
  const follow=await q.enqueue({action:'continue',chat_ref:ID,prompt:'do not duplicate',request_id:'original-continue'});
  const claimed=await q.claim('desktop');
  assert.equal(claimed.id,follow.id);
  await q.report('desktop',{job_id:follow.id,status:'needs_review',chat_url:URL,
    message:'Frame 0 was removed',page_state:{composer_text:'empty'}});
  assert.equal(q.status(follow.id).status,'needs_review');
  return follow;
}
test('one read-only probe confirms original delivery without rerunning or fabricating model status',async t=>{
  const {q,file}=await setup(t);
  const original=await ambiguous(q);
  assert.equal(q.listChats().chats[0].continuation_count,0);
  const probe=await q.reconcile(original.id,'probe-1');
  assert.equal(probe.action,'reconcile');
  assert.equal(probe.prompt,undefined);
  assert.equal((await q.reconcile(original.id,'probe-2')).id,probe.id,'concurrent probes coalesce');
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'new work'}),/needs review|reconcile/i);
  const worker=await q.claim('desktop');
  assert.equal(worker.action,'reconcile');
  assert.equal(worker.verify_job_id,original.id);
  assert.equal(worker.prompt,null);
  const done=await q.report('desktop',{job_id:probe.id,status:'read',chat_url:URL,
    delivery_evidence:'sent',evidence_kind:'user_message_marker'});
  assert.equal(done.status,'read');
  assert.equal(done.reconcile_status,'sent');
  const resolved=q.status(original.id);
  assert.equal(resolved.status,'sent');
  assert.equal(resolved.delivery_counted,true);
  assert.equal(resolved.continuation_count,1);
  assert.equal(resolved.model_status,undefined,'no invented model completion or started');
  assert.equal(resolved.execution,'awaiting_confirmation');
  assert.equal((await q.reconcile(original.id,'probe-1')).id,probe.id,'same request_id is idempotent after resolution');
  const state=JSON.parse(await readFile(file,'utf8'));
  assert.equal(state.jobs.filter(j=>j.id===original.id).length,1);
  const reload=new FileQueue(file,{desktop:KEY});
  await reload.initialize();
  assert.equal(reload.status(original.id).continuation_count,1);
  assert.equal((await reload.reconcile(original.id,'probe-1')).id,probe.id);
  await assert.rejects(reload.enqueue({action:'continue',chat_ref:ID,prompt:'never duplicate active'}),/unconfirmed|working/i);
});

test('unreadable DOM, missing marker and mismatched URL cannot resolve unknown',async t=>{
  const {q}=await setup(t);
  const original=await ambiguous(q);
  const p=await q.reconcile(original.id,'missing');
  await q.claim('desktop');
  const unknown=await q.report('desktop',{job_id:p.id,status:'read',chat_url:URL,
    delivery_evidence:'unknown',evidence_kind:'unconfirmed'});
  assert.equal(unknown.reconcile_status,'needs_review');
  assert.equal(q.status(original.id).status,'needs_review');
  const second=await q.reconcile(original.id,'different-tab');
  await q.claim('desktop');
  const bad=await q.report('desktop',{job_id:second.id,status:'read',
    chat_url:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    delivery_evidence:'sent',evidence_kind:'conversation_marker'});
  assert.equal(bad.reconcile_status,'needs_review');
  assert.equal(q.status(original.id).continuation_count,0);
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'not safe'}),/needs review|reconcile/i);
  await assert.rejects(q.retry(original.id),/may already have been sent/i);
  assert.equal(q.status(original.id).fallback_job_id,undefined);
});

test('mismatched/spoofed evidence and duplicate request IDs never change original job',async t=>{
  const {q}=await setup(t);
  const original=await ambiguous(q);
  const check=await q.reconcile(original.id,'proof');
  await assert.rejects(q.reconcile(original.id,'original-continue'),/Idempotency key belongs/i);
  await q.claim('desktop');
  const bad=await q.report('desktop',{job_id:check.id,status:'read',chat_url:URL,
    delivery_evidence:'sent',evidence_kind:'unknown'});
  assert.equal(bad.reconcile_status,'needs_review');
  assert.equal(q.status(original.id).status,'needs_review');
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'another'}),/needs review|reconcile/i);
  assert.equal((await q.reconcile(original.id,'proof')).id,check.id);
});

test('late real model report after unreadable reconciliation resolves only delivery and counts once',async t=>{
  const {q}=await setup(t);
  const original=await ambiguous(q);
  const check=await q.reconcile(original.id,'maybe');
  await q.claim('desktop');
  await q.report('desktop',{job_id:check.id,status:'read',chat_url:URL,
    delivery_evidence:'unknown'});
  await q.modelReport({job_id:original.id,status:'started'});
  assert.equal(q.status(original.id).continuation_count,1);
  await q.modelReport({job_id:original.id,status:'done',summary:'actual work result'});
  assert.equal(q.status(original.id).model_summary,'actual work result');
  assert.equal(q.status(original.id).continuation_count,1);
});

test('terminal reply evidence persists on the original sent job and permits safe continuation',async t=>{
  let now=Date.now();
  const {q,file}=await setup(t,{now:()=>now,confirmMs:1});
  const opening=await q.enqueue({action:'start',prompt:'opening'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:opening.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:opening.id,status:'done'});
  const original=await q.enqueue({action:'continue',chat_ref:ID,prompt:'work item'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:original.id,status:'sent',chat_url:URL});
  now+=2;
  assert.equal(q.status(original.id).execution,'unconfirmed');
  await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'too early'}),/unconfirmed/i);
  const check=await q.reconcile(original.id,'terminal-check');
  await q.claim('desktop');
  const result=await q.report('desktop',{job_id:check.id,status:'read',chat_url:URL,
    delivery_evidence:'sent',evidence_kind:'user_message_marker',execution_evidence:'page_completed'});
  assert.equal(result.reconcile_evidence,'page_completed');
  const observed=q.status(original.id);
  assert.equal(observed.status,'sent');
  assert.equal(observed.execution,'page_completed');
  assert.ok(observed.page_completed_at);
  assert.equal(observed.model_status,undefined,'page proof cannot fabricate a model report');
  assert.equal(observed.continuation_count,1);
  assert.equal((await q.reconcile(original.id,'terminal-check')).id,check.id,'same reconciliation is idempotent');
  assert.equal(q.status(original.id).page_completed_at,observed.page_completed_at);
  const following=await q.enqueue({action:'continue',chat_ref:ID,prompt:'next work item'});
  assert.equal(following.status,'queued');
  const reload=new FileQueue(file,{desktop:KEY},{now:()=>now,confirmMs:1});
  await reload.initialize();
  assert.equal(reload.status(original.id).execution,'page_completed');
  assert.equal(reload.status(original.id).page_completed_at,observed.page_completed_at);
  await reload.modelReport({job_id:original.id,status:'done',summary:'actual model receipt'});
  assert.equal(reload.status(original.id).execution,'done','late model report takes precedence');
  assert.equal(reload.status(original.id).page_completed_at,observed.page_completed_at);
});

test('no exact user marker or unfinished assistant answer cannot clear unconfirmed execution',async t=>{
  let now=Date.now();
  const {q}=await setup(t,{now:()=>now,confirmMs:1});
  const opening=await q.enqueue({action:'start',prompt:'opening'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:opening.id,status:'sent',chat_url:URL});
  await q.modelReport({job_id:opening.id,status:'done'});
  const original=await q.enqueue({action:'continue',chat_ref:ID,prompt:'work item'});
  await q.claim('desktop');
  await q.report('desktop',{job_id:original.id,status:'sent',chat_url:URL});
  now+=2;
  for(const [i,evidence] of [
    {delivery_evidence:'sent',evidence_kind:'user_message_marker',execution_evidence:'unknown'},
    {delivery_evidence:'unknown',evidence_kind:'unconfirmed',execution_evidence:'page_completed'},
    {delivery_evidence:'sent',evidence_kind:'conversation_marker',execution_evidence:'page_completed'},
  ].entries()) {
    const check=await q.reconcile(original.id,'negative-'+i);
    await q.claim('desktop');
    await q.report('desktop',{job_id:check.id,status:'read',chat_url:URL,...evidence});
    assert.equal(q.status(original.id).execution,'unconfirmed');
    assert.equal(q.status(original.id).page_completed_at,undefined);
    await assert.rejects(q.enqueue({action:'continue',chat_ref:ID,prompt:'unsafe'}),/unconfirmed/i);
  }
});

const driver=await readFile(new globalThis.URL('../extension/page-driver.js',import.meta.url),'utf8');
test('read exposes categorical page state even when conversation messages are unreadable',async()=>{
  for (const banner of ['Connection lost','Соединение прервано','']) {
    const editor={id:'prompt-textarea',innerText:'private unsent draft',isConnected:true,
      getBoundingClientRect:()=>({width:300,height:40}),matches:()=>false,
      getAttribute:()=>null,closest:()=>null};
    const stop={isConnected:true,getBoundingClientRect:()=>({width:30,height:30})};
    const document={body:{innerText:banner+' private conversation content'},
      querySelectorAll(selector){
        if(selector==='[contenteditable="true"],textarea')return [editor];
        if(selector.includes('stop-button'))return [stop];
        return [];
      },
      execCommand(){throw Error('read must never type');}};
    const context={document,window:{location:{href:URL},
      getComputedStyle:()=>({visibility:'visible',display:'block'})},URL:globalThis.URL,
      setTimeout:fn=>{queueMicrotask(fn);return 1;}};
    context.globalThis=context;
    runInNewContext(driver,context,{timeout:2000});
    const result=await context.chatGPTLauncherRead({action:'read'});
    assert.equal(result.status,'read');
    assert.equal(result.reply_text,null);
    assert.equal(result.reply_generating,true,'Stop is an observation, not a completed job');
    assert.equal(result.page_state.connection_lost,!!banner);
    assert.equal(result.page_state.composer,'present');
    assert.equal(result.page_state.composer_text,'other_draft');
    assert.equal(result.page_state.user_messages,0);
    assert.equal(result.page_state.assistant_messages,0);
    assert.equal(JSON.stringify(result).includes('private'),false);
  }
});
function inspect({main='',user='',assistant='',generating=false,draft='',wrongPage=false,noMain=false,
                  unknownComposer=false,ambiguousComposer=false,
                  mainEditable='',userEditable='',mainHidden='',userHidden=''}={}) {
  const editor={id:unknownComposer?'unrecognized-editor':'prompt-textarea',
    innerText:draft,textContent:draft,isConnected:true,
    getBoundingClientRect:()=>({width:300,height:40}),matches:()=>false,getAttribute:()=>null};
  const editableSelector='[contenteditable],textarea,input,[role="textbox"],[role="searchbox"]';
  const rect=hidden=>hidden?{width:0,height:0}:{width:300,height:40};
  const leaf=(value,{hidden=false,editable=false}={})=>({
    innerText:value,textContent:value,isConnected:true,children:[],
    matches:selector=>editable&&selector===editableSelector,
    getBoundingClientRect:()=>rect(hidden),
    hiddenInFixture:hidden,querySelectorAll:()=>[]
  });
  const node=(ordinary,editable='',hidden='')=>{
    const parts=[
      ...(ordinary?[leaf(ordinary)]:[]),
      ...(hidden?[leaf(hidden,{hidden:true})]:[]),
      ...(editable?[leaf(editable,{editable:true})]:[])
    ];
    // Attached live innerText omits hidden text; a DETACHED clone's innerText
    // falls back to textContent, which used to prove a false delivery.
    return {
      innerText:ordinary+editable,textContent:ordinary+editable+hidden,
      children:parts,isConnected:true,
      getBoundingClientRect:()=>rect(false),matches:()=>false,
      querySelectorAll:selector=>selector===editableSelector?
        parts.filter(el=>el.matches(editableSelector)):[],
      cloneNode(){
        let text=ordinary+editable+hidden;
        return {get innerText(){return text;},get textContent(){return text;},
          querySelectorAll:selector=>selector===editableSelector&&editable?
            [{remove(){text=ordinary+hidden;}}]:[]};
      }
    };
  };
  const mainNode=node(main,mainEditable,mainHidden);
  const userNode=node(user,userEditable,userHidden);
  userNode.getAttribute=name=>name==='data-message-author-role'?'user':null;
  const assistantNode=node(assistant);
  assistantNode.getAttribute=name=>name==='data-message-author-role'?'assistant':null;
  const another=ambiguousComposer?{...editor}:null;
  const document={
    querySelectorAll(selector){
      if(selector==='[contenteditable="true"],textarea')
        return ambiguousComposer?[editor,another]:[editor];
      if(selector==='main')return noMain?[]:[mainNode];
      if(selector==='[data-message-author-role="user"]')
        return user||userEditable||userHidden?[userNode]:[];
      if(selector==='[data-message-author-role="user"],[data-message-author-role="assistant"]')
        return [...(user||userEditable||userHidden?[userNode]:[]),...(assistant?[assistantNode]:[])];
      if(selector.includes('stop-button'))return generating?[{isConnected:true,getBoundingClientRect:()=>rect(false)}]:[];
      return [];
    }
  };
  const context={document,window:{location:{href:wrongPage?'https://chatgpt.com/':URL},
    getComputedStyle:el=>({visibility:'visible',display:el?.hiddenInFixture?'none':'block'})},
    globalThis:null,URL:globalThis.URL,setTimeout:fn=>{queueMicrotask(fn);return 1;}};
  context.globalThis=context;
  runInNewContext(driver,context,{timeout:2000});
  return context.chatGPTLauncherReconcile({action:'reconcile',verify_job_id:ID});
}
test('read-only browser probe accepts exact user marker; never returns conversation content',async()=>{
  const result=await inspect({user:'Hello job_id='+ID+' done',main:'unrelated'});
  assert.equal(result.delivery_evidence,'sent');
  assert.equal(result.evidence_kind,'user_message_marker');
  assert.equal(JSON.stringify(result).includes('Hello'),false);
});
test('read-only browser probe handles marker inside visible main without role selectors',async()=>{
  const result=await inspect({main:'Conversation turn: job_id='+ID+' current'});
  assert.equal(result.delivery_evidence,'sent');
  assert.equal(result.evidence_kind,'conversation_marker');
});
test('unrecognized or ambiguous composer and marker only in unsent contenteditable cannot prove delivery',async()=>{
  const marker='job_id='+ID;
  // Reproduces root review #6366449691: main.innerText contains a marker
  // exclusively because the UNSENT editor is nested inside main.
  for(const sample of [
    {unknownComposer:true,mainEditable:marker},
    {ambiguousComposer:true,mainEditable:marker},
    {mainEditable:marker},
    {unknownComposer:true,main:'Visible unrelated text '+marker},
    {ambiguousComposer:true,main:'Visible unrelated text '+marker},
    {userEditable:marker},
    {unknownComposer:true,userEditable:marker}
  ]) {
    const result=await inspect(sample);
    assert.equal(result.delivery_evidence,'unknown',JSON.stringify(sample));
    assert.equal(result.evidence_kind,'unconfirmed');
    assert.ok(!JSON.stringify(result).includes('Visible unrelated text'));
  }
});
test('hidden noneditable marker is never delivery evidence; visible marker still proves delivery',async()=>{
  const marker='job_id='+ID;
  // Root re-review reproduction: LIVE main.innerText is empty but detached
  // clone's innerText/textContent contains a hidden non-editable marker.
  for(const sample of [
    {mainHidden:marker},
    {userHidden:marker},
    {mainHidden:marker,mainEditable:'a different unsent draft'},
    {mainHidden:marker,mainEditable:marker},
    {mainHidden:marker,unknownComposer:true}
  ]) {
    const result=await inspect(sample);
    assert.equal(result.delivery_evidence,'unknown',JSON.stringify(sample));
    assert.equal(result.evidence_kind,'unconfirmed');
  }
  const shown=await inspect({main:'Visible delivered message job_id='+ID});
  assert.equal(shown.delivery_evidence,'sent','rendered marker outside editor stays valid');
  assert.equal(shown.evidence_kind,'conversation_marker');
  const user=await inspect({user:'Visible user turn job_id='+ID});
  assert.equal(user.delivery_evidence,'sent','rendered user turn remains valid');
  assert.equal(user.evidence_kind,'user_message_marker');
});
test('browser proves terminal execution only with exact user turn, later answer and stopped generation',async()=>{
  const marker='job_id='+ID;
  const completed=await inspect({user:'Prompt '+marker,assistant:'Finished answer'});
  assert.equal(completed.delivery_evidence,'sent');
  assert.equal(completed.execution_evidence,'page_completed');
  for(const sample of [
    {user:'Prompt '+marker,assistant:'Partial answer',generating:true},
    {user:'Prompt '+marker,assistant:''},
    {main:'Page contains '+marker,assistant:'Unrelated assistant answer'},
    {user:'No target marker',assistant:'Finished answer'},
    {user:'Prompt '+marker,assistant:'Finished answer',wrongPage:true},
    {userEditable:marker,assistant:'Finished answer'}
  ]) {
    const result=await inspect(sample);
    assert.equal(result.execution_evidence,'unknown',JSON.stringify(sample));
  }
  assert.equal(JSON.stringify(completed).includes('Finished answer'),false,'no page text returned');
});

test('marker only in unsent editor, absent content or unrendered page is NEVER sent evidence',async()=>{
  for(const sample of [{main:'',draft:'job_id='+ID},
    {main:'job_id='+ID,draft:'job_id='+ID},
    {main:''},{main:'job_id='+ID,noMain:true},
    {main:'job_id='+ID,wrongPage:true}]) {
    const result=await inspect(sample);
    assert.equal(result.delivery_evidence,'unknown',JSON.stringify(sample));
  }
});
