$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$version=(Get-Content -LiteralPath (Join-Path $root 'release/win-unpacked/resources/app/package.json') -Raw | ConvertFrom-Json).version
$setup=Join-Path $root "release/Loam-Setup-$version.exe"
$exe=Join-Path $env:LOCALAPPDATA 'Programs/loam/Loam.exe'
$tasks=@{tasks=@()}
try { $tasks=Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks' } catch {
  if(@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $exe}).Count -gt 0){throw 'Loam is running but its task state cannot be checked'}
}
if(@($tasks.tasks | Where-Object {$_.status -in @('running','queued','pending')}).Count -gt 0){throw 'Active tasks prevent restart'}
if(!(Test-Path -LiteralPath $setup)){throw 'Built installer is missing'}
Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $exe} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
$installer=Start-Process -FilePath $setup -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
if($installer.ExitCode -ne 0){throw "Installer failed: $($installer.ExitCode)"}
$appRoot=Join-Path (Split-Path -Parent $exe) 'resources/app'
$checks=foreach($file in @('dist/server.cjs','scripts/render-word-preview.ps1','ui/studio.js','ui/studio-source-pictures.js','ui/studio-preview-edit.js','ui/studio-workspace.js','ui/studio-sheet-grid.js','ui/studio-sheet-borders.js','ui/studio-sheet-print.js','ui/studio-sheet-clipboard.js','ui/studio-slides.js','ui/studio-slide-charts.js','ui/studio-slide-preview.js','ui/chart-scale.js','scripts/render-slide-preview.ps1','ui/studio-slide-images.js','ui/studio-slide-tables.js','ui/studio-sheet-format.js','ui/studio.css','ui/studio-document.js','ui/studio-rich.js','ui/studio-preview.js','ui/office-preview.html','ui/office-preview.bundle.js')){
  $expected=(Get-FileHash -LiteralPath (Join-Path $root "release/win-unpacked/resources/app/$file") -Algorithm SHA256).Hash
  $actual=(Get-FileHash -LiteralPath (Join-Path $appRoot $file) -Algorithm SHA256).Hash
  if($actual -ne $expected){throw "Installed file mismatch: $file"}
  @{file=$file;sha256=$actual;matches=$true}
}
@{version=$version;executableVersion=(Get-Item -LiteralPath $exe).VersionInfo.ProductVersion;checks=$checks} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'output/word-review/installed-verification.json') -Encoding utf8
Write-Output "Verified installed Loam $version and all Word quality files."


