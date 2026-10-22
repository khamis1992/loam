param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedRuntimeHash, [ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedTaskViewHash)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appExe = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\loam\Loam.exe'))
$appRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\loam\resources\app'))
$target = [IO.Path]::GetFullPath((Join-Path $appRoot 'dist\server.cjs'))
if (!$target.StartsWith($appRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation target' }
$base = 'http://127.0.0.1:3939'
$before = Invoke-RestMethod "$base/api/identity"
$tasks = @((Invoke-RestMethod "$base/api/tasks").tasks)
function Assert-Idle {
  $current = @((Invoke-RestMethod "$base/api/tasks").tasks)
  if (@($current | Where-Object {$_.status -in @('running','queued','pending')}).Count) { throw 'Active tasks prevent restart' }
  foreach ($task in $current) {
    $assessments = Invoke-RestMethod "$base/api/security/assessments?taskId=$($task.id)"
    if (@($assessments.runs | Where-Object {$_.status -eq 'running'}).Count) { throw 'Active assessment prevents restart' }
  }
}
Assert-Idle
$backupRoot = Join-Path $projectRoot ('output\verification\bot-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$backup = Join-Path $backupRoot 'previous-server.cjs'
$candidate = Join-Path $backupRoot 'candidate-server.cjs'
Copy-Item -LiteralPath $target -Destination $backup
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist\server.cjs') -Destination $candidate
$expectedHash = (Get-FileHash -LiteralPath $candidate).Hash
if ($expectedHash -ne $ExpectedRuntimeHash) { throw 'Candidate differs from the verified build; do not install' }
$originalHash = (Get-FileHash -LiteralPath $backup).Hash
$viewTarget = Join-Path $appRoot 'ui\task-view.js'
$viewBackup = Join-Path $backupRoot 'previous-task-view.js'
$viewCandidate = Join-Path $backupRoot 'candidate-task-view.js'
if ($ExpectedTaskViewHash) {
  Copy-Item -LiteralPath $viewTarget -Destination $viewBackup
  Copy-Item -LiteralPath (Join-Path $projectRoot 'ui\task-view.js') -Destination $viewCandidate
  if ((Get-FileHash -LiteralPath $viewCandidate).Hash -ne $ExpectedTaskViewHash) { throw 'Task view differs from verified candidate' }
  $originalViewHash = (Get-FileHash -LiteralPath $viewBackup).Hash
}
function Stop-OwnedApp {
  $listener = Get-NetTCPConnection -LocalPort 3939 -State Listen | Select-Object -First 1
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='Loam.exe'" | Where-Object {$_.ExecutablePath -eq $appExe})
  $owner = $processes | Where-Object {$_.ProcessId -eq $listener.OwningProcess}
  if (!$owner) { throw 'Listener is not owned by the installed Loam executable' }
  while ($parent = $processes | Where-Object {$_.ProcessId -eq $owner.ParentProcessId}) { $owner = $parent }
  $owned = @($owner.ProcessId)
  do { $children = @($processes | Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned}); if ($children.Count) { $owned += @($children.ProcessId) } } while ($children.Count)
  Stop-Process -Id $owner.ProcessId -Force
  Start-Sleep -Milliseconds 700
  foreach ($processId in $owned) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
}
function Start-VerifiedApp {
  Start-Process -FilePath $appExe -WindowStyle Hidden | Out-Null
  $end = (Get-Date).AddSeconds(50)
  do {
    try { $identity = Invoke-RestMethod "$base/api/identity" -TimeoutSec 2; if ($identity.profileId -eq $before.profileId) { return $identity } } catch {}
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $end)
  throw 'Installed application did not return with the original profile'
}
$replaced = $false
try {
  Assert-Idle
  if ((Get-FileHash -LiteralPath $target).Hash -ne $originalHash) { throw 'Installed runtime changed during staging; retry against current state' }
  if ($ExpectedTaskViewHash -and (Get-FileHash -LiteralPath $viewTarget).Hash -ne $originalViewHash) { throw 'Installed task view changed during staging' }
  Stop-OwnedApp
  $replaced = $true
  Copy-Item -LiteralPath $candidate -Destination $target -Force
  if ($ExpectedTaskViewHash) { Copy-Item -LiteralPath $viewCandidate -Destination $viewTarget -Force }
  $after = Start-VerifiedApp
  $capabilities = Invoke-RestMethod "$base/api/bot/capabilities"
  if ($capabilities.revision -ne 11 -or !$capabilities.acceptanceIntegrity.independentMandatoryForApplications -or !$capabilities.acceptanceIntegrity.independentCheckpointResume -or !$capabilities.applicationVerification.backendRuntime.processRestart -or !$capabilities.applicationVerification.apiChecks.exactJsonResponse -or !$capabilities.applicationVerification.apiChecks.declarative -or !$capabilities.mandatoryFinalVerification -or !$capabilities.acceptanceIntegrity.preservesRepairChecks -or !$capabilities.applicationVerification.sqliteChecks.readOnly -or !$capabilities.applicationVerification.expectedHttpResponses -or !$capabilities.applicationVerification.visualReview -or !$capabilities.applicationVerification.backendApplications -or !$capabilities.creativeVerification.visualReview) { throw 'BOT verification runtime is not active' }
  $afterTasks = @((Invoke-RestMethod "$base/api/tasks").tasks)
  if (@($tasks | Where-Object {$_.id -notin $afterTasks.id}).Count) { throw 'Existing tasks missing after update' }
  if ((Get-FileHash -LiteralPath $target).Hash -ne $expectedHash) { throw 'Installed runtime hash differs from tested candidate' }
  if ($ExpectedTaskViewHash -and (Get-FileHash -LiteralPath $viewTarget).Hash -ne $ExpectedTaskViewHash) { throw 'Installed task view differs from tested candidate' }
  $report = @{at=(Get-Date).ToString('o'); profilePreserved=$true; tasksPreserved=$tasks.Count; runtimeHash=$expectedHash; capabilities=$capabilities; backup=$backup; candidate=$candidate; version=$after.version}
  if ($ExpectedTaskViewHash) { $report.taskViewHash = $ExpectedTaskViewHash; $report.taskViewBackup = $viewBackup }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backupRoot 'verification.json') -Encoding utf8
  $report | ConvertTo-Json -Depth 8
} catch {
  $failure = $_
  if ($replaced) {
    try { Stop-OwnedApp } catch {}
    Copy-Item -LiteralPath $backup -Destination $target -Force
    if ($ExpectedTaskViewHash) { Copy-Item -LiteralPath $viewBackup -Destination $viewTarget -Force }
    Start-VerifiedApp | Out-Null
  }
  throw $failure
}
