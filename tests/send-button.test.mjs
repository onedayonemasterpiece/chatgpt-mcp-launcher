import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const src=await readFile(new URL('../extension/page-driver.js',import.meta.url),'utf8');
function fixture({formOnly=false,ambiguous=false}={}) {
 const location={href:'https://chatgpt.com/'};
 const state={clicks:0,unrelatedClicks:0,insertions:0};
 const visible=()=>({width:160,height:34});
 const button={disabled:false,isConnected:true,getBoundingClientRect:visible,
   click:()=>{state.clicks++;editor.innerText='';location.href='https://chatgpt.com/c/abcd1234';}};
 const other={disabled:false,isConnected:true,getBoundingClientRect:visible,click:()=>state.unrelatedClicks++};
 const form={contains:b=>b===button||(ambiguous&&b===other),querySelectorAll:q=>q==='button[type="submit"]'?[button]:[]};
 const editor={id:'prompt-textarea',innerText:'',textContent:'',isConnected:true,
   getBoundingClientRect:visible,getAttribute:()=>null,
   matches:selector=>selector==='[data-testid="composer-text-input"]',
   closest:selector=>selector==='form'?form:null,
   focus:()=>{},dispatchEvent:()=>{}};
 const document={
   querySelectorAll(selector) {
     if(selector==='[contenteditable="true"],textarea') return [editor];
     if(formOnly) return [];
     if(selector==='button[data-testid="composer-send-button"]') return ambiguous?[button,other]:[button];
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

test('ambiguous Send controls fail closed without dispatching a click',async()=>{
 const f=fixture({ambiguous:true});
 const result=await f.run({action:'start',prompt:'ping',effort:'auto'});
 assert.equal(result.status,'blocked');
 assert.equal(f.state.clicks,0);
 assert.equal(f.state.unrelatedClicks,0);
 assert.equal(f.editor.innerText,'ping','unsent draft left for manual review');
});
