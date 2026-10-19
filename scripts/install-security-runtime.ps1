$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appExe = Join-Path $env:LOCALAPPDATA 'Programs\loam\Loam.exe'
$appRoot = Join-Path $env:LOCALAPPDATA 'Programs\loam\resources\app'
$base = 'http://127.0.0.1:3939'
$before = Invoke-RestMethod "$base/api/identity"
$tasks = @( (Invoke-RestMethod "$base/api/tasks").tasks )
if (@($tasks | Where-Object {$_.status -in @('running','queued','pending')}).Count) { throw 'Active tasks prevent restart' }
foreach ($task in $tasks) {
  $runs = Invoke-RestMethod "$base/api/security/assessments?taskId=$($task.id)"
  if (@($runs.runs | Where-Object {$_.status -eq 'running'}).Count) { throw 'Active security assessment prevents restart' }
}
$files = @('dist\server.cjs','ui\security.html','ui\security.js','ui\security.css')
$backup = Join-Path $projectRoot ('output\verification\security-runtime-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$candidateRoot = Join-Path $backup 'candidate'
foreach ($relative in $files) {
  $source = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
  $target = [IO.Path]::GetFullPath((Join-Path $appRoot $relative))
  if (!$target.StartsWith([IO.Path]::GetFullPath($appRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped installed app' }
  if (!(Test-Path -LiteralPath $source) -or !(Test-Path -LiteralPath $target)) { throw "Missing runtime file: $relative" }
  $copy = Join-Path $backup $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $copy) -Force | Out-Null
  Copy-Item -LiteralPath $target -Destination $copy
  # Freeze this deployment's input: another task may rebuild dist while Loam restarts.
  $candidate = Join-Path $candidateRoot $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $candidate) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $candidate
  if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $candidate).Hash) { throw "Build changed during staging: $relative" }
}
function Stop-OwnedApp {
  $listener = Get-NetTCPConnection -LocalPort 3939 -State Listen | Select-Object -First 1
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='Loam.exe'" | Where-Object {$_.ExecutablePath -eq $appExe})
  $owner = $processes | Where-Object {$_.ProcessId -eq $listener.OwningProcess}
  if (!$owner) { throw 'Listener is not owned by installed Loam' }
  while ($parent = $processes | Where-Object {$_.ProcessId -eq $owner.ParentProcessId}) { $owner = $parent }
  $owned = @($owner.ProcessId)
  do { $children = @($processes | Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned});if ($children.Count) { $owned += @($children.ProcessId) } } while ($children.Count)
  Stop-Process -Id $owner.ProcessId -Force
  Start-Sleep -Milliseconds 600
  foreach ($id in $owned) { if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
}
function Start-VerifiedApp {
  Start-Process -FilePath $appExe -WindowStyle Hidden | Out-Null
  $end = (Get-Date).AddSeconds(55)
  do {
    try { $identity = Invoke-RestMethod "$base/api/identity" -TimeoutSec 2; if ($identity.profileId -eq $before.profileId) { return $identity } } catch {}
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $end)
  throw 'Installed app did not return with the same profile'
}
try {
  Stop-OwnedApp
  foreach ($relative in $files) { Copy-Item -LiteralPath (Join-Path $candidateRoot $relative) -Destination (Join-Path $appRoot $relative) -Force }
  $after = Start-VerifiedApp
  $afterTasks = @((Invoke-RestMethod "$base/api/tasks").tasks)
  if (@($tasks | Where-Object {$_.id -notin $afterTasks.id}).Count) { throw 'Tasks missing after restart' }
  if (!$afterTasks.Count) { throw 'No existing task to verify capabilities' }
  $result = Invoke-RestMethod "$base/api/security/assessments?taskId=$($afterTasks[0].id)"
  if ($result.capabilities.revision -lt 40) { throw 'Updated security engine is unavailable' }
  $ui = (Invoke-WebRequest "$base/security.html").Content
  if (!$ui.Contains('testAccounts') -or !$ui.Contains('authorizationCases') -or !$ui.Contains('apiGrants') -or !$ui.Contains('responseLimitMb') -or !$ui.Contains('readinessTimeoutMs') -or !$ui.Contains('openapiFixtures')) { throw 'Updated security UI is unavailable' }
  foreach ($relative in $files) {
    if ((Get-FileHash -LiteralPath (Join-Path $candidateRoot $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $appRoot $relative)).Hash) { throw "Installed file differs from staged build: $relative" }
  }
  $report = @{profilePreserved=$true;tasksPreserved=$true;taskCount=$afterTasks.Count;capabilities=$result.capabilities;backup=$backup;candidate=$candidateRoot;version=$after.version}
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backup 'verification.json') -Encoding utf8
  $report | ConvertTo-Json -Depth 6
} catch {
  $failure = $_
  try { Stop-OwnedApp } catch {}
  foreach ($relative in $files) { Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination (Join-Path $appRoot $relative) -Force }
  Start-VerifiedApp | Out-Null
  throw $failure
}
