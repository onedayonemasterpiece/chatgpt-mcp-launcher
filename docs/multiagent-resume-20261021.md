# Multi-agent continuation MVP — 21 October 2026

## Owner decisions (21 October 2026)

- The core of the feature is the conversation **slug**: get it, find the open tab by it (or open it), and continue there.
- Browser automation is fragile, so it does as few fragile steps as possible. No tab tracking and no progress reporting during a job.
- A missed launch is worse than running on a different effort level. ChatGPT remembers the last selected level, so by default the launcher **does not touch the effort picker** (`effort: auto`). An explicitly requested level is tried once; if it cannot be selected or verified, the prompt is still sent and the job message says so.
- Submitting a prompt: the unique Send button; if none is recognised within 3 s, one Enter into the composer (owner decision). A native form submit is not used: ChatGPT ignored it in the live job at 18:58 UTC. Exactly one submission, never twice after an uncertain outcome.
- The launcher never reloads a ChatGPT tab (a reload in the middle of an answer can leave the page stuck). If ChatGPT is still answering in the conversation, continue waits up to 3 minutes for the answer to end; otherwise the job is `blocked` with nothing sent.
- An already open tab is reused: the same conversation for continue/open/read, an empty "New chat" page for start. If that page holds someone's unsent draft, nothing is typed there and the new chat starts in a fresh tab.
- The launcher sits in dot's chain of helpers, so it must be able to confirm a result: `chatgpt_read_reply` returns the text of the last ChatGPT reply (text, not screenshots: a screenshot permission would make Chrome disable the extension until the owner re-approves it).

## Result reporting by ChatGPT itself

Owner decision (21 October 2026): results are not read from the screen. To make the app available to the conversation, the extension acts like a person: 2 s after the prompt it puts the caret at the end, pastes `@Chatgpt task lancher` as a separate line, waits 7 s for the app picker, then with the caret at the end presses space to pick the app, and only then submits. Every prompt that Chrome sends ends with a short service note asking the ChatGPT conversation to call the same app's `chatgpt_report(job_id, status)`: `started` as soon as it begins, then `done` with a short `summary` (or `failed` with the reason). `chatgpt_task_status` shows `model_status`, `model_summary` and times. A `started` report proves delivery, so it turns `needs_review` into `sent`. `chatgpt_read_reply` remains only as a fallback.

## MCP tools

- `chatgpt_start({prompt, effort?, device_id?, request_id?, slack_thread_url?})` — new chat. `chatgpt_task_status` later returns `chat_url` and `chat_id` (slug).
- `chatgpt_continue({chat_ref | chat_url, prompt, ...})` — exactly one of `chat_ref` / `chat_url`. `chat_ref` is a slug, a full URL, or the job ID that created the chat. Reuses the open tab with that conversation or opens it.
- `chatgpt_open({chat_ref | chat_url, device_id?, request_id?})` — bring the conversation to the front without sending anything. Final status `opened`, never `sent`.
- `chatgpt_read_reply({chat_ref | chat_url, device_id?, request_id?})` — reuse or open the conversation and read the last ChatGPT reply; never types or clicks. `chatgpt_task_status` returns `reply_text` (up to 20,000 characters, `null` if there is no reply yet) `reply_generating` (`true` while ChatGPT is still writing: read again later) and `last_user_text` (the last message sent in that chat), which resolves `needs_review`: if the prompt is there, it was sent.
- `chatgpt_close_chat({chat_ref | chat_url})` — optional housekeeping (owner idea, 21 October 2026: an overnight coordinator can open many tabs and use up RAM). Closes the conversation's tab; the chat stays in ChatGPT and `chatgpt_continue` reopens it. Tabs with an unsent draft or a reply still being written are left open (`blocked`, try later). Final status `closed`.
- `chatgpt_list_chats({device_id?, limit?})` — conversations started or continued through the launcher, newest first: `chat_url`, `chat_id`, first/last seen, source and last job ID. No prompt or reply text.
- `chatgpt_task_status({job_id})`, `chatgpt_device_status({device_id?})` — unchanged.

`request_id` is an idempotency key: repeating it returns the same job instead of a second submission.

## Registry

`chats` lives in the existing protected JSON queue state (max 2000 entries) and survives relay restarts and pruning of old jobs. Only canonical `https://chatgpt.com/c/<id>` and `https://chatgpt.com/g/<project>/c/<id>` URLs are accepted (no query, fragment, credentials or lookalike hosts). A URL is recorded only from a job's final report (`sent`/`opened`/...), never invented before ChatGPT shows the real `/c/` address; a new chat waits up to 60 seconds for that address after submit.

## Job states

`queued → claimed → sent | opened | read | blocked | failed | needs_review | expired`. No job stays in progress for more than 15 minutes (owner decision: no internal state may hang or stay ambiguous): a job Chrome never picked up becomes `expired` (nothing sent, and an old prompt is never sent later); a claimed job without a report becomes `needs_review` (start/continue) or `failed` (open/read, repeating is safe), and a late real report from Chrome replaces that status. Every job result carries `job_id` and a plain `next_step` for the calling agent; the MCP `initialize` result carries the workflow as `instructions`. `sent` means the prompt was delivered (composer cleared or new `/c/` address), not that the model answered; use `chatgpt_read_reply` for the answer. `needs_review` is never retried automatically. An existing unsent user draft blocks the job instead of being overwritten; only the launcher's own earlier unsent attempt with the same prompt is replaced. The inserted prompt is checked by its letters and digits only, because the ChatGPT editor reformats line breaks, quotes and arrows (dot's multi-line prompt at ~19:50 UTC was blocked with "Could not enter prompt").

## Privacy

Owner decision (21 October 2026): the last ChatGPT reply of a conversation is returned through the private, authenticated MCP only by an explicit `chatgpt_read_reply` call. Screenshots, DOM dumps, cookies and prompts are never returned. Slack completion is confirmed separately with the Slack tool.

## Events and coordination (22 October 2026)

dot's request, kept minimal: no new orchestrator, all existing tools unchanged.

**Protocol.** OpenAI MCP Events need MCP `2026-07-28`. The relay serves it next to the `2025-11-25` handshake: `server/discover` advertises `capabilities.events`, and modern requests (`params._meta["io.modelcontextprotocol/protocolVersion"]`) get `resultType`, `cacheScope`/`ttlMs` and `_meta.serverInfo`; other versions get `-32022`. Legacy clients get exactly the old responses. Checked with the MCP Python SDK 2.3.0 client in both `auto` (discover) and `legacy` modes.

**Events** (`events/list`, `events/subscribe`, `events/unsubscribe`; webhook delivery as in projects-hub):

- `chatgpt_launcher.job_update`: ChatGPT reported `done`/`failed`; the job became `blocked`, `failed`, `needs_review`, `expired` or `closed`; or the agent went silent (`execution: unconfirmed`). Payload: `job_id`, `request_id`, `chat_id`, `chat_url`, `action`, `status`, `execution`, `summary` (≤ 500 characters: the model's summary or the reason), `at`. Never prompt or chat text.
- `chatgpt_launcher.coordination_reminder`: see below.

Subscribing verifies the callback with a signed challenge. Events are signed with Standard Webhooks (`webhook-id` = `eventId`), sent only over HTTPS to public addresses without redirects, at most 5 attempts with backoff (none after 410/413/other permanent 4xx; 410 marks the subscription gone). The `eventId` is derived from the fact itself, so a repeated report or a retry never yields a different event. Subscriptions (secret encrypted with a key derived from the relay token, TTL ≤ 24 h, refreshed by ChatGPT) and undelivered events live in the same state file and survive restarts. `chatgpt_device_status` shows `events` (subscriptions, last delivery and error, pending/failed counts, events emitted while nobody was subscribed) and `coordination`.

**Execution** (in every job result, separate from delivery `status`): `not_started`, `awaiting_confirmation` (sent, no report yet), `started`, `progress` (the agent may call `chatgpt_report(status="progress", summary)`; the last note is `model_progress`), `done`, `failed`, `unconfirmed` (no report for 30 min after started/progress, or 10 min after sending: unknown, never treated as done), `unknown` (needs review). A late `started`/`progress` never undoes `done`/`failed`. The page's generation indicator is never used as proof of completion.

**Coordination reminder.** `chatgpt_coordination_set(goal, min_agents=2, idle_minutes=15, pause_minutes?, pause_reason?)` opens or updates it; `chatgpt_coordination_close(reason?)` ends it. Active agents are conversations whose latest job reports `started`/`progress` and is not silent. While fewer than `min_agents` are active for `idle_minutes`, one reminder is sent (goal, counts, up to 10 unfinished jobs), then at most once per `idle_minutes`. A pause needs a reason and a duration; paused time does not count, and reminders resume when it expires. It never starts agents; finishing one of dot's replies does not close it.

**Blocked agents (22 October 2026).** An agent that cannot go on without someone's decision reports `chatgpt_report(status="blocked", summary = which decision, from whom)`; `job_update` carries `execution: blocked` and `next_step` tells dot to pass that exact question to the owner and then pause the coordination with that reason. `blocked` is not final: work resumes either in the agent's own chat (the agent reports `started`/`progress` on the same job; it counts as active again) or through a new `chatgpt_continue` from dot. A second blocker after resuming produces a new event; a repeated identical report does not.

**A line of work is never lost (22 October 2026, owner decision).** Live continues with long prompts containing links were refused although the text was in the composer: ChatGPT turns links into Slack/GitHub chips, so the composer text is not character-identical. The prompt check now accepts "starts like the prompt, holds its end (the line with the job_id), similar size". And when a continue cannot be delivered (`blocked`: page stuck on "connection lost, waiting for the full answer" for 90 s, a foreign draft, an editor that refuses input), the relay immediately starts the same prompt in a new chat, prefixed with the chat it continues; `fallback_job_id` / `fallback_of` link the two jobs, `job_update` carries them, and `next_step` tells dot to follow the new job's `chat_id`. The old chat and any draft in it are left untouched; a failed fallback start does not cascade.

**Window state instead of screenshots.** A `blocked` or `needs_review` job carries `page_state` (also in `job_update`): `url_kind`, `composer` (present/missing/ambiguous), `composer_text` (empty/our_prompt/other_draft), `answering`, `connection_lost`, `user_messages`, `assistant_messages`. Plain fields only, no page text; no screenshot permission is needed.

**Do not depend on ChatGPT's markup (22 October 2026).** A live probe found 5652 elements with only two `data-testid` values (header only) and no message markers at all; the markup changes and cannot be relied on (owner: it likely changes on purpose). So "is the agent still answering" now comes from the launcher's own state: a continue is refused while a prompt to that chat is queued/claimed or while its agent last reported `started`/`progress` (until it reports done/failed/blocked or goes silent → `unconfirmed`). Results come from `chatgpt_report`; `chatgpt_read_reply` is an unreliable fallback that says so when the page text cannot be read. On the page only the composer, the Send button (by its label) and Enter are used.
