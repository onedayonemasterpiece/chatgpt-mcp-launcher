# Multi-agent continuation MVP — 21 October 2026

## Objective and acceptance

dot can start or resume a real ChatGPT conversation in the owner's existing Chrome profile through an authenticated MCP relay. A long-loading page is an asynchronous task, **not** a reason to submit another identical prompt. All recorded ChatGPT conversation URLs and identifiers survive relay restarts. The server returns delivery state/progress via MCP; it does **not** claim that the model responded, finished work, or posted to Slack.

### Exposed MCP API

Retain existing tools: `chatgpt_start`, `chatgpt_continue`, `chatgpt_task_status`, `chatgpt_device_status`.

Add:
- `chatgpt_list_chats({device_id?,limit?})`: most recently seen ChatGPT conversations with canonical `chat_url`, `chat_id` (last `/c/...` segment), original job, timestamps and last *transport/dispatch* outcome; no prompts, responses, cookies or DOM text.
- `chatgpt_chat_status({chat_ref,device_id?})`: resolve canonical URL, ID, or known job ID from the durable index; return last observed safe metadata and linked jobs. An unknown slug may be expanded ONLY to `https://chatgpt.com/c/<safe-UUID-like-id>` if it matches the constrained ID pattern; project URLs require full exact URL. Never search or access arbitrary websites.
- `chatgpt_open({chat_ref,device_id?,request_id?})`: enqueue an **open-only** job; reuse matching tab in local Chrome when open, otherwise open the known URL. No prompt/send. Return job ID immediately, `chatgpt_task_status` follows progress and completion. 
- Extend `chatgpt_continue` to permit `chat_ref` instead of `chat_url`; require exactly one. Validate canonical resolved URL before enqueue. Keep all existing signatures/backward compatibility.

Tool discovery and error contracts are explicit; stable idempotency keys prevent duplicate dispatch after unknown outcomes.

### Durable registry

Add `chats` to the existing protected JSON queue state, no database. Server records **only** canonical ChatGPT URL, ID, first/last seen, originating/last job ID, transport state, device ID, timestamps. Bound collection size (e.g. max 2000), and persist on each new/changed URL. When old sent jobs are pruned, their chat registry entries remain until bounded eviction. Reject urls outside `https://chatgpt.com` including lookalikes, fragments, query, malicious or private paths. Capture initial URL from a `sent` report, and capture later-created real `/c/` URL in a separate event from a tab associated with the job. Never invent chat ID before actual route is observed. A freshly opened `https://chatgpt.com/` is NOT yet a conversation slug.

### Asynchronous progress

Job state examples:
- queued -> claimed -> loading -> waiting_composer -> draft_ready -> submitting -> sent (only if real Send dispatch verified)
- open-only -> opened/ready (never mark as sent)
- failures -> blocked or needs_review; never replay automatically if Send may have fired.
Allow device-side authenticated `/device/report` `type:'progress'` for a known claimed job with only whitelist state, bounded message and optional valid canonical URL. Heartbeats remain, all functions idempotent. Existing `/device/poll` and `/device/report` paths only: no new public endpoint.
Progress timestamps let dot see `loading`, `waiting_composer`, `submitting` via `chatgpt_task_status`. An early MCP call always returns quickly with job_id and the user may check again later. No arbitrary background polling or task relaunch to 'fix' uncertainty.

### Browser safety and effort policy

Owner explicitly does **not** want Astra Pro usage on default. Make `xhigh` (Extra High / «Очень высокий») the default, not `auto`, for newly queued jobs. If `xhigh` cannot be selected and **verified** on actual ChatGPT UI, fail closed (`blocked`), do not fall back to Pro, auto or another effort. Never infer capability from plan or local API model names. Existing explicit `auto` is permitted only if caller explicitly supplies it, and should be discouraged in MCP descriptions.

Locate editor using verified unique ChatGPT composer identity; never overwrite a draft. Send via the *unique active composer send button*, with Enter as an optional **single attempt** if there is a proven composer focus and no reliable button; do not synthesize keyboard events that fail in Chrome. Ctrl+Enter only when explicitly proven for current UI, not an unconditional default. After submission distinguish sending from completion; never duplicate a send after uncertain outcome. Browser page can take 1–2 minutes: use up to 90s loading and 90s composer wait, with progress. Chrome MV3 worker may suspend; preserve fail-closed pending report.

### Evidence and privacy

No extraction of ChatGPT reply text, screen screenshots, DOM dumps, cookies or prompts through MCP. Direct browser content inspection has been blocked by browser host policy; do not bypass that by calling a different browser surface or by exposing a screenshot endpoint. Safe summaries can describe only extension-observed status (`opening`, `loading`, `composer_present`, `draft_present` boolean, `sent`, URLs/IDs) and cannot assert that a model replied. Slack completion must be confirmed separately using its connected tool.

### Acceptance gates

- Tests: queue registry survives process restart, URL whitelist, slug resolution, alias, idempotency, duplicate job prevention, capture URL only when observed, open-only never sends, progress observed, no reply content exported.
- Tests: missing/duplicate submit controls fail closed, user draft never overwritten, Extra High fail-closed when picker unavailable, sim slow load >=60s, no Pro default.
- CI must pass on main. Existing production loopback relay secrets/tunnel remain private and unchanged.
- Deploy actual relay only after tested source integration; verify MCP tool discovery, device heartbeat and Git SHA separately.
- Chrome client must report its actual active SHA before any new real `ping`, and first real send requires user-authorized test chat (never silently resubmit the blocked earlier `ping`).
