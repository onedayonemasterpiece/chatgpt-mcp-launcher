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
    if(within.length>1) return null; // avoid an ambiguous choice
    if(trusted.length===1) return trusted[0];
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
  async function waitForSend(input) {
    // Allow React's async composer state to enable its Send control.
    for(let i=0;i<80;i++) {
      const el=submitButton(input);
      if(el) return el;
      await sleep(250);
    }
    return null;
  }
  function isConversationUrl(value) {
    try { const u = new URL(value); return u.origin === 'https://chatgpt.com' && /^\/(?:g\/[^/]+\/)?c\/[a-z0-9-]+\/?$/i.test(u.pathname); }
    catch { return false; }
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
    if (draftText(input).trim()) return {status:'blocked',message:'An unsent draft already exists; not overwriting it'};
    const effortResult=await setEffort(job.effort || 'auto');
    if (!effortResult.ok) return {status:'blocked',message:effortResult.message};
    const ready=await waitForComposer();
    if (!ready || draftText(ready).trim()) return {status:'blocked',message:'Composer changed or contains a draft'};
    if (!insertPrompt(ready,job.prompt)) return {status:'blocked',message:'Could not enter prompt'};
    const send=await waitForSend(ready);
    if (!send) return {status:'blocked',message:'Prompt entered but no unique enabled Send control was found after 20 seconds; leave the draft untouched for manual review'};
    send.click();
    // After clicking Send, an ambiguous UI outcome must NOT cause another Send.
    for(let i=0;i<40;i++) {
      await sleep(400);
      if(job.action==='start' && isConversationUrl(window.location.href)) {
        return {status:'sent',chat_url:window.location.href,message:'New chat created'};
      }
      if(job.action==='continue' && isConversationUrl(window.location.href)) {
        const now=composer();
        if (now && !draftText(now).trim()) return {status:'sent',chat_url:window.location.href,message:'Composer cleared after Send'};
      }
    }
    return {status:'needs_review',chat_url:isConversationUrl(window.location.href) ? window.location.href : null,
      message:`Clicked Send, but completion was not verified (previous URL: ${before}). Do not retry automatically.`};
  }
  globalThis.chatGPTLauncherRun = run;
})();
