# ChatGPT MCP Launcher

Public Chrome MV3 extension, protected MCP relay and lightweight Windows updater. It opens or continues **existing ChatGPT conversations** in the user's authenticated Chrome. It never copies browser cookies. Results come from ChatGPT itself: every prompt asks the conversation to report back through the launcher app (`chatgpt_report`); the last reply can also be read on an explicit `chatgpt_read_reply` call. MCP workflow and owner decisions: [docs/multiagent-resume-20261021.md](docs/multiagent-resume-20261021.md).

## Windows: one-time installation

Paste these lines together in ordinary Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP 'chatgpt-mcp-launcher-install.ps1'
Invoke-WebRequest 'https://raw.githubusercontent.com/onedayonemasterpiece/chatgpt-mcp-launcher/main/install.ps1' -UseBasicParsing -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Install
```

The installer requires no Git, administrator rights, dot, ChatGPT Desktop or SSH tunnel. It downloads an archive from the **public** GitHub repository by its verified commit SHA.

Once installed, in Chrome navigate to `chrome://extensions`, enable Developer mode and **Load unpacked** from:

```text
%LOCALAPPDATA%\ChatGPTMcpLauncher\source\chatgpt-launcher\extension
```

If an old Launcher is already loaded from a different folder, disable the old extension before using this one, to avoid duplicate heartbeats. A new Chrome extension ID cannot automatically inherit the previous token. Enter the device token only in the extension's local popup, never in Slack or GitHub. Relay URL: `https://ideas.kenigevents.ru/chatgpt-launcher`; device ID: `desktop`. If the same directory was already loaded in Chrome, there is no need to reinstall.

## Low-impact automatic updates

Windows Task Scheduler checks the public GitHub commit SHA **once every 15 minutes**. When unchanged, no code is downloaded or installed; there is no continuously running local process and no Git requirement. Only when the SHA changes does the updater fetch the small ZIP archive, verify the locally written files and update the unpacked extension. Chrome automatically reloads when it observes the version marker.

### Manual update from Chrome

Open the extension popup and select **«Проверить и установить обновления»**. The button uses the Windows protocol `chatgpt-mcp-update://check` registered for your current user by `install.ps1 -Install`, and launches a **hidden, short-lived Windows Script Host** updater. Chrome may ask to confirm opening the registered Windows app; accept to proceed. A PowerShell window should not appear. The popup reads a tiny local status file while open and reports **checking**, **no updates/current**, **updated**, or **error**. If the popup closes, reopen it to see the latest recorded result. The updater checks the public GitHub SHA and downloads code **only when a new commit exists**. It does not need a resident background process, Git, an admin account or dot.

**After upgrading from the earlier visible-PowerShell handler:** the new updater repairs the protocol registration during its next successful scheduled check (within the normal 15-minute interval). The previously installed handler may display a PowerShell window once during that transition. The new handler executes silently after registration. You can confirm it with the Windows acceptance workflow linked below.

The very first setup must still load the unpacked extension once in `chrome://extensions` from the installation path. If the old extension was loaded from a different directory, disable the old one and select the new public directory. The button cannot install code into a Chrome extension that has never been loaded in Chrome.

The extension reports `active_revision` (version of the loaded background worker), `installed_revision` (disk version), `runtime_integrity`, `updater_state`, `updater_checked_at`, and `commands_enabled` through the authenticated HTTPS device endpoint. This is available through the extension popup and `chatgpt_device_status(device_id="desktop")`. The server will not release queued work to an unverified, outdated or disabled extension.

Run a manual status or check:

```powershell
& "$env:LOCALAPPDATA\ChatGPTMcpLauncher\updater.ps1" -Status
& "$env:LOCALAPPDATA\ChatGPTMcpLauncher\updater.ps1" -Check
```

Disable scheduled updates with `schtasks.exe /Change /TN "ChatGPT MCP Launcher Updates" /DISABLE`, or re-enable using `/ENABLE`.

Chrome must be open for an update to take effect; scheduled checks can run even while Chrome is closed. No prompts are resent automatically after an uncertain send.

## Refreshing ChatGPT plugin tools after a deploy

After a deploy that adds or changes MCP tools of a ChatGPT plugin (for RKB: «Kalinigrad base»), the deploying agent calls `chatgpt_refresh_plugin_tools` with the plugin settings URL `https://chatgpt.com/settings/plugins-settings/plugin_<id>`. Chrome opens that page, presses «Обновить инструменты» / «Refresh tools» once, waits until the button is ready again (about 10 s), closes the tab and reports `refreshed`. If the button is not found nothing is pressed (`blocked`); if it stays busy for 30 s the tab is left open (`needs_review`). No chat is touched. The agent then checks the new tools in an existing chat and reports in the coordination thread and to the owner.

## Security boundaries

Only the Chrome device endpoints are exposed by the HTTPS proxy. MCP itself remains private. No API keys, passwords or cookies should ever be included in this repository. Source publication is separate from configuring the private relay and server infrastructure.

Run `npm test` to test the relay, extension logic and version reporting; mock tests are not live ChatGPT acceptance.

## RKB: автономное чтение очереди книг

Один `chatgpt_start` с первым `prompt`, уникальным `request_id`,
`slack_thread_url` и объектом `book` создаёт долговечную задачу:

~~~json
{
  "book": {
    "books": [
      {"ingestion_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
      {"ingestion_id": "11111111-2222-3333-4444-555555555555", "telegram_original": "t.me/c/1/2"}
    ],
    "continuation_prompt": "Продолжай импорт текущей книги. Сначала book_ingest(status); принятые страницы не повторяй."
  }
}
~~~

Книги идут **в указанном порядке**; подтверждённый RKB
`state=finalized, next_action=done` создаёт новый чат через уже
имеющийся `start` для следующей книги. Лишь `finalized/done` на **последней**
книге завершает всю задачу. `failed/blocker` — настоящий блокер RKB.
Обычные `chatgpt_report(done)` или доказанное `page_completed` означают
только конец **одного хода**, они **не** завершают книгу. Входной `books`
резервирует уникальные ingestion UUID среди активных задач.
Первый `job_id` также является `book_task_id`. Прогресс виден
в `chatgpt_task_status(job_id).book_task`.

**RKB — источник живости и завершения.** Relay опрашивает только
активные книги раз в 5 минут по внутреннему read-only API
`GET /internal/import/activity?ingestion_id=UUID` с контрактом
`{state,next_action,last_operation_at,accepted_pages,next_cursor}`.
`last_operation_at` берётся из RKB `book_pages`/`book_ingest`, а не
из действий на странице ChatGPT. Только свежий ответ
`staged/continue_pages` при 20 мин без операций позволяет объявить окно
мёртвым. `processing/wait`, недоступный RKB, `last_operation_at=null`
**не** вызывают принудительный новый чат.

Обычное завершение хода отправляет `continuation_prompt` в тот же чат.
После пяти продолжений либо при 90-минутном возрасте окна используется
существующий `successor`. Новое окно одной книги создаётся **не чаще одного
раза в 20 минут**. Если два подтверждённых окна-замены подряд
не привели к новой RKB-операции, Launcher отправляет **одно** фактическое
уведомление в `slack_thread_url`, но задача остаётся активной.
После новой RKB-операции отсчёт начинается заново. Итоговая остановка
способна отправить отдельное одно сообщение.

**Явный отказ клиентской защиты OpenAI:** если именно клиент ChatGPT
отклонил `book_ingest(stage)` **до** RKB handler, читатель сообщает
`chatgpt_report(status="blocked", failure_kind="client_safety_rejection",
summary="<точный текст отказа>")`. Только такое структурированное сообщение
останавливает текущую book-task в существующем `blocked`, отменяет её
**ещё не отправленные** продолжения и выдаёт одно терминальное уведомление.
Обычные `done` и `blocked` без `failure_kind` не подменяют статус RKB.
Причина клиентской блокировки не установлена; повтор через successor
не является её исправлением ([RKB PR646](https://github.com/onedayonemasterpiece/regional-knowledge-base/pull/646)).

**Конфигурация на сервере (только защищённый runtime конфиг):**

- `LAUNCHER_RKB_ACTIVITY_URL=http://127.0.0.1:8000/internal/import/activity`
- `LAUNCHER_RKB_ACTIVITY_TOKEN` — отдельный сервисный Bearer, не токен владельца.
- `LAUNCHER_RKB_SERVICE_CREDENTIAL_ID` — UUID сервисного credential.
- `LAUNCHER_RKB_SERVICE_CREDENTIAL_EPOCH` — выданный RKB epoch.
- `LAUNCHER_SLACK_BOT_TOKEN` — для доставки уведомлений в заданный тред.

RKB требует `X-RKB-Service: launcher-import-watch`,
`X-RKB-Service-Credential` и `X-RKB-Service-Epoch` вместе с Bearer.
Секретов в URL, владельческого OAuth, дополнительных сервисов
и чтения DOM для живости нет. Пока PR RKB не установлен,
интерфейс проверяется через внедрённый `bookActivityReader`-двойник
в `makeRelay`. Дополнительного MCP-инструмента для ручной
передачи активности нет.

**Селекторы:** текущий RKB activity endpoint принимает только UUID,
поэтому для сохранённого `telegram_original` нужно передавать также
связанный `ingestion_id` из списка оригиналов. Только locator **без UUID**
отклоняется до появления read-only resolver в RKB: Launcher не может
доказать активность или завершение для такого ввода. Это ограничение
контракта RKB, а не повод доверять модели.

После ревью/merge и установки Шкипером требуется живой тест
сервисного доступа по loopback, двух параллельных **разных** книг,
полного перехода и однократных Slack-уведомлений. Успешный `npm test`
сам по себе не является live-приёмкой.
