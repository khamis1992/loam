$ErrorActionPreference='Stop'
$root='C:\Users\khamis\Desktop\manus-local'
$exe=Join-Path $env:LOCALAPPDATA 'Programs\loam\Loam.exe'
$setup=Join-Path $root 'release\Loam-Setup-0.5.4.exe'
$tasks=Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
if(@($tasks.tasks | Where-Object {$_.status -in @('running','queued','pending')}).Count -gt 0){throw 'Active tasks prevent restart'}
$owned=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $exe}
$owned | Where-Object {$_.CommandLine -notmatch '--type=|server.cjs|server.mjs|mcp-server.js'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $exe} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
$installer=Start-Process -FilePath $setup -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
if($installer.ExitCode -ne 0){throw "Installer failed: $($installer.ExitCode)"}
(Get-Item -LiteralPath $exe).VersionInfo | Select-Object ProductName,ProductVersion

