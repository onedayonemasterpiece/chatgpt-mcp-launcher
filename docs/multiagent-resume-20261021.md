# Multi-agent continuation MVP — 21 October 2026

## Owner decisions (21 October 2026)

- The core of the feature is the conversation **slug**: get it, find the open tab by it (or open it), and continue there.
- Browser automation is fragile, so it does as few fragile steps as possible. No tab tracking and no progress reporting during a job.
- A missed launch is worse than running on a different effort level. ChatGPT remembers the last selected level, so by default the launcher **does not touch the effort picker** (`effort: auto`). An explicitly requested level is tried once; if it cannot be selected or verified, the prompt is still sent and the job message says so.
- Submitting a prompt: the unique Send button; otherwise the composer form; otherwise, after 90 s without either, one Enter into the composer (owner decision, after a live start at 18:49 UTC was blocked with no button and no form). Exactly one submission, never twice after an uncertain outcome.
- The launcher never reloads a ChatGPT tab (a reload in the middle of an answer can leave the page stuck). If ChatGPT is still answering in the conversation, continue waits up to 3 minutes for the answer to end; otherwise the job is `blocked` with nothing sent.
- An already open tab is reused: the same conversation for continue/open/read, an empty "New chat" page for start. If that page holds someone's unsent draft, nothing is typed there and the new chat starts in a fresh tab.
- The launcher sits in dot's chain of helpers, so it must be able to confirm a result: `chatgpt_read_reply` returns the text of the last ChatGPT reply (text, not screenshots: a screenshot permission would make Chrome disable the extension until the owner re-approves it).

## Result reporting by ChatGPT itself

Owner decision (21 October 2026): results are not read from the screen. Every prompt that Chrome sends ends with a short service note asking the ChatGPT conversation to call the same app's `chatgpt_report(job_id, status)`: `started` as soon as it begins, then `done` with a short `summary` (or `failed` with the reason). `chatgpt_task_status` shows `model_status`, `model_summary` and times. A `started` report proves delivery, so it turns `needs_review` into `sent`. `chatgpt_read_reply` remains only as a fallback.

## MCP tools

- `chatgpt_start({prompt, effort?, device_id?, request_id?, slack_thread_url?})` — new chat. `chatgpt_task_status` later returns `chat_url` and `chat_id` (slug).
- `chatgpt_continue({chat_ref | chat_url, prompt, ...})` — exactly one of `chat_ref` / `chat_url`. `chat_ref` is a slug, a full URL, or the job ID that created the chat. Reuses the open tab with that conversation or opens it.
- `chatgpt_open({chat_ref | chat_url, device_id?, request_id?})` — bring the conversation to the front without sending anything. Final status `opened`, never `sent`.
- `chatgpt_read_reply({chat_ref | chat_url, device_id?, request_id?})` — reuse or open the conversation and read the last ChatGPT reply; never types or clicks. `chatgpt_task_status` returns `reply_text` (up to 20,000 characters, `null` if there is no reply yet) `reply_generating` (`true` while ChatGPT is still writing: read again later) and `last_user_text` (the last message sent in that chat), which resolves `needs_review`: if the prompt is there, it was sent.
- `chatgpt_list_chats({device_id?, limit?})` — conversations started or continued through the launcher, newest first: `chat_url`, `chat_id`, first/last seen, source and last job ID. No prompt or reply text.
- `chatgpt_task_status({job_id})`, `chatgpt_device_status({device_id?})` — unchanged.

`request_id` is an idempotency key: repeating it returns the same job instead of a second submission.

## Registry

`chats` lives in the existing protected JSON queue state (max 2000 entries) and survives relay restarts and pruning of old jobs. Only canonical `https://chatgpt.com/c/<id>` and `https://chatgpt.com/g/<project>/c/<id>` URLs are accepted (no query, fragment, credentials or lookalike hosts). A URL is recorded only from a job's final report (`sent`/`opened`/...), never invented before ChatGPT shows the real `/c/` address; a new chat waits up to 60 seconds for that address after submit.

## Job states

`queued → claimed → sent | opened | read | blocked | failed | needs_review | expired`. No job stays in progress for more than 15 minutes (owner decision: no internal state may hang or stay ambiguous): a job Chrome never picked up becomes `expired` (nothing sent, and an old prompt is never sent later); a claimed job without a report becomes `needs_review` (start/continue) or `failed` (open/read, repeating is safe), and a late real report from Chrome replaces that status. Every job result carries `job_id` and a plain `next_step` for the calling agent; the MCP `initialize` result carries the workflow as `instructions`. `sent` means the prompt was delivered (composer cleared or new `/c/` address), not that the model answered; use `chatgpt_read_reply` for the answer. `needs_review` is never retried automatically. An existing unsent user draft blocks the job instead of being overwritten.

## Privacy

Owner decision (21 October 2026): the last ChatGPT reply of a conversation is returned through the private, authenticated MCP only by an explicit `chatgpt_read_reply` call. Screenshots, DOM dumps, cookies and prompts are never returned. Slack completion is confirmed separately with the Slack tool.
