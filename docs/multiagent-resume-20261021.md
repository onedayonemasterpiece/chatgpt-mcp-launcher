# Multi-agent continuation MVP — 21 October 2026

## Owner decisions (21 October 2026)

- The core of the feature is the conversation **slug**: get it, find the open tab by it (or open it), and continue there.
- Browser automation is fragile, so it does as few fragile steps as possible. No tab tracking and no progress reporting during a job.
- A missed launch is worse than running on a different effort level. ChatGPT remembers the last selected level, so by default the launcher **does not touch the effort picker** (`effort: auto`). An explicitly requested level is tried once; if it cannot be selected or verified, the prompt is still sent and the job message says so.
- Submitting a prompt: click the unique Send button; if there is none, press Enter once in the focused composer. Never submit twice after an uncertain outcome.

## MCP tools

- `chatgpt_start({prompt, effort?, device_id?, request_id?, slack_thread_url?})` — new chat. `chatgpt_task_status` later returns `chat_url` and `chat_id` (slug).
- `chatgpt_continue({chat_ref | chat_url, prompt, ...})` — exactly one of `chat_ref` / `chat_url`. `chat_ref` is a slug, a full URL, or the job ID that created the chat. Reuses the open tab with that conversation or opens it.
- `chatgpt_open({chat_ref | chat_url, device_id?, request_id?})` — bring the conversation to the front without sending anything. Final status `opened`, never `sent`.
- `chatgpt_list_chats({device_id?, limit?})` — conversations started or continued through the launcher, newest first: `chat_url`, `chat_id`, first/last seen, source and last job ID. No prompt or reply text.
- `chatgpt_task_status({job_id})`, `chatgpt_device_status({device_id?})` — unchanged.

`request_id` is an idempotency key: repeating it returns the same job instead of a second submission.

## Registry

`chats` lives in the existing protected JSON queue state (max 2000 entries) and survives relay restarts and pruning of old jobs. Only canonical `https://chatgpt.com/c/<id>` and `https://chatgpt.com/g/<project>/c/<id>` URLs are accepted (no query, fragment, credentials or lookalike hosts). A URL is recorded only from a job's final report (`sent`/`opened`/...), never invented before ChatGPT shows the real `/c/` address; a new chat waits up to 60 seconds for that address after submit.

## Job states

`queued → claimed → sent | opened | blocked | failed | needs_review`. `sent` means the prompt was delivered (composer cleared or new `/c/` address), not that the model answered. `needs_review` is never retried automatically. An existing unsent user draft blocks the job instead of being overwritten.

## Privacy

No reply text, screenshots, DOM dumps, cookies or prompts are returned through MCP. Slack completion is confirmed separately with the Slack tool.
