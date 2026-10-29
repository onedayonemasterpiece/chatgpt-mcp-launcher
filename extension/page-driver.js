/* Runs only inside chatgpt.com in Chrome's isolated extension world. No output scraping. */
(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const normal = s => (s || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const names = {
    medium: ['medium', 'средний', 'среднее'],
    high: ['high', 'высокий', 'высокое'],
    xhigh: ['extra high', 'very high', 'очень высокий', 'очень высокое', 'максимальный'],
  };
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
  function matchesEffort(text, effort) {
    const s = normal(text);
    const expected = names[effort] || [];
    return expected.some(x => s === x || s === `${x} selected` || s === `${x} выбрано`);
  }
  function getEffortText(text) {
    const s = normal(text);
    for (const key of ['xhigh', 'medium', 'high']) {
      if ((names[key] || []).some(w => s.includes(w))) return key;
    }
    return null;
  }
  function modelPicker() {
    return [...document.querySelectorAll('button')].find(b => visible(b) &&
      /выбрать модель chatgpt|choose.*model|model selector/i.test(b.getAttribute('aria-label') || '')) ||
      [...document.querySelectorAll('button')].find(b => visible(b) &&
        /уровень усилий рассуждения|reasoning effort/i.test(b.innerText || ''));
  }
  async function setEffort(effort) {
    if (effort === 'auto') return {ok:true};
    if (!names[effort]) return {ok:false,message:'Unsupported effort'};
    const picker = modelPicker();
    if (!picker) return {ok:false,message:'Model/effort selector not found'};
    if (getEffortText(picker.innerText) === effort) return {ok:true};
    picker.click();
    await sleep(450);
    const selectors = 'button,[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]';
    const candidates = [...document.querySelectorAll(selectors)].filter(visible);
    // Choose the deepest exact effort item; never click a generic "Thinking" setting.
    const matches = candidates.filter(n => matchesEffort(n.innerText || n.textContent,effort));
    const choice = matches.find(el => !matches.some(other => other !== el && el.contains(other))) || matches[0];
    if (!choice) {
      picker.click();
      return {ok:false,message:`The ${effort} effort option is not visible in the ChatGPT selector`};
    }
    choice.click();
    await sleep(500);
    const selected = getEffortText(modelPicker()?.innerText || '');
    if (selected !== effort) {
      return {ok:false,message:`Could not verify selected effort (${effort}), actual ${selected || 'unknown'}`};
    }
    return {ok:true};
  }
  function composer() {
    const editors=[...document.querySelectorAll('[contenteditable="true"],textarea')]
      .filter(visible);
    // Prefer an exact ChatGPT composer identity over arbitrary editable
    // controls (sidebar, search, rename dialogs and other page editors).
    const exact=editors.filter(el =>
      el.id==='prompt-textarea' || el.matches('[data-testid="composer-text-input"]'));
    if (exact.length===1) return exact[0];
    if (exact.length>1) return null; // never guess where to type
    const named=editors.filter(el =>
      /спросить chatgpt|ask chatgpt|message chatgpt/i.test(el.getAttribute('aria-label')||''));
    if (named.length===1) return named[0];
    const primary=named.filter(el => !!el.closest('main') || !!el.closest('form'));
    return primary.length===1 ? primary[0] : null;
  }
  function draftText(el) {
    return el.matches('textarea') ? el.value : el.innerText || el.textContent || '';
  }
  async function insertPrompt(el,prompt) {
    let command=null;
    const failure = reason => ({ok:false,message:'Could not enter prompt: '+reason+' '+JSON.stringify({
      connected:el.isConnected,document_focused:document.hasFocus(),
      editor_focused:document.activeElement===el,
      command,expected_chars:prompt.length,actual_chars:draftText(composer()||el).length,
    })});
    // Hydration can replace the editor between discovery and input. Never
    // insert into a stale node, or replace a draft that appeared meanwhile.
    if(composer()!==el || draftText(el).trim()) return failure('editor changed');
    try {
      el.focus();
      if (el.matches('textarea')) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
        nativeSetter.call(el,prompt);
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
      } else {
        // execCommand inserts text through the same editing channel as human input.
        // Set an explicit caret: focus alone may leave a stale selection. Its
        // return flag is advisory; only the resulting editor text proves input.
        caretToEnd(el);
        command = document.execCommand('insertText',false,prompt);
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
      }
    } catch {
      return failure('editing command failed');
    }
    // Read React/editor reconciliation before deciding; do not insert again.
    for(let i=0;i<10;i++) {
      await sleep(100);
      const current=composer();
      if(current && samePrompt(draftText(current),prompt)) return {ok:true};
    }
    return failure(command===false ? 'editing command refused or text differs' : 'text did not settle');
  }
  function submitButton(input) {
    // Trust explicit send-button identity rather than page-wide generic buttons.
    // This covers both the older and newer ChatGPT composer naming patterns.
    const trustedSelectors=[
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[data-testid="composer-submit-button"]',
      'button[id="composer-submit-button"]',
      'button[id="send-button"]',
      'button[aria-label="Отправить сообщение"]',
      'button[aria-label="Отправить"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      'button[title="Send message"]',
      'button[title="Отправить"]',
    ];
    const trusted=[...new Set(trustedSelectors.flatMap(selector=>
      [...document.querySelectorAll(selector)]))].filter(button=>
      visible(button) && !button.disabled);
    const form=input?.closest('form')||null;
    const within=form ? trusted.filter(button=>form.contains(button)) : [];
    if(within.length===1) return within[0];
    if(within.length>1) return {blocked:'Ambiguous Send controls inside the ChatGPT composer'};
    if(trusted.length===1) return trusted[0];
    if(trusted.length>1) return {blocked:'Multiple Send controls found outside the composer form'};
    // Some ChatGPT composer forms use an unlabeled submit button.
    // Only accept it if it is the sole submit button inside THIS editor's form.
    if(trusted.length===0 && form) {
      const scoped=[...form.querySelectorAll('button[type="submit"]')]
        .filter(button=>visible(button) && !button.disabled);
      if(scoped.length===1) return scoped[0];
    }
    return null;
  }
  async function waitForComposer() {
    // Slow ChatGPT hydration can take up to a minute. Wait 90 seconds.
    for (let i=0;i<180;i++) {
      const el = composer();
      if (el) return el;
      await sleep(500);
    }
    return null;
  }
  async function waitForSend(input,prompt) {
    // ChatGPT can hydrate the Send button well after the composer itself.
    // Never consider the submission safe if the text or editor changes.
    for(let i=0;i<480;i++) {
      const current=composer();
      // The app mention added after the prompt may render as a chip, so only
      // the prompt itself must still be there, unchanged, at the start.
      if(current && !promptFirst(draftText(current),prompt)) {
        return {blocked:'Composer contents changed before submission'};
      }
      if(current) {
        const button=submitButton(current);
        if(button?.blocked) return button;
        if(button) return {button,editor:current};
        // No recognised Send button within 3 s: ChatGPT submits on Enter, so
        // press it once (owner decision). A native form submit is ignored by
        // ChatGPT (live job at 18:58 UTC), so it is not used.
        // On a long prompt the Send button can take several seconds to enable;
        // a synthetic Enter is often ignored (live 22 Oct), so it is the last resort.
        if(i>=120) return {enter:true,editor:current};
      }
      await sleep(250);
    }
    return {blocked:'No safe Send button or unique ChatGPT composer form after 120 seconds'};
  }
  const squash = s => (s || '').replace(/\s+/g, ' ').trim();
  // Letters and digits only: the ChatGPT editor reformats line breaks, quotes,
  // dashes and arrows, but the words of the prompt stay the same.
  function core(s) {
    return (s || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }
  // ChatGPT turns links into chips (Slack, GitHub icons), so the composer text
  // is not character-identical to the prompt. Ours if it starts like the
  // prompt, holds its end (the line with our job_id) and has a similar size.
  function samePrompt(text,prompt) {
    const t=core(text), p=core(prompt);
    return t===p || (t.startsWith(p.slice(0,30)) && t.endsWith(p.slice(-40)) && t.length>=p.length*0.8 && t.length<=p.length*1.3);
  }
  // The same, but something (the app mention) may follow the prompt.
  function promptFirst(text,prompt) {
    const t=core(text), p=core(prompt);
    return t.startsWith(p) || (t.startsWith(p.slice(0,30)) && t.includes(p.slice(-40)) && t.length>=p.length*0.8);
  }
  function clearComposer(el) {
    el.focus();
    const range=document.createRange();
    range.selectNodeContents(el);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete');
    return !draftText(el).trim();
  }
  function caretToEnd(el) {
    el.focus();
    const range=document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  async function addMention(el,name) {
    // Owner's recipe, like a person: a bit later, caret at the end, paste
    // "@App" as a separate line, wait for ChatGPT's app picker, then a space
    // with the caret at the end picks the app for this message.
    await sleep(2000);
    // The editor syncs the caret asynchronously (link chips can move it), so
    // place it, let the editor take it, and place it again before pasting.
    caretToEnd(el);
    await sleep(500);
    caretToEnd(el);
    const data=new DataTransfer();
    data.setData('text/plain','\n@'+name);
    const pasted=!el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    if (!pasted) { // the editor ignored the paste: type the same line instead
      document.execCommand('insertParagraph');
      document.execCommand('insertText',false,'@'+name);
    }
    await sleep(7000);
    if (document.activeElement!==el && !el.contains(document.activeElement)) caretToEnd(el);
    const key={key:' ',code:'Space',keyCode:32,which:32,bubbles:true,cancelable:true};
    if (el.dispatchEvent(new KeyboardEvent('keydown',key))) document.execCommand('insertText',false,' ');
    el.dispatchEvent(new KeyboardEvent('keyup',key));
    await sleep(1000);
  }
  function isConversationUrl(value) {
    // ChatGPT first shows a temporary "local" address for a new chat; never treat it as the slug.
    try { const u = new URL(value); return u.origin === 'https://chatgpt.com' && /^\/(?:g\/[^/]+\/)?c\/[a-z0-9-]+\/?$/i.test(u.pathname) &&
      !/(?:^|\/)local/i.test(u.pathname); }
    catch { return false; }
  }
  function chatUrl() {
    // Report the address without query/fragment; null until ChatGPT shows /c/.
    if (!isConversationUrl(window.location.href)) return null;
    const u=new URL(window.location.href);
    return u.origin+u.pathname.replace(/\/+$/,'');
  }
  // A short, text-only description of the window for the coordinating agent
  // when a job could not finish: no page text, no screenshot.
  function pageState(job) {
    const editors=[...document.querySelectorAll('[contenteditable="true"],textarea')].filter(visible);
    const el=composer();
    const text=el ? draftText(el) : '';
    const own=typeof job?.own_text==='string' ? core(job.own_text).slice(0,30) : '';
    const body=(document.body?.innerText||'').slice(-20000);
    return {
      url_kind:isConversationUrl(window.location.href) ? 'conversation' : 'other',
      composer:el ? 'present' : editors.length>1 ? 'ambiguous' : 'missing',
      composer_text:!text.trim() ? 'empty' : own.length>=8 && core(text).includes(own) ? 'our_prompt' : 'other_draft',
      answering:replyInProgress(),
      connection_lost:/Соединение прервано|Connection (?:lost|interrupted)|Network error|Ошибка сети/i.test(body),
      user_messages:document.querySelectorAll('[data-message-author-role="user"]').length,
      assistant_messages:document.querySelectorAll('[data-message-author-role="assistant"]').length,
    };
  }
  // Evidence about the live ChatGPT markup: how many elements match each
  // candidate selector, and the identity attributes of the composer's buttons.
  // Counts and UI attribute values only, never message text.
  const PROBE_SELECTORS={
    author_any:'[data-message-author-role]',author_assistant:'[data-message-author-role="assistant"]',
    author_user:'[data-message-author-role="user"]',article:'article',turn_testid:'[data-testid^="conversation-turn"]',
    message_id:'[data-message-id]',markdown:'.markdown',turn_assistant:'[data-turn="assistant"]',turn_user:'[data-turn="user"]',
    stop_testid:'button[data-testid="stop-button"]',stop_aria:'button[aria-label*="Stop" i],button[aria-label*="Останов" i]',
    send_testid:'button[data-testid="send-button"],button[data-testid="composer-submit-button"],#composer-submit-button',
    send_aria:'button[aria-label*="Send" i],button[aria-label*="Отправ" i]',
  };
  function domProbe() {
    const counts={};
    for(const [key,selector] of Object.entries(PROBE_SELECTORS)) {
      try {counts[key]=document.querySelectorAll(selector).length;} catch {counts[key]=-1;}
    }
    const el=composer();
    const scope=el?.closest('form') || el?.parentElement?.parentElement?.parentElement || null;
    const buttons=scope ? [...scope.querySelectorAll('button')].filter(visible).slice(0,12).map(b=>({
      testid:(b.getAttribute('data-testid')||'').slice(0,60),aria:(b.getAttribute('aria-label')||'').slice(0,60),
      id:(b.id||'').slice(0,60),disabled:!!b.disabled})) : [];
    // Where does the conversation live? Interface attribute names only.
    const all=[...document.querySelectorAll('*')];
    const testids=[...new Set(all.map(e=>e.getAttribute('data-testid')).filter(Boolean))].slice(0,80).map(t=>t.slice(0,60));
    const layout={elements:all.length,main:document.querySelectorAll('main').length,iframes:document.querySelectorAll('iframe').length,
      shadow_roots:all.filter(e=>e.shadowRoot).length,role_article:document.querySelectorAll('[role="article"]').length,
      role_log:document.querySelectorAll('[role="log"]').length,prose:document.querySelectorAll('.prose').length};
    return {counts,composer_buttons:buttons,testids,layout};
  }
  async function run(job) {
    const result=await runSteps(job);
    if (result && (result.status==='blocked'||result.status==='needs_review')) {
      try {result.page_state=pageState(job);result.dom_probe=domProbe();} catch {}
    }
    return result;
  }
  async function runSteps(job) {
    if (!job || !['start','continue'].includes(job.action) || !job.prompt || job.prompt.length > 35000) {
      return {status:'failed',message:'Invalid job'};
    }
    if (job.action === 'continue' && !isConversationUrl(window.location.href)) {
      return {status:'blocked',message:'Not on a ChatGPT conversation URL'};
    }
    const before=window.location.href;
    const input=await waitForComposer();
    if (!input) return {status:'blocked',message:'ChatGPT composer unavailable after 90 seconds (login/challenge/loading/ambiguous field)'};
    if (draftText(input).trim()) {
      // Our own earlier, unsent attempt with the same prompt may be lying here:
      // replace it. Anybody else's draft is never touched.
      const own=typeof job.own_text==='string' ? core(job.own_text).slice(0,30) : '';
      // "includes": an earlier attempt may have the app mention in front of the prompt.
      if (own.length<8 || !core(draftText(input)).includes(own)) {
        return {status:'blocked',reason:'draft',message:'An unsent draft already exists; not overwriting it'};
      }
      if (!clearComposer(input)) return {status:'blocked',message:'Could not clear our own earlier unsent prompt'};
    }
    // Never reload or interrupt: if ChatGPT is still answering here, wait for it.
    // A page stuck on "connection lost, waiting for the full answer" never ends:
    // give up after 90 s; the relay then starts the prompt in a new chat.
    for (let i=0;i<180 && replyInProgress();i++) await sleep(500);
    if (replyInProgress()) return {status:'blocked',reason:'answering',message:'ChatGPT was still answering in this conversation after 90 seconds; nothing was sent'};
    // A launch matters more than the effort level: ChatGPT keeps the last
    // selected level, so a picker that cannot be verified never blocks the send.
    const effortResult=await setEffort(job.effort || 'auto');
    const effortNote=effortResult.ok ? '' : ` Effort left unchanged: ${effortResult.message}.`;
    const ready=await waitForComposer();
    if (!ready || draftText(ready).trim()) return {status:'blocked',message:'Composer changed or contains a draft'};
    const insertion=await insertPrompt(ready,job.prompt);
    if (!insertion.ok) return {status:'blocked',message:insertion.message};
    let mentionNote='';
    if (typeof job.mention==='string' && /^[\p{L}\p{N} ._-]{1,60}$/u.test(job.mention)) {
      await addMention(ready,job.mention);
      // A launch matters more than the mention: if it landed anywhere but after
      // the prompt, start over with the prompt alone (live job, 22 Oct 07:42 UTC).
      if (!promptFirst(draftText(ready),job.prompt)) {
        if (!clearComposer(ready) || !(await insertPrompt(ready,job.prompt)).ok) {
          return {status:'blocked',message:'The app mention landed in the wrong place and the prompt could not be re-entered; draft left for manual review'};
        }
        mentionNote=' App mention skipped (it landed in the wrong place).';
      }
    }
    const submit=await waitForSend(ready,job.prompt);
    if(submit.blocked) return {status:'blocked',message:submit.blocked+'; draft left for manual review'};
    let method;
    try {
      if(submit.button) {
        // Click only the unique composer Send button, once.
        submit.button.click();
        method='Send button';
      } else if(submit.enter) {
        // One Enter into the composer itself, once; delivery is verified below.
        submit.editor.focus();
        const init={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};
        submit.editor.dispatchEvent(new KeyboardEvent('keydown',init));
        submit.editor.dispatchEvent(new KeyboardEvent('keyup',init));
        method='Enter';
        // ChatGPT empties the composer at once when it sends. If our prompt is
        // still there after a few seconds, Enter was ignored and nothing went
        // out, so one click on the Send button cannot duplicate anything.
        for(let i=0;i<20;i++) {
          await sleep(250);
          const now=composer();
          if(!now || !promptFirst(draftText(now),job.prompt)) break;
          if(i===19) {
            const button=submitButton(now);
            if(button && !button.blocked) {button.click();method='Send button after an ignored Enter';}
          }
        }
      } else {
        return {status:'blocked',message:'No safe native submission path'};
      }
    } catch(err) {
      return {status:'needs_review',message:'Submission attempt threw an error; do not retry automatically: '+String(err?.message||err).slice(0,100)};
    }
    // After submitting, an ambiguous UI outcome must NOT cause another submit.
    // A new chat can take a while to get its /c/ address: wait up to 60 seconds.
    let seen=null,stable=0;
    for(let i=0;i<150;i++) {
      await sleep(400);
      // The address of a new chat changes a few times; report it only once it
      // has stayed the same for about two seconds.
      const url=chatUrl();
      stable=url && url===seen ? stable+1 : 0;
      seen=url;
      if(job.action==='start' && url && stable>=5) {
        return {status:'sent',chat_url:url,message:`New chat created via ${method}.`+effortNote+mentionNote};
      }
      if(job.action==='continue' && isConversationUrl(window.location.href)) {
        const now=composer();
        if (now && !draftText(now).trim()) return {status:'sent',chat_url:chatUrl(),message:`Composer cleared after ${method}.`+effortNote+mentionNote};
      }
    }
    return {status:'needs_review',chat_url:chatUrl(),
      message:`Submitted via ${method}, but delivery was not verified (previous URL: ${before}). Do not retry automatically.`+effortNote+mentionNote};
  }
  // Verify ONE previously attempted send without typing, navigating, or
  // reading any reply text back to the relay. The per-job callback marker is
  // unique to that attempt. Missing markers/markup prove nothing.
  async function reconcile(job) {
    if(!job || job.action!=='reconcile' || !/^[0-9a-f-]{36}$/i.test(job.verify_job_id||''))
      return {status:'failed',message:'Invalid reconciliation target'};
    if(!isConversationUrl(window.location.href))
      return {status:'read',delivery_evidence:'unknown',evidence_kind:'wrong_page',execution_evidence:'unknown',message:'No verified conversation URL'};
    const ready=await waitForComposer();
    await sleep(500);
    const marker='job_id='+job.verify_job_id;
    const url=chatUrl();
    // Only text rendered in the LIVE page can prove delivery. A detached
    // clone's innerText falls back to textContent (including hidden messages).
    // Never use an editable subtree, even when the composer is unrecognized.
    const renderedOutsideEditors=(root,matchesText)=>{
      const selector='[contenteditable],textarea,input,[role="textbox"],[role="searchbox"]';
      const witness=node=>{
        try {
          if(!node || typeof node.matches!=='function' || node.matches(selector) ||
             !visible(node) || typeof node.innerText!=='string' ||
             !matchesText(node.innerText) || typeof node.querySelectorAll!=='function')
            return false;
          // Never trust mixed editor text or detached/hidden content.
          if(!node.querySelectorAll(selector).length) return true;
          return [...(node.children||[])].some(witness);
        } catch {return false;}
      };
      return witness(root);
    };
    const hasMarker=el=>renderedOutsideEditors(el,text=>text.includes(marker));
    const userTurns=[...document.querySelectorAll('[data-message-author-role="user"]')];
    const userMatch=userTurns.some(hasMarker);
    const draft=composer();
    const composerKnown=!!ready && draft===ready;
    const inDraft=!!draft && draftText(draft).includes(marker);
    const roots=[...document.querySelectorAll('main')];
    // The main fallback is permitted only with a uniquely recognized, stable
    // composer. A missing/ambiguous editor may be nested inside main itself.
    // Exclude ALL editable descendants, not just the recognized composer.
    const mainMatch=composerKnown && roots.length===1 && !inDraft && hasMarker(roots[0]);
    const evidence_kind=userMatch?'user_message_marker':mainMatch?'conversation_marker':'unconfirmed';
    // Main text alone cannot establish which assistant turn answers this job.
    // Require a distinct, visible assistant turn immediately after its user turn.
    const turns=[...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')];
    const index=turns.findLastIndex(el=>el.getAttribute?.('data-message-author-role')==='user' && hasMarker(el));
    const answer=turns[index+1];
    const complete=index>=0 && answer?.getAttribute?.('data-message-author-role')==='assistant' &&
      renderedOutsideEditors(answer,text=>!!text.trim()) && !replyInProgress();
    return {status:'read',chat_url:url,
      delivery_evidence:evidence_kind==='unconfirmed'?'unknown':'sent',evidence_kind,
      execution_evidence:complete?'page_completed':'unknown',
      message:complete?'Assistant reply after this job marker is complete (page evidence only)':
        evidence_kind==='unconfirmed'?'No positive delivery evidence; original job remains uncertain':
        'Original job marker was observed; assistant completion is not proven'};
  }
  function lastReply() {
    const replies=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const text=(replies.at(-1)?.innerText || replies.at(-1)?.textContent || '').trim();
    return text || null;
  }
  function replyInProgress() {
    return [...document.querySelectorAll('button[data-testid="stop-button"],button[aria-label="Stop streaming"],'+
      'button[aria-label="Остановить потоковую передачу"],button[aria-label="Остановить"]')].some(visible);
  }
  async function read(job) {
    // Reads only the last ChatGPT reply of this conversation; never types or clicks.
    if (!job || job.action!=='read') return {status:'failed',message:'Invalid job'};
    if (!isConversationUrl(window.location.href)) return {status:'blocked',message:'Not on a ChatGPT conversation URL'};
    await waitForComposer(); // the composer appearing means the conversation has rendered
    // A freshly opened tab can take a long time to load the conversation history.
    const anyMessage=()=>document.querySelectorAll('[data-message-author-role]').length>0;
    for (let i=0;i<120 && !anyMessage();i++) await sleep(500);
    await sleep(1000);
    const text=lastReply();
    const busy=replyInProgress();
    // The last user message shows whether a prompt sent earlier really arrived.
    const users=[...document.querySelectorAll('[data-message-author-role="user"]')];
    const asked=(users.at(-1)?.innerText || users.at(-1)?.textContent || '').trim();
    let probe=null;
    try {probe=domProbe();} catch {}
    let state=null;
    try {state=pageState(job);} catch {}
    return {status:'read',chat_url:chatUrl(),reply_text:text ? text.slice(0,20000) : null,reply_generating:busy,dom_probe:probe,
      page_state:state,
      last_user_text:asked ? asked.slice(0,2000) : null,
      message:!text ? (document.querySelectorAll('[data-message-author-role]').length ? 'No ChatGPT reply in this conversation yet' :
        'The conversation text is not readable on this page (ChatGPT markup); rely on model_status/model_summary from chatgpt_report') :
        busy ? 'ChatGPT is still writing this reply; read again later' : 'Last ChatGPT reply read'};
  }
  globalThis.chatGPTLauncherRun = run;
  globalThis.chatGPTLauncherRead = read;
  globalThis.chatGPTLauncherReconcile = reconcile;
  globalThis.chatGPTLauncherProbe = () => {
    const el=composer();
    return {draft:!!(el && draftText(el).trim()),answering:replyInProgress()};
  };
})();
