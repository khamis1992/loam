$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installedApp = Join-Path $env:LOCALAPPDATA 'Programs\loam\resources\app'
if (!(Test-Path -LiteralPath (Join-Path $installedApp 'ui\companions.js'))) { throw 'Installed Loam app not found' }
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'dist\server.cjs'))) { throw 'Build first: dist\server.cjs missing — run npm run build:server' }

# Health snapshot before (the running server keeps old code until restart; the UI file is served per-request).
$before = $null
try { $before = Invoke-RestMethod 'http://127.0.0.1:3939/api/identity' } catch { $before = $null }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $projectRoot ("output\verification\companions-fixes-backup-" + $stamp)
New-Item -ItemType Directory -Path $backup -Force | Out-Null

$targets = @(
  @{ src = Join-Path $projectRoot 'ui\companions.js';    dst = Join-Path $installedApp 'ui\companions.js' },
  @{ src = Join-Path $projectRoot 'dist\server.cjs';     dst = Join-Path $installedApp 'dist\server.cjs' }
)

$copied = @()
foreach ($t in $targets) {
  $savedName = [IO.Path]::GetFileName($t.dst)
  Copy-Item -LiteralPath $t.dst -Destination (Join-Path $backup $savedName)   # backup current installed file
  Copy-Item -LiteralPath $t.src -Destination $t.dst -Force                     # install the new one
  $srcHash = (Get-FileHash -LiteralPath $t.src).Hash
  $dstHash = (Get-FileHash -LiteralPath $t.dst).Hash
  if ($srcHash -ne $dstHash) { throw ("hash mismatch after copy: " + $savedName) }
  $copied += [pscustomobject]@{ file = $savedName; bytes = (Get-Item -LiteralPath $t.dst).Length; sha256 = $srcHash.Substring(0, 16) + '…' }
}

# The UI file must serve the fixed content immediately (server may need a restart for server.cjs).
$uiServed = $null
try { $uiServed = (Invoke-WebRequest 'http://127.0.0.1:3939/companions.js' -UseBasicParsing).Content } catch { $uiServed = $null }
$uiHasQueuedMessage = $uiServed -ne $null -and $uiServed.Contains('queuedMessage')
$uiHasSpeakerFix = $uiServed -ne $null -and $uiServed.Contains('_tokensSeen')

$after = $null
try { $after = Invoke-RestMethod 'http://127.0.0.1:3939/api/identity' } catch { $after = $null }
$profilePreserved = ($before -eq $null -and $after -eq $null) -or ($before -ne $null -and $after -ne $null -and $before.profileId -eq $after.profileId)

[pscustomobject]@{
  files       = $copied
  backup      = $backup
  uiServesQueuedMessage = $uiHasQueuedMessage
  uiServesVoiceFix      = $uiHasSpeakerFix
  profilePreserved = $profilePreserved
  note = 'server.cjs applies on next app restart; companions.js is live immediately'
} | ConvertTo-Json -Depth 4 | Tee-Object -FilePath (Join-Path $projectRoot ("output\verification\companions-fixes-installed-" + $stamp + ".json"))
