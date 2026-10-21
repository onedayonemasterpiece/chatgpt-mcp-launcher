import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const src=await readFile(new URL('../extension/page-driver.js',import.meta.url),'utf8');
function fixture({formOnly=false,ambiguous=false,noButton=false,nativeSubmits=true,
                  noForm=false,delayedButtonPolls=0,draft='',href='https://chatgpt.com/',
                  transientUrls=[],answeringPolls=0,enterDelivers=false}={}) {
 // Each read of a transient address counts as time passing; the final one stays.
 let current=href; const queue=[];
 const location={get href(){if(queue.length&&queue[0].reads--<=0)queue.shift();
     return queue.length?queue[0].url:current;},
   set href(v){current=v;queue.push(...transientUrls.map(url=>({url,reads:8})));}};
 const state={clicks:0,unrelatedClicks:0,insertions:0,nativeSubmits:0,buttonChecks:0,answerChecks:0,enters:0};
 const visible=()=>({width:160,height:34});
 const delivered=()=>{editor.innerText='';location.href='https://chatgpt.com/c/abcd1234';};
 const button={disabled:false,isConnected:true,getBoundingClientRect:visible,
   click:()=>{state.clicks++;delivered();}};
 const other={disabled:false,isConnected:true,getBoundingClientRect:visible,
   click:()=>state.unrelatedClicks++};
 const form={isConnected:true,
   contains:b=>b===editor||b===button||(ambiguous&&b===other),
   querySelectorAll:q=>q==='[contenteditable="true"],textarea'?[editor]:
     q==='button[type="submit"]'&&!noButton?[button]:[],
   requestSubmit:()=>{state.nativeSubmits++;if(nativeSubmits)delivered();}};
 const editor={id:'prompt-textarea',innerText:draft,textContent:'',isConnected:true,
   getBoundingClientRect:visible,getAttribute:()=>null,
   matches:selector=>selector==='[data-testid="composer-text-input"]',
   closest:selector=>selector==='form'&&!noForm?form:null,
   focus:()=>{document.activeElement=editor;},
   dispatchEvent:event=>{
     if(event.type==='keydown'&&event.key==='Enter'){state.enters++;if(enterDelivers)delivered();}
     return true;
   }};
 const document={
   activeElement:null,
   querySelectorAll(selector) {
     if(selector.includes('stop-button')) {
       if(state.answerChecks++<answeringPolls) return [{isConnected:true,getBoundingClientRect:visible}];
       return [];
     }
     if(selector==='[contenteditable="true"],textarea') return [editor];
     if(formOnly||noButton) return [];
     if(selector==='button[data-testid="composer-send-button"]') {
       state.buttonChecks++;
       if(state.buttonChecks<=delayedButtonPolls)return [];
       return ambiguous?[button,other]:[button];
     }
     return [];
   },
   execCommand:(command,_show,text)=>{
     if(command==='insertParagraph'){editor.innerText+='\n';return true;}
     assert.equal(command,'insertText');state.insertions++;editor.innerText+=text;return true;}
 };
 const sandbox={window:{location,getComputedStyle:()=>({visibility:'visible',display:'block'})},
   document,globalThis:null,URL,InputEvent:class InputEvent {},
   setTimeout:cb=>{Promise.resolve().then(cb);return 1;}};
 sandbox.KeyboardEvent=class KeyboardEvent {constructor(type,init){Object.assign(this,init,{type});}};
 sandbox.globalThis=sandbox;
 runInNewContext(src,sandbox,{timeout:1500,filename:'page-driver.js'});
 return {run:sandbox.chatGPTLauncherRun,state,editor};
}

test('ping submits using a unique composer Send button exactly once',async()=>{
 const f=fixture();
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(f.state.clicks,1);
 assert.equal(f.state.nativeSubmits,0);
 assert.equal(f.state.insertions,1);
 assert.equal(f.state.unrelatedClicks,0);
});

test('unlabelled form submit button works when tied to identified composer',async()=>{
 const f=fixture({formOnly:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(f.state.clicks,1);
 assert.equal(f.state.nativeSubmits,0);
});

test('ambiguous send controls remain blocked; no attempted fallback submission',async()=>{
 const f=fixture({ambiguous:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'blocked',JSON.stringify(result));
 assert.equal(f.state.clicks,0);
 assert.equal(f.state.nativeSubmits,0);
 assert.equal(f.state.unrelatedClicks,0);
 assert.equal(f.editor.innerText,'ping');
});

test('explicit effort picker failure keeps current model, but never repeats send',async()=>{
 const f=fixture();
 const result=await f.run({action:'start',prompt:'ping',effort:'xhigh'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(f.state.clicks,1);
 assert.match(result.message,/Effort left unchanged/);
});

test('an existing user draft is never overwritten',async()=>{
 const f=fixture({draft:'my unsent text',href:'https://chatgpt.com/c/abcd1234'});
 const result=await f.run({action:'continue',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'blocked');
 assert.match(result.message,/draft/);
 assert.equal(f.editor.innerText,'my unsent text');
 assert.equal(f.state.insertions,0);
 assert.equal(f.state.clicks+f.state.nativeSubmits,0);
});

test('a new chat reports the final slug, never a temporary local or intermediate address',async()=>{
 const f=fixture({transientUrls:['https://chatgpt.com/local/abc123456','https://chatgpt.com/c/local-abc123456',
   'https://chatgpt.com/c/ffff0000-temp']});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(result.chat_url,'https://chatgpt.com/c/abcd1234');
 assert.equal(f.state.clicks,1);
});

function readFixture({replies=[],streaming=false,href='https://chatgpt.com/c/abcd1234'}={}) {
 const visible=()=>({width:160,height:34});
 const state={clicks:0,insertions:0};
 const editor={id:'prompt-textarea',innerText:'',textContent:'',isConnected:true,getBoundingClientRect:visible,
   getAttribute:()=>null,matches:()=>false,closest:()=>null,focus:()=>{},dispatchEvent:()=>true};
 const stop={isConnected:true,getBoundingClientRect:visible,click:()=>state.clicks++};
 const document={
   querySelectorAll(selector) {
     if(selector==='[contenteditable="true"],textarea') return [editor];
     if(selector==='[data-message-author-role="assistant"]') return replies.map(text=>({innerText:text}));
     if(selector.includes('stop-button')) return streaming?[stop]:[];
     return [];
   },
   execCommand:()=>{state.insertions++;return true;}
 };
 const sandbox={window:{location:{href},getComputedStyle:()=>({visibility:'visible',display:'block'})},
   document,globalThis:null,URL,InputEvent:class InputEvent {},
   setTimeout:cb=>{Promise.resolve().then(cb);return 1;}};
 sandbox.globalThis=sandbox;
 runInNewContext(src,sandbox,{timeout:1500,filename:'page-driver.js'});
 return {read:sandbox.chatGPTLauncherRead,state};
}

test('read returns the last ChatGPT reply and never types or clicks',async()=>{
 const f=readFixture({replies:['PONG','  PONG2  ']});
 const result=await f.read({action:'read'});
 assert.equal(result.status,'read');
 assert.equal(result.reply_text,'PONG2');
 assert.equal(result.reply_generating,false);
 assert.equal(result.chat_url,'https://chatgpt.com/c/abcd1234');
 assert.equal(f.state.clicks+f.state.insertions,0);
});

test('read reports a reply that is still being written, and an empty chat',async()=>{
 const busy=await readFixture({replies:['PO'],streaming:true}).read({action:'read'});
 assert.equal(busy.reply_generating,true);
 assert.match(busy.message,/still writing/);
 const empty=await readFixture().read({action:'read'});
 assert.equal(empty.status,'read');
 assert.equal(empty.reply_text,null);
 const wrong=await readFixture({href:'https://chatgpt.com/'}).read({action:'read'});
 assert.equal(wrong.status,'blocked');
});


test('continue waits until ChatGPT finishes answering, then sends once',async()=>{
 const f=fixture({href:'https://chatgpt.com/c/abcd1234',answeringPolls:30});
 const result=await f.run({action:'continue',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.ok(f.state.answerChecks>30);
 assert.equal(f.state.clicks,1);
});

test('an answer that never ends blocks the continue without sending anything',async()=>{
 const f=fixture({href:'https://chatgpt.com/c/abcd1234',answeringPolls:1e9});
 const result=await f.run({action:'continue',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'blocked');
 assert.match(result.message,/nothing was sent/);
 assert.equal(f.state.insertions+f.state.clicks+f.state.nativeSubmits,0);
});

test('no Send button and no composer form: one Enter into the composer submits',async()=>{
 const f=fixture({noButton:true,noForm:true,enterDelivers:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.match(result.message,/Enter/);
 assert.equal(f.state.enters,1);
 assert.equal(f.state.clicks+f.state.nativeSubmits,0);
});

test('an Enter that does not deliver is never repeated',async()=>{
 const f=fixture({noButton:true,noForm:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'needs_review');
 assert.equal(f.state.enters,1);
});

test('the launcher app is mentioned on a new line, picked with a space, then sent once',async()=>{
 const f=fixture();
 const result=await f.run({action:'start',prompt:'ping',effort:'auto',mention:'Chatgpt task lancher'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(f.state.insertions,3,'prompt, @mention, space');
 assert.equal(f.state.clicks,1);
});

test('a malformed app name is never typed',async()=>{
 const f=fixture();
 const result=await f.run({action:'start',prompt:'ping',effort:'auto',mention:'x<script>'});
 assert.equal(result.status,'sent');
 assert.equal(f.state.insertions,1);
});
