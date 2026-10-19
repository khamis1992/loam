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
$files = @('dist\server.cjs','ui\creative-editing.js','ui\creative-color.js','ui\creative-keyframes.js','ui\creative-timeline.css','ui\creative-timeline-model.js','ui\creative-timeline-engine.js','ui\creative-timeline-storage.js','ui\creative-timeline.js','ui\creative-export-jobs.js','ui\creative-render.html','node_modules\ffmpeg-static\ffmpeg.exe','node_modules\ffmpeg-static\ffmpeg.exe.LICENSE','node_modules\ffmpeg-static\ffmpeg.exe.README','node_modules\ffmpeg-static\LICENSE')
$backup = Join-Path $projectRoot ('output\verification\creative-background-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($relative in $files) {
  $source = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
  $target = [IO.Path]::GetFullPath((Join-Path $appRoot $relative))
  if (!$target.StartsWith([IO.Path]::GetFullPath($appRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped installed app' }
  if (!(Test-Path -LiteralPath $source)) { throw "Missing runtime file: $relative" }
  $copy = Join-Path $backup $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $copy) -Force | Out-Null
  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $copy }
}
function Stop-OwnedApp {
  $listener = Get-NetTCPConnection -LocalPort 3939 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='Loam.exe'" | Where-Object {$_.ExecutablePath -eq $appExe})
  if ($listener) {
    $owner = $processes | Where-Object {$_.ProcessId -eq $listener.OwningProcess}
    if (!$owner) { throw 'Listener is not owned by installed Loam' }
  } else {
    if (!$processes.Count) { return }
    $owner = @($processes | Where-Object {$_.CommandLine.Trim().Trim('"') -eq $appExe})
    if ($owner.Count -ne 1) { throw 'Cannot identify a unique installed Loam parent during startup' }
    $owner = $owner[0]
  }
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
  foreach ($relative in $files) { $target = Join-Path $appRoot $relative; New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null; Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination $target -Force }
  $after = Start-VerifiedApp
  $afterTasks = @((Invoke-RestMethod "$base/api/tasks").tasks)
  if (@($tasks | Where-Object {$_.id -notin $afterTasks.id}).Count) { throw 'Tasks missing after restart' }
  if (!$afterTasks.Count) { throw 'No existing task to verify capabilities' }
  $result = Invoke-RestMethod "$base/api/timeline/environment"
  if (!$result.background -or !$result.ffmpegAvailable) { throw 'Background renderer unavailable' }
  foreach ($relative in $files) {
    if ((Get-FileHash -LiteralPath (Join-Path $projectRoot $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $appRoot $relative)).Hash) { throw "Installed file differs from validated source: $relative" }
  }
  $report = @{profilePreserved=$true;tasksPreserved=$true;taskCount=$afterTasks.Count;backgroundApi=$true;backup=$backup;version=$after.version}
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backup 'verification.json') -Encoding utf8
  $report | ConvertTo-Json -Depth 6
} catch {
  $failure = $_
  try { Stop-OwnedApp } catch {}
  foreach ($relative in $files) { $original = Join-Path $backup $relative; if (Test-Path -LiteralPath $original) { Copy-Item -LiteralPath $original -Destination (Join-Path $appRoot $relative) -Force } }
  Start-VerifiedApp | Out-Null
  throw $failure
}
