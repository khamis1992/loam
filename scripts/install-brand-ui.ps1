$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installedUi = Join-Path $env:LOCALAPPDATA 'Programs\loam\resources\app\ui'
if (!(Test-Path -LiteralPath (Join-Path $installedUi 'index.html'))) { throw 'Installed Loam UI not found' }
$before = Invoke-RestMethod 'http://127.0.0.1:3939/api/identity'
$tasks = Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
$files = @('icons.css','icons.js','theme.js','swarm.css','creative.css','security.css','mobile.css','integrations.css','companions.js','creative.js','mobile.js','skills.js','learning.js','app.js','studio.js','task-view.js','studios\app.js','studios\style.css')
$files += @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'ui') -Filter '*.html' | Where-Object Name -ne 'mobile-preview.html' | ForEach-Object Name)
$files += 'studios\index.html'
$backup = Join-Path $projectRoot ('output\verification\brand-ui-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($file in $files) {
  $target = Join-Path $installedUi $file
  $saved = Join-Path $backup $file
  New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $saved }
  Copy-Item -LiteralPath (Join-Path $projectRoot ('ui\'+$file)) -Destination $target
  if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath (Join-Path $projectRoot ('ui\'+$file))).Hash) { throw "UI file verification failed: $file" }
}
$after = Invoke-RestMethod 'http://127.0.0.1:3939/api/identity'
$afterTasks = Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
if ($before.profileId -ne $after.profileId) { throw 'Profile changed unexpectedly' }
if (@($tasks.tasks.id | Where-Object { $_ -notin @($afterTasks.tasks.id) }).Count) { throw 'Task missing after UI update' }
@{ files=$files.Count; version=$after.version; profilePreserved=$true; taskCount=@($afterTasks.tasks).Count; processRestarted=$false; backup=$backup } | ConvertTo-Json | Tee-Object -FilePath (Join-Path $projectRoot 'output\verification\brand-ui-installed.json')
