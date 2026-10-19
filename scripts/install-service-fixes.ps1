param([string]$Version = '0.5.5', [string]$EvidenceFile = 'service-fixes-install.json')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$expectedVersion = $Version
if ($expectedVersion -notmatch '^\d+\.\d+\.\d+$' -or $EvidenceFile -notmatch '^[a-zA-Z0-9-]+\.json$') { throw 'Invalid release arguments' }
$installerPath = Join-Path $projectRoot "release\Loam-Setup-$expectedVersion.exe"
$appPath = Join-Path $env:LOCALAPPDATA 'Programs\loam\Loam.exe'
if (!(Test-Path -LiteralPath $installerPath) -or !(Test-Path -LiteralPath $appPath)) { throw 'Expected installer/application missing' }
$beforeIdentity = Invoke-RestMethod 'http://127.0.0.1:3939/api/identity'
$beforeTasks = Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
if (@($beforeTasks.tasks | Where-Object { $_.status -in @('running','queued','pending') }).Count) { throw 'Active tasks prevent restart' }
$evidencePath = Join-Path $projectRoot ("output\verification\"+$EvidenceFile)
New-Item -ItemType Directory -Path (Split-Path -Parent $evidencePath) -Force | Out-Null
@{ beforeVersion=$beforeIdentity.version; profileId=$beforeIdentity.profileId; taskIds=@($beforeTasks.tasks.id) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $evidencePath -Encoding utf8
# Stop only the installed application's processes; never other Node/Electron apps.
$appProcesses = @(Get-CimInstance Win32_Process -Filter "Name='Loam.exe'" | Where-Object { $_.ExecutablePath -eq $appPath })
if (!$appProcesses.Count) { throw 'Installed app ownership could not be established' }
$ownedIds = @($appProcesses.ProcessId)
$mainProcesses = @($appProcesses | Where-Object { $_.ParentProcessId -notin $ownedIds })
foreach ($process in $mainProcesses) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
foreach ($process in (Get-CimInstance Win32_Process -Filter "Name='Loam.exe'" | Where-Object { $_.ExecutablePath -eq $appPath })) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
$installer = Start-Process -FilePath $installerPath -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
if ($installer.ExitCode -ne 0) { throw "Installer failed: $($installer.ExitCode)" }
Start-Process -FilePath $appPath -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(60)
$afterIdentity = $null
while ((Get-Date) -lt $deadline) {
  try { $afterIdentity = Invoke-RestMethod 'http://127.0.0.1:3939/api/identity' -TimeoutSec 2; if ($afterIdentity.version -eq $expectedVersion) { break } } catch {}
  Start-Sleep -Milliseconds 500
}
if ($afterIdentity.version -ne $expectedVersion) { throw 'Updated application did not become ready' }
if ($afterIdentity.profileId -ne $beforeIdentity.profileId) { throw 'Profile identity changed' }
$afterTasks = Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
$missing = @($beforeTasks.tasks.id | Where-Object { $_ -notin @($afterTasks.tasks.id) })
if ($missing.Count) { throw 'Previously listed tasks are missing after update' }
foreach ($route in @('/mobile.html','/security.html','/swarm.html','/creative.js','/integrations.html','/api/integrations')) {
  $response = Invoke-WebRequest ("http://127.0.0.1:3939"+$route) -TimeoutSec 15
  if ($response.StatusCode -ne 200) { throw "Route unavailable: $route" }
}
$catalog = Invoke-RestMethod 'http://127.0.0.1:3939/api/integrations'
$result = @{ version=$afterIdentity.version; profilePreserved=$true; previousTaskCount=@($beforeTasks.tasks).Count; currentTaskCount=@($afterTasks.tasks).Count; integrationTools=@($catalog.tools).Count; routesVerified=$true }
$result | ConvertTo-Json | Set-Content -LiteralPath $evidencePath -Encoding utf8
$result | ConvertTo-Json
