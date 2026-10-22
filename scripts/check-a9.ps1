$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$port = 19421
$base = "http://127.0.0.1:$port"

# Build a fresh server bundle.
Write-Host "[a9] building server..."
& npm --prefix $repoRoot run build:server | Out-Null
if ($LASTEXITCODE -ne 0) { throw "build:server failed" }

# Fresh install root / user-data root so we can verify LOAM_ROOT.
$testRoot = Join-Path $env:TEMP "loam-a9-test-$(Get-Random)"
$loamRoot = Join-Path $testRoot "loam-root"
$tokenDir = Join-Path $testRoot "auth"
$expectedWorkspace = Join-Path $loamRoot "workspace"
New-Item -ItemType Directory -Path $expectedWorkspace -Force | Out-Null
New-Item -ItemType Directory -Path $tokenDir -Force | Out-Null

# Generate the per-install token the Electron main process would create.
$token = -join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Maximum 256) })
Set-Content -Path (Join-Path $tokenDir ".loam-local-auth-token") -Value $token -NoNewline -Force

# Use a config that points Ollama and the cloud provider at dead ports so the
# /api/models handler is forced down the graceful-empty-list path.
$wrongWorkspace = Join-Path $testRoot "wrong-workspace"
New-Item -ItemType Directory -Path $wrongWorkspace -Force | Out-Null
$configPath = Join-Path $testRoot "config.json"
@'
{
  "model": "glm-5.3-flash:cloud",
  "fallbackModel": "qwen2.5:14b",
  "ollamaUrl": "http://127.0.0.1:19999",
  "cloudModel": { "baseUrl": "http://127.0.0.1:19998", "apiKey": "" },
  "workspace": "WRONG_WORKSPACE"
}
'@.Replace("WRONG_WORKSPACE", $wrongWorkspace.Replace("\", "\\")) | Set-Content -Path $configPath -Force

$env:LOAM_PORT = $port
$env:LOAM_ROOT = $loamRoot
$env:LOAM_CONFIG = $configPath
$env:LOAM_LOCAL_TOKEN_DIR = $tokenDir

Write-Host "[a9] starting server on port $port ..."
$proc = Start-Process -FilePath node -ArgumentList "dist/server.cjs" -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru

function Stop-TestServer {
  if ($proc -and !$proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}

try {
  # Wait for /api/health (public).
  $health = $null
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $health = Invoke-WebRequest -Uri "$base/api/health" -UseBasicParsing -TimeoutSec 1
      if ($health.StatusCode -eq 200) { break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if ($health -eq $null -or $health.StatusCode -ne 200) { throw "/api/health did not return 200" }
  Write-Host "[a9] /api/health OK"

  # /api/config without token must be 401.
  try {
    Invoke-WebRequest -Uri "$base/api/config" -UseBasicParsing -TimeoutSec 5 | Out-Null
    throw "expected 401 for unauthenticated /api/config"
  } catch [System.Net.WebException] {
    if ($_.Exception.Response.StatusCode -ne 401) {
      throw "expected 401, got $($_.Exception.Response.StatusCode)"
    }
  }
  Write-Host "[a9] unauthenticated request returns 401 OK"

  $headers = @{ "x-loam-local-token" = $token }

  # LOAM_ROOT must override config.workspace.
  $config = Invoke-WebRequest -Uri "$base/api/config" -Headers $headers -UseBasicParsing -TimeoutSec 5 | ConvertFrom-Json
  $actualWorkspace = $config.workspace | Resolve-Path | Select-Object -ExpandProperty Path
  $expectedWorkspaceResolved = $expectedWorkspace | Resolve-Path | Select-Object -ExpandProperty Path
  if ($actualWorkspace -ne $expectedWorkspaceResolved) {
    throw "workspace mismatch: expected $expectedWorkspaceResolved, got $actualWorkspace"
  }
  Write-Host "[a9] LOAM_ROOT workspace override OK"

  # /api/models returns 200 empty when Ollama is unavailable.
  $models = Invoke-WebRequest -Uri "$base/api/models" -Headers $headers -UseBasicParsing -TimeoutSec 10 | ConvertFrom-Json
  if ($models.models -eq $null -or $models.models.Count -ne 0) {
    throw "expected empty models list, got $($models | ConvertTo-Json)"
  }
  Write-Host "[a9] /api/models empty OK"

  # /api/chat with no cloud key must fail with a clear configuration message.
  $chatHeaders = $headers.Clone()
  $chatHeaders["content-type"] = "application/json"
  $chat = Invoke-WebRequest -Uri "$base/api/chat" -Method POST -Headers $chatHeaders `
    -Body '{"prompt":"hi"}' -UseBasicParsing -TimeoutSec 15
  if ($chat.Content -notmatch "API key") {
    throw "chat error did not mention API key: $($chat.Content)"
  }
  Write-Host "[a9] /api/chat clear API-key error OK"

  Write-Host "[a9] all checks passed"
} finally {
  Stop-TestServer
}
