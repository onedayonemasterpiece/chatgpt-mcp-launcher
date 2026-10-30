$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:RUNNER_TEMP 'Launcher Schedule With Spaces'
$updater = Join-Path $Root 'updater.ps1'
$taskName = 'LauncherScheduleFixture-' + $PID
$receipt = Join-Path $Root 'receipt.txt'
try {
  New-Item -ItemType Directory -Path $Root -Force | Out-Null
  @'
param([switch]$Check,[string]$Root)
if (!$Check -or !$Root) { exit 2 }
Set-Content -LiteralPath (Join-Path $Root 'receipt.txt') -Value $Root -NoNewline
'@ | Set-Content -LiteralPath $updater -Encoding ASCII
  $installer = Join-Path $PSScriptRoot '..\install.ps1'
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
  $definition = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-Schedule'}, $true)
  . ([scriptblock]::Create($definition.Extent.Text))
  Install-Schedule
  $task = Get-ScheduledTask -TaskName $taskName
  if ($task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries) {
    throw 'Updater must not be stopped or refused just because the laptop is on battery'
  }
  Start-ScheduledTask -TaskName $taskName
  for ($n=0; $n -lt 30 -and !(Test-Path $receipt); $n++) { Start-Sleep -Seconds 1 }
  if (!(Test-Path $receipt) -or (Get-Content -Raw $receipt) -ne $Root) {
    throw 'Registered scheduler command did not execute in its configured installation root'
  }
  Write-Host 'PASS: scheduled updater executes with custom root and permits battery operation'
  # A hidden manual check must report contention to the popup, not silently exit OK.
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'source\chatgpt-launcher\extension') | Out-Null
  $busyMutex = [System.Threading.Mutex]::new($false,'Local\ChatGPTMcpLauncherPublicUpdate')
  $busyHeld = $busyMutex.WaitOne(0)
  try {
    if (!$busyHeld) { throw 'Fixture could not acquire updater mutex' }
    & (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -Manual -Root $Root
    $busyExit = $LASTEXITCODE
    $busyStatus = Get-Content -Raw (Join-Path $Root 'source\chatgpt-launcher\extension\updater-status.json') | ConvertFrom-Json
    if ($busyExit -ne 1 -or $busyStatus.state -ne 'error' -or $busyStatus.error_code -ne 'updater_already_running' -or $busyStatus.trigger -ne 'manual' -or !$busyStatus.check_id) {
      throw 'Contended manual updater must return a correlated terminal error'
    }
    Write-Host 'PASS: contended manual updater reports its exact reason without downloading or modifying source'
    $global:LASTEXITCODE = 0 # The child failure above is the expected assertion outcome.
  } finally {
    if ($busyHeld) { $busyMutex.ReleaseMutex() }
    $busyMutex.Dispose()
  }
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
}
