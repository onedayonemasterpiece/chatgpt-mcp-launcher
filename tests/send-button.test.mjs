import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const src=await readFile(new URL('../extension/page-driver.js',import.meta.url),'utf8');
function fixture({formOnly=false,ambiguous=false,noButton=false,nativeSubmits=true,
                  noForm=false,delayedButtonPolls=0,draft='',href='https://chatgpt.com/'}={}) {
 const location={href};
 const state={clicks:0,unrelatedClicks:0,insertions:0,nativeSubmits:0,buttonChecks:0};
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
   focus:()=>{document.activeElement=editor;},dispatchEvent:()=>true};
 const document={
   activeElement:null,
   querySelectorAll(selector) {
     if(selector==='[contenteditable="true"],textarea') return [editor];
     if(formOnly||noButton) return [];
     if(selector==='button[data-testid="composer-send-button"]') {
       state.buttonChecks++;
       if(state.buttonChecks<=delayedButtonPolls)return [];
       return ambiguous?[button,other]:[button];
     }
     return [];
   },
   execCommand:(command,_show,prompt)=>{
     assert.equal(command,'insertText');state.insertions++;editor.innerText=prompt;return true;}
 };
 const sandbox={window:{location,getComputedStyle:()=>({visibility:'visible',display:'block'})},
   document,globalThis:null,URL,InputEvent:class InputEvent {},
   setTimeout:cb=>{Promise.resolve().then(cb);return 1;}};
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

test('Send control appearing after a simulated 85 seconds still launches once',async()=>{
 const f=fixture({noForm:true,delayedButtonPolls:340});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.ok(f.state.buttonChecks>340);
 assert.equal(f.state.clicks,1);
 assert.equal(f.state.nativeSubmits,0);
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

test('missing named Send button requests exactly one browser-native form submission',async()=>{
 const f=fixture({noButton:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'sent',JSON.stringify(result));
 assert.equal(result.chat_url,'https://chatgpt.com/c/abcd1234');
 assert.match(result.message,/Native form submit/);
 assert.equal(f.state.nativeSubmits,1);
 assert.equal(f.state.clicks,0);
});

test('native form submission with uncertain result is never repeated',async()=>{
 const f=fixture({noButton:true,nativeSubmits:false});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'needs_review',JSON.stringify(result));
 assert.equal(f.state.nativeSubmits,1);
 assert.equal(f.editor.innerText,'ping');
});

test('without a composer form or trusted button no synthetic Enter is dispatched',async()=>{
 const f=fixture({noButton:true,noForm:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'blocked',JSON.stringify(result));
 assert.equal(f.state.nativeSubmits+f.state.clicks,0);
 assert.doesNotMatch(src,/new KeyboardEvent\(/);
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
