$ErrorActionPreference="Stop"
$base="http://127.0.0.1:4096"
$sf="C:\Users\khamis\Desktop\mf-wt\sessions.json"
$j = Get-Content $sf -Raw | ConvertFrom-Json
# keys already merged or handled - do NOT reseed
$skip = @("mkt","auth","r2","v3","p3","b1","wsp","mf8","mf6","mf3","pd")
$reseed = @("opd","px","opb","opa","mf4","mf9","sk","mf7","mf11","br","ope","mf10","oph","opi","wss","wsv","wsd","wsx","r1","p1","w1","w2","w3","o3","d1","cr1","v2","v4","o2","o4","p2","cr2")
$models = @(
  @{P="opencode-go";M="deepseek-v4.1-flash"},
  @{P="opencode-go";M="glm-5.3-flash"},
  @{P="opencode-go";M="qwen3.8-flash"},
  @{P="opencode";M="minimax-m3.1-flash-free"},
  @{P="opencode";M="longcat-2.5-preview-free"}
)
$addendum = "`n`n--- EXECUTION RULES (added on re-seed) ---`nCommit EARLY and OFTEN with small commits using explicit paths (git add <path>; git commit -m msg -- <path>) so work survives disconnects. Never git push, never -A, never touch do-not-touch files. After each meaningful edit run: npx tsc --noEmit (must stay 0). You are in a dedicated git worktree; commit to the current branch. Keep working until the task is fully complete, then write a short report under docs/handoff/.`n"
$outdir="C:\Users\khamis\Desktop\mf-wt\reprompts"
New-Item -ItemType Directory -Force -Path $outdir | Out-Null
$i=0; $log=@()
foreach ($k in $reseed) {
  if (-not $j.$k) { $log += "$k : NO SESSION ENTRY - skipped"; continue }
  $old = $j.$k[0]; $dir = $j.$k[1]
  $qd = [uri]::EscapeDataString($dir)
  # fetch original first user message
  $prompt = $null
  try {
    $msgs = Invoke-RestMethod "$base/session/$old/message?directory=$qd" -TimeoutSec 25
    $um = $msgs | Where-Object { $_.info.role -eq "user" } | Select-Object -First 1
    if ($um) { $prompt = ($um.parts | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text }) -join "`n" }
  } catch { }
  if ([string]::IsNullOrWhiteSpace($prompt)) { $log += "$k : could not fetch original prompt - SKIPPED (needs manual)"; continue }
  $full = $prompt + $addendum
  $pf = Join-Path $outdir "$k.txt"
  [IO.File]::WriteAllText($pf, $full, [Text.Encoding]::UTF8)
  $mdl = $models[$i % $models.Count]; $i++
  try {
    $sess = Invoke-RestMethod -Method Post "$base/session?directory=$qd" -ContentType 'application/json' -Body (@{title="$k-reseed"}|ConvertTo-Json)
    $body = @{model=@{providerID=$mdl.P;modelID=$mdl.M};parts=@(@{type='text';text=$full})}|ConvertTo-Json -Depth 6
    Invoke-RestMethod -Method Post "$base/session/$($sess.id)/prompt_async?directory=$qd" -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
    $j.$k[0] = $sess.id
    $log += "$k : RESEEDED $($sess.id) [$($mdl.P)/$($mdl.M)]"
  } catch {
    $log += "$k : FIRE FAILED - $($_.Exception.Message)"
  }
  Start-Sleep -Milliseconds 400
}
$j | ConvertTo-Json -Depth 6 | Set-Content $sf -Encoding UTF8
$log | ForEach-Object { $_ }
