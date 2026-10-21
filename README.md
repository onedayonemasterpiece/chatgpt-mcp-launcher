# ChatGPT MCP Launcher

Public Chrome MV3 extension, protected MCP relay and lightweight Windows updater. It opens or continues **existing ChatGPT conversations** in the user's authenticated Chrome. It does not read model responses or copy browser cookies.

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

Open the extension popup and select **«Проверить и установить обновления»**. The button uses the Windows protocol `chatgpt-mcp-update://check` registered for your current user by `install.ps1 -Install`, and launches the same updater immediately. Chrome may ask you once per launch to confirm opening the Windows app; accept to proceed. The Windows updater checks the public GitHub SHA and downloads code **only when a new commit exists**. It does not need a resident background process, Git, an admin account or dot.

The very first setup must still load the unpacked extension once in `chrome://extensions` from the installation path. If the old extension was loaded from a different directory, disable the old one and select the new public directory. The button cannot install code into a Chrome extension that has never been loaded in Chrome.

The extension reports `active_revision` (version of the loaded background worker), `installed_revision` (disk version), `runtime_integrity`, `updater_state`, `updater_checked_at`, and `commands_enabled` through the authenticated HTTPS device endpoint. This is available through the extension popup and `chatgpt_device_status(device_id="desktop")`. The server will not release queued work to an unverified, outdated or disabled extension.

Run a manual status or check:

```powershell
& "$env:LOCALAPPDATA\ChatGPTMcpLauncher\updater.ps1" -Status
& "$env:LOCALAPPDATA\ChatGPTMcpLauncher\updater.ps1" -Check
```

Disable scheduled updates with `schtasks.exe /Change /TN "ChatGPT MCP Launcher Updates" /DISABLE`, or re-enable using `/ENABLE`.

Chrome must be open for an update to take effect; scheduled checks can run even while Chrome is closed. No prompts are resent automatically after an uncertain send.

## Security boundaries

Only the Chrome device endpoints are exposed by the HTTPS proxy. MCP itself remains private. No API keys, passwords or cookies should ever be included in this repository. Source publication is separate from configuring the private relay and server infrastructure.

Run `npm test` to test the relay, extension logic and version reporting; mock tests are not live ChatGPT acceptance.