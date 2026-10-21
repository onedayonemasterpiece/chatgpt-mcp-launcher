#Requires -Version 5.1
<#
Public one-time bootstrap and 15-minute lightweight updater.
No Git, administrator rights, ChatGPT Desktop, dot or SSH forward required.
Install once with -Install; the same file is copied into LOCALAPPDATA
and run by Windows Task Scheduler thereafter.
#>
param(
  [switch]$Install,
  [switch]$Check,
  [switch]$Status,
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpLauncher')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$repo = 'onedayonemasterpiece/chatgpt-mcp-launcher'
$taskName = 'ChatGPT MCP Launcher Updates'
$protocolName = 'chatgpt-mcp-update'
$ext = Join-Path $Root 'source\chatgpt-launcher\extension'
$marker = Join-Path $ext 'dev-revision.json'
$statusPath = Join-Path $ext 'updater-status.json'
$updater = Join-Path $Root 'updater.ps1'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$mutex = $null
$lockHeld = $false
$workspace = $null
$targetRevision = $null
$checkId = [guid]::NewGuid().ToString('N')
$checkStartedAt = [DateTime]::UtcNow.ToString('o')

function Read-Json([string]$Path) {
  if(!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { return $null }
}
function Atomic-Text([string]$Path,[string]$Body) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temp = Join-Path $directory ('.launcher-'+[guid]::NewGuid().ToString('N')+'.tmp')
  try {
    [System.IO.File]::WriteAllText($temp,$Body,$utf8)
    Move-Item -LiteralPath $temp -Destination $Path -Force -ErrorAction Stop
  } finally {
    if(Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}
function Atomic-File([string]$Source,[string]$Destination) {
  $directory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temp = Join-Path $directory ('.launcher-'+[guid]::NewGuid().ToString('N')+'.tmp')
  try {
    Copy-Item -LiteralPath $Source -Destination $temp -ErrorAction Stop
    Move-Item -LiteralPath $temp -Destination $Destination -Force -ErrorAction Stop
  } finally {
    if(Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}
function Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Report-Status([string]$State,[string]$ErrorCode='') {
  if(!(Test-Path -LiteralPath $ext -PathType Container)) { return }
  $current = Read-Json $marker
  $rev = if($null -ne $current) { $current.revision } else { $null }
  $record = [ordered]@{
    schema_version = 1
    checked_at = [DateTime]::UtcNow.ToString('o')
    check_id = $checkId
    started_at = $checkStartedAt
    state = $State
    installed_revision = $rev
    source_revision = $targetRevision
    error_code = if($ErrorCode) { $ErrorCode } else { $null }
    interval_minutes = 15
  }
  Atomic-Text $statusPath ($record|ConvertTo-Json -Compress -Depth 3)
}
function Is-Installed([string]$Revision) {
  $data = Read-Json $marker
  if($null -eq $data -or $data.revision -ne $Revision -or $data.schema_version -ne 2) { return $false }
  $bg = Join-Path $ext 'background.js'
  $driver = Join-Path $ext ('page-driver-'+$Revision+'.js')
  $build = Join-Path $ext 'build-info.js'
  if(!(Test-Path $bg) -or !(Test-Path $driver) -or !(Test-Path $build)) { return $false }
  try {
    return ((Sha256 $bg) -eq $data.background_sha256 -and
            (Sha256 $driver) -eq $data.driver_sha256)
  } catch { return $false }
}
function Install-Schedule {
  if(!(Test-Path -LiteralPath $updater -PathType Leaf)) { throw 'updater_script_missing' }
  $taskRun = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$updater+'" -Check'
  & schtasks.exe /Create /F /SC MINUTE /MO 15 /TN $taskName /TR $taskRun | Out-Null
  if($LASTEXITCODE -ne 0) { throw 'windows_scheduler_registration_failed' }
  Write-Host 'Scheduled update check installed (every 15 minutes).'
}
function Install-UpdateProtocol {
  if(!(Test-Path -LiteralPath $updater -PathType Leaf)) { throw 'update_handler_missing' }
  $base = 'Registry::HKEY_CURRENT_USER\Software\Classes\' + $protocolName
  $cmdKey = $base + '\shell\open\command'
  $vbsPath = Join-Path $Root 'launch-update.vbs'
  $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
  $powershell = Join-Path $PSHOME 'powershell.exe'
  foreach($path in @($vbsPath,$updater,$Root,$powershell)) {
    if($path -match '["`r`n]') { throw 'invalid_launcher_path' }
  }
  $arguments = '"' + $powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $updater + '" -Check -Root "' + $Root + '"'
  $vbs = 'Set sh = CreateObject("WScript.Shell")' + [Environment]::NewLine +
    'sh.Run "' + $arguments.Replace('"','""') + '", 0, False' + [Environment]::NewLine
  $existing = if(Test-Path -LiteralPath $vbsPath) {[System.IO.File]::ReadAllText($vbsPath)} else {$null}
  if($existing -cne $vbs) {
    $temp = $vbsPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
      [System.IO.File]::WriteAllText($temp,$vbs,[System.Text.Encoding]::Unicode)
      Move-Item -LiteralPath $temp -Destination $vbsPath -Force
    } finally { if(Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
  }
  $launch = '"' + $wscript + '" //B //NoLogo "' + $vbsPath + '"'
  New-Item -Path $base -Force | Out-Null
  if((Get-Item $base).GetValue('') -cne 'URL:ChatGPT MCP Launcher update') {
    Set-Item -Path $base -Value 'URL:ChatGPT MCP Launcher update'
  }
  if((Get-Item $base).GetValue('URL Protocol') -ne '') {
    New-ItemProperty -Path $base -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  }
  New-Item -Path $cmdKey -Force | Out-Null
  if((Get-Item $cmdKey).GetValue('') -cne $launch) { Set-Item -Path $cmdKey -Value $launch }
  if($Install) { Write-Host 'Silent update button handler installed (no visible PowerShell console).' }
}
function Latest-Revision {
  $api = 'https://api.github.com/repos/'+$repo+'/commits/main'
  $headers = @{'User-Agent'='ChatGPT-MCP-Launcher-Updater/1.0';'Accept'='application/vnd.github+json'}
  $response = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 20 -ErrorAction Stop
  $sha = [string]$response.sha
  if($sha -notmatch '^[a-f0-9]{40}$') { throw 'github_commit_sha_invalid' }
  return $sha
}

try {
  if($Status) {
    $latest=Read-Json $marker
    $state=Read-Json $statusPath
    Write-Host ('Installed SHA: '+$(if($latest) {$latest.revision} else {'not installed'}))
    Write-Host ('Updater state: '+$(if($state) {$state.state} else {'not initialized'}))
    Write-Host ('Last checked: '+$(if($state) {$state.checked_at} else {'never'}))
    if($state -and $state.error_code) {Write-Host ('Error code: '+$state.error_code)}
    & schtasks.exe /Query /TN $taskName /FO LIST 2>$null
    if($LASTEXITCODE -ne 0) { Write-Host 'Update task: not registered' }
    exit 0
  }

  New-Item -ItemType Directory -Path $Root -Force | Out-Null
  $mutex = [System.Threading.Mutex]::new($false,'Local\ChatGPTMcpLauncherPublicUpdate')
  $lockHeld = $mutex.WaitOne(0)
  if(!$lockHeld) { Write-Host 'Another updater check is already running.'; exit 0 }

  # Report progress immediately, including when no archive download is needed.
  Report-Status 'checking'
  # Small independent public GitHub SHA check every 15 minutes or by button.
  $targetRevision = Latest-Revision
  if(Is-Installed $targetRevision) {
    Report-Status 'current'
    Write-Host ('Already current: '+$targetRevision)
  } else {
    $workspace = Join-Path $env:TEMP ('chatgpt-mcp-launcher-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    $zipPath = Join-Path $workspace 'source.zip'
    $expanded = Join-Path $workspace 'expanded'
    $downloadUrl = 'https://codeload.github.com/'+$repo+'/zip/'+$targetRevision
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
    if((Get-Item -LiteralPath $zipPath).Length -lt 1000) { throw 'github_archive_too_small' }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $expanded -Force
    $dirs = @(Get-ChildItem -LiteralPath $expanded -Directory)
    if($dirs.Count -ne 1) { throw 'github_archive_structure_invalid' }
    $source = $dirs[0].FullName
    $sourceExt = Join-Path $source 'extension'
    $required = @('manifest.json','background.js','page-driver.js','popup.html','popup.js')
    foreach($file in $required) {
      if(!(Test-Path -LiteralPath (Join-Path $sourceExt $file) -PathType Leaf)) {
        throw 'required_extension_source_missing'
      }
    }
    $sourceInstaller = Join-Path $source 'install.ps1'
    if(!(Test-Path -LiteralPath $sourceInstaller -PathType Leaf)) {
      throw 'public_updater_missing'
    }

    # Copy source files atomically; immutable per-commit page driver means a
    # running old worker cannot unknowingly execute the new injected driver.
    $driverName = 'page-driver-'+$targetRevision+'.js'
    $driverTarget = Join-Path $ext $driverName
    if(Test-Path -LiteralPath $driverTarget) {
      if((Sha256 $driverTarget) -ne (Sha256 (Join-Path $sourceExt 'page-driver.js'))) {
        throw 'immutable_driver_conflict'
      }
    } else {
      Atomic-File (Join-Path $sourceExt 'page-driver.js') $driverTarget
    }

    # Keep the previously installed Chrome extension DIRECTORY and settings.
    foreach($file in $required) {
      Atomic-File (Join-Path $sourceExt $file) (Join-Path $ext $file)
    }

    $backgroundHash = Sha256 (Join-Path $ext 'background.js')
    $driverHash = Sha256 $driverTarget
    $build = [ordered]@{
      revision = $targetRevision
      background_sha256 = $backgroundHash
      driver_file = $driverName
      driver_sha256 = $driverHash
    }
    $buildJs = 'globalThis.CHATGPT_LAUNCHER_BUILD = Object.freeze('+($build|ConvertTo-Json -Compress -Depth 3)+');'
    Atomic-Text (Join-Path $ext 'build-info.js') $buildJs
    Atomic-File $sourceInstaller $updater

    # Final marker is written only after all new files are present and checked.
    $stamp = [ordered]@{
      schema_version = 2
      revision = $targetRevision
      background_sha256 = $backgroundHash
      driver_sha256 = $driverHash
    }
    Atomic-Text $marker ($stamp|ConvertTo-Json -Compress -Depth 3)
    if(!(Is-Installed $targetRevision)) { throw 'local_integrity_verification_failed' }
    Report-Status 'updated'
    Write-Host ('Installed GitHub revision: '+$targetRevision)
  }
  if($Install) { Install-Schedule }
  # Self-heal the native button handler on normal scheduled/manual checks too.
  Install-UpdateProtocol
  Write-Host ('Chrome unpacked extension: '+$ext)
  Write-Host 'Chrome: chrome://extensions -> Developer mode -> Load unpacked (once) -> path above.'
  Write-Host 'The Chrome update button now triggers a silent WScript launcher. Chrome may ask permission to open the app.'
  Write-Host 'Keep only one Launcher extension enabled (disable the old copy if installed elsewhere).'
  Write-Host 'When Chrome reloads, active and installed revisions are reported to MCP.'
} catch {
  $code = [string]$_.Exception.Message
  $code = ($code -replace '[^A-Za-z0-9_-]','_').ToLowerInvariant()
  if($code.Length -gt 60 -or $code.Length -lt 1) {$code='updater_failed'}
  try { Report-Status 'error' $code } catch {}
  Write-Host ('Installer/update failed: '+$code)
  exit 1
} finally {
  if($workspace -and (Test-Path -LiteralPath $workspace)) {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
  }
  if($lockHeld) { $mutex.ReleaseMutex() }
  if($mutex) { $mutex.Dispose() }
}
