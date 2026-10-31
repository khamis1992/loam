# Qatar law library importer - finds the alaraf source anywhere it appears
# (USB stick, any drive, Documents...) and runs the weekly sync from it.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\qatar-library-import.ps1 [-DataDir <dir>] [-DryRun] [-Source <dir>]
# Exit codes: 0 synced (or unchanged), 1 sync failed, 2 no source found, 3 multiple candidates (pass -Source)
param(
  [string]$DataDir = "",
  [string]$Source = "",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$Repo = "C:\Users\khamis\Desktop\manus-local"
if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA "Loam\data" }
$Target = Join-Path $DataDir "legal\library"
$Canonical = "C:\Users\khamis\Documents\alaraf-lawyer\laws"

function Find-Sources {
  $found = New-Object System.Collections.Generic.List[string]
  # 1) the canonical home
  if (Test-Path (Join-Path $Canonical "search.db")) { $found.Add($Canonical) }
  # 2) likely folder names near every drive root and the user's media folders
  $roots = @()
  Get-PSDrive -PSProvider FileSystem | ForEach-Object { $roots += $_.Root }
  $roots += @("$env:USERPROFILE\Desktop", "$env:USERPROFILE\Documents", "$env:USERPROFILE\Downloads", "$env:USERPROFILE\OneDrive")
  $names = @("laws", "alaraf-lawyer", "alaraf")
  foreach ($root in ($roots | Select-Object -Unique)) {
    if (-not (Test-Path $root)) { continue }
    try {
      Get-ChildItem -Path $root -Directory -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Where-Object { $names -contains $_.Name.ToLower() -and (Test-Path (Join-Path $_.FullName "search.db")) } |
        ForEach-Object { $found.Add($_.FullName) }
    } catch {}
  }
  # 3) last resort: any search.db (>0.5 MB, outside our own target and caches)
  foreach ($root in ($roots | Select-Object -Unique)) {
    if (-not (Test-Path $root)) { continue }
    try {
      Get-ChildItem -Path $root -Filter "search.db" -File -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -gt 500KB -and $_.FullName -notlike "*\AppData\Roaming\Loam\*" -and $_.FullName -notlike "*node_modules*" } |
        ForEach-Object { $found.Add($_.Directory.FullName) }
    } catch {}
  }
  return $found | Select-Object -Unique
}

if ($Source -and (Test-Path (Join-Path $Source "search.db"))) {
  $candidates = @($Source)
} else {
  Write-Host "[import] searching for the library source (search.db) on all drives..."
  $candidates = @(Find-Sources)
}
if ($candidates.Count -eq 0) {
  Write-Host "[import] NO SOURCE FOUND on any drive." -ForegroundColor Yellow
  Write-Host "[import] Put the laws folder (the one containing search.db) anywhere -" -ForegroundColor Yellow
  Write-Host "        recommended: $Canonical - then run this tool again or wait for the Sunday task." -ForegroundColor Yellow
  exit 2
}
if ($candidates.Count -gt 1) {
  Write-Host "[import] MULTIPLE candidate sources found:" -ForegroundColor Yellow
  $candidates | ForEach-Object { Write-Host "  - $_" }
  Write-Host "        Re-run with: -Source `"<the right path>`"" -ForegroundColor Yellow
  exit 3
}
$src = $candidates[0]
Write-Host "[import] source: $src"
Write-Host "[import] target: $Target"
$syncArgs = @("-ExecutionPolicy", "Bypass", "-File", (Join-Path $Repo "scripts\qatar-library-sync.ps1"), "-Source", $src, "-DataDir", $DataDir)
if ($DryRun) { $syncArgs += "-DryRun" }
& powershell @syncArgs
exit $LASTEXITCODE
