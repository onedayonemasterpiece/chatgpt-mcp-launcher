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
  function insertPrompt(el,prompt) {
    el.focus();
    if (el.matches('textarea')) {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      nativeSetter.call(el,prompt);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
    } else {
      // execCommand inserts text through the same editing channel as human input.
      // Does not submit; the send button is clicked independently.
      const inserted = document.execCommand('insertText',false,prompt);
      if (!inserted) return false;
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
    }
    return draftText(el).trim()===prompt.trim();
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
      if(current && !squash(draftText(current)).startsWith(squash(prompt))) {
        return {blocked:'Composer contents changed before submission'};
      }
      if(current) {
        const button=submitButton(current);
        if(button?.blocked) return button;
        if(button) return {button,editor:current};
        // No recognised Send button within 3 s: ChatGPT submits on Enter, so
        // press it once (owner decision). A native form submit is ignored by
        // ChatGPT (live job at 18:58 UTC), so it is not used.
        if(i>=12) return {enter:true,editor:current};
      }
      await sleep(250);
    }
    return {blocked:'No safe Send button or unique ChatGPT composer form after 120 seconds'};
  }
  const squash = s => (s || '').replace(/\s+/g, ' ').trim();
  async function addMention(el,name) {
    // Owner's recipe, like a person: on a new line type "@App", wait for
    // ChatGPT's app picker, then a space picks the app for this message.
    el.focus();
    document.execCommand('insertParagraph');
    document.execCommand('insertText',false,'@'+name);
    await sleep(7000);
    document.execCommand('insertText',false,' ');
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
  async function run(job) {
    if (!job || !['start','continue'].includes(job.action) || !job.prompt || job.prompt.length > 35000) {
      return {status:'failed',message:'Invalid job'};
    }
    if (job.action === 'continue' && !isConversationUrl(window.location.href)) {
      return {status:'blocked',message:'Not on a ChatGPT conversation URL'};
    }
    const before=window.location.href;
    const input=await waitForComposer();
    if (!input) return {status:'blocked',message:'ChatGPT composer unavailable after 90 seconds (login/challenge/loading/ambiguous field)'};
    if (draftText(input).trim()) return {status:'blocked',reason:'draft',message:'An unsent draft already exists; not overwriting it'};
    // Never reload or interrupt: if ChatGPT is still answering here, wait for it.
    for (let i=0;i<360 && replyInProgress();i++) await sleep(500);
    if (replyInProgress()) return {status:'blocked',message:'ChatGPT was still answering in this conversation after 3 minutes; nothing was sent, try again later'};
    // A launch matters more than the effort level: ChatGPT keeps the last
    // selected level, so a picker that cannot be verified never blocks the send.
    const effortResult=await setEffort(job.effort || 'auto');
    const effortNote=effortResult.ok ? '' : ` Effort left unchanged: ${effortResult.message}.`;
    const ready=await waitForComposer();
    if (!ready || draftText(ready).trim()) return {status:'blocked',message:'Composer changed or contains a draft'};
    if (!insertPrompt(ready,job.prompt)) return {status:'blocked',message:'Could not enter prompt'};
    if (typeof job.mention==='string' && /^[\p{L}\p{N} ._-]{1,60}$/u.test(job.mention)) await addMention(ready,job.mention);
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
        return {status:'sent',chat_url:url,message:`New chat created via ${method}.`+effortNote};
      }
      if(job.action==='continue' && isConversationUrl(window.location.href)) {
        const now=composer();
        if (now && !draftText(now).trim()) return {status:'sent',chat_url:chatUrl(),message:`Composer cleared after ${method}.`+effortNote};
      }
    }
    return {status:'needs_review',chat_url:chatUrl(),
      message:`Submitted via ${method}, but delivery was not verified (previous URL: ${before}). Do not retry automatically.`+effortNote};
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
    for (let i=0;i<20 && !lastReply();i++) await sleep(500);
    await sleep(1000);
    const text=lastReply();
    const busy=replyInProgress();
    // The last user message shows whether a prompt sent earlier really arrived.
    const users=[...document.querySelectorAll('[data-message-author-role="user"]')];
    const asked=(users.at(-1)?.innerText || users.at(-1)?.textContent || '').trim();
    return {status:'read',chat_url:chatUrl(),reply_text:text ? text.slice(0,20000) : null,reply_generating:busy,
      last_user_text:asked ? asked.slice(0,2000) : null,
      message:!text ? 'No ChatGPT reply in this conversation yet' :
        busy ? 'ChatGPT is still writing this reply; read again later' : 'Last ChatGPT reply read'};
  }
  globalThis.chatGPTLauncherRun = run;
  globalThis.chatGPTLauncherRead = read;
})();
