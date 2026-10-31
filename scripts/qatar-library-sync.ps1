# Weekly Qatar law library sync for Loam on Windows (run Sundays after the al-Araf update).
# Usage (PowerShell):
#   .\scripts\qatar-library-sync.ps1 -Source "D:\alaraf-lawyer\laws" [-DataDir "$env:APPDATA\Loam"]
# Register weekly task (Sunday 09:00):
#   schtasks /Create /SC WEEKLY /D SUN /ST 09:00 /TN "Loam Qatar Library Sync" `
#     /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"C:\path\to\loam\scripts\qatar-library-sync.ps1`" -Source `"D:\alaraf-lawyer\laws`""
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$DataDir = "",
  [switch]$Force,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA "Loam" }   # adjust if Loam's DATA_DIR differs (Settings > About)
$Target = Join-Path $DataDir "legal\library"
$Corpus = Join-Path $DataDir "legal\qatar-law.db"
$Script = Join-Path $PSScriptRoot "qatar-library-sync.mjs"
$nodeVer = (& node -v) -replace "v", ""
if ([version]$nodeVer -lt [version]"22.13.0") { throw "Node >= 22.13 required (found $nodeVer)" }
$a = @($Script, "--source", $Source, "--target", $Target, "--corpus", $Corpus)
if ($Force) { $a += "--force" }; if ($DryRun) { $a += "--dry-run" }
$logDir = Join-Path $Target "sync-reports"; New-Item -ItemType Directory -Force -Path $logDir | Out-Null
& node @a 2>&1 | Tee-Object -FilePath (Join-Path $logDir "last-run.log")
exit $LASTEXITCODE
