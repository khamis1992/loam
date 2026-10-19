# opencode-agents.ps1 : status / nudge for the 10 manus-parity OpenCode sessions
# Usage:  .\opencode-agents.ps1 status
#         .\opencode-agents.ps1 nudge            (nudges idle, unfinished sessions)
#         .\opencode-agents.ps1 nudge -Agent a03 (nudge one session)
param([ValidateSet('status','nudge')][string]$Action='status',[string]$Agent='')
$ErrorActionPreference='Stop'
$stateFile = Join-Path $PSScriptRoot 'agents-state.json'
$state = Get-Content $stateFile -Raw | ConvertFrom-Json
$base = $state.serverUrl
$nudgeText = 'Continue until your task is fully complete per acceptance criteria'
try { $statusMap = Invoke-RestMethod "$base/session/status" -TimeoutSec 10 } catch { $statusMap = $null }
$rows = foreach ($a in $state.agents) {
  if ($Agent -and $a.id -ne $Agent) { continue }
  $q = "?directory=" + [uri]::EscapeDataString($a.worktree)
  $busy = $false
  if ($statusMap -and $statusMap.PSObject.Properties[$a.sessionId]) { $busy = $statusMap.($a.sessionId).type -ne 'idle' }
  $msgs = @(); try { $msgs = @(Invoke-RestMethod "$base/session/$($a.sessionId)/message$q" -TimeoutSec 15) } catch {}
  $last = $msgs | Select-Object -Last 1
  $lastT = if ($last -and $last.info.time.created) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$last.info.time.created).ToLocalTime().ToString('HH:mm:ss') } else { '-' }
  $report = Test-Path (Join-Path $a.worktree "docs\handoff\$($a.id)-report.md")
  $commits = (git -C $a.worktree rev-list --count "manus-parity..HEAD" 2>$null)
  [pscustomobject]@{ agent=$a.id; session=$a.sessionId; busy=$busy; messages=$msgs.Count; lastActivity=$lastT; commits=$commits; reportDone=$report }
}
$rows | Format-Table -AutoSize
if ($Action -eq 'nudge') {
  foreach ($r in $rows) {
    if (-not $r.busy -and -not $r.reportDone) {
      $a = $state.agents | Where-Object id -eq $r.agent
      $q = "?directory=" + [uri]::EscapeDataString($a.worktree)
      $body = @{ parts = @(@{ type='text'; text=$nudgeText }) } | ConvertTo-Json -Depth 5
      Invoke-RestMethod -Method Post "$base/session/$($a.sessionId)/prompt_async$q" -ContentType 'application/json' -Body $body | Out-Null
      "nudged $($r.agent)"
    }
  }
}
