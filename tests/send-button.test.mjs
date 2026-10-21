import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const src=await readFile(new URL('../extension/page-driver.js',import.meta.url),'utf8');
function fixture({formOnly=false,ambiguous=false,noButton=false,enterSubmits=true,draft='',href='https://chatgpt.com/'}={}) {
 const location={href};
 const state={clicks:0,unrelatedClicks:0,insertions:0,enters:0};
 const visible=()=>({width:160,height:34});
 const button={disabled:false,isConnected:true,getBoundingClientRect:visible,
   click:()=>{state.clicks++;editor.innerText='';location.href='https://chatgpt.com/c/abcd1234';}};
 const other={disabled:false,isConnected:true,getBoundingClientRect:visible,click:()=>state.unrelatedClicks++};
 const form={contains:b=>b===button||(ambiguous&&b===other),querySelectorAll:q=>q==='button[type="submit"]'&&!noButton?[button]:[]};
 const editor={id:'prompt-textarea',innerText:draft,textContent:'',isConnected:true,
   getBoundingClientRect:visible,getAttribute:()=>null,
   matches:selector=>selector==='[data-testid="composer-text-input"]',
   closest:selector=>selector==='form'?form:null,
   focus:()=>{document.activeElement=editor;},
   dispatchEvent:event=>{
     if(event.type!=='keydown'||event.key!=='Enter')return true;
     state.enters++;
     if(enterSubmits){editor.innerText='';location.href='https://chatgpt.com/c/abcd1234';}
     return true;
   }};
 const document={
   activeElement:null,
   querySelectorAll(selector) {
     if(selector==='[contenteditable="true"],textarea') return [editor];
     if(formOnly||noButton) return [];
     if(selector==='button[data-testid="composer-send-button"]') return ambiguous?[button,other]:[button];
     if(selector==='button[type="submit"]') return [];
     return [];
   },
   execCommand:(command,_show,prompt)=>{
     assert.equal(command,'insertText');state.insertions++;editor.innerText=prompt;return true;}
 };
 const sandbox={window:{location,getComputedStyle:()=>({visibility:'visible',display:'block'})},
   document,globalThis:null,URL,InputEvent:class InputEvent {},
   KeyboardEvent:class KeyboardEvent {constructor(type,init){Object.assign(this,init,{type});}},
   setTimeout:cb=>{Promise.resolve().then(cb);return 1;}};
 sandbox.globalThis=sandbox;
 runInNewContext(src,sandbox,{timeout:1500,filename:'page-driver.js'});
 return {run:sandbox.chatGPTLauncherRun,state,editor};
}

test('ping submits using a uniquely identified modern ChatGPT Send button',async()=>{
 const f=fixture();
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(f.state.clicks,1);assert.equal(f.state.insertions,1);
 assert.equal(f.state.unrelatedClicks,0);
});

test('unlabelled form submit works only when attached to the identified composer form',async()=>{
 const f=fixture({formOnly:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(f.state.clicks,1);
});

test('ambiguous Send controls are never clicked; one Enter submits instead',async()=>{
 const f=fixture({ambiguous:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(f.state.clicks,0);
 assert.equal(f.state.unrelatedClicks,0);
 assert.equal(f.state.enters,1);
 assert.match(result.message,/Enter/);
});

test('missing Send button falls back to a single Enter and reports the new slug',async()=>{
 const f=fixture({noButton:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(result.chat_url,'https://chatgpt.com/c/abcd1234');
 assert.equal(f.state.enters,1);
});

test('Enter that does not submit is never repeated and is left for review',async()=>{
 const f=fixture({noButton:true,enterSubmits:false});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'needs_review');
 assert.equal(f.state.enters,1,'no second submit after an uncertain outcome');
 assert.equal(f.editor.innerText,'ping');
});

test('an unavailable effort picker does not block the launch',async()=>{
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
 assert.equal(f.state.clicks+f.state.enters,0);
});
