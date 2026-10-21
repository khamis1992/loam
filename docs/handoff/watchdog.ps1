$ErrorActionPreference="Continue"
$base="http://127.0.0.1:4096"
$sf="C:\Users\khamis\Desktop\mf-wt\sessions.json"
$branch="manus-parity"
$reprompt="C:\Users\khamis\Desktop\mf-wt\reprompts"
$logf="C:\Users\khamis\Desktop\mf-wt\watchdog.log"
$statef="C:\Users\khamis\Desktop\mf-wt\wd-state.json"
$keys=@("opd","px","opb","opa","mf4","mf9","sk","mf7","mf11","br","ope","mf10","oph","opi","wss","wsv","wsd","wsx","r1","p1","w1","w2","w3","o3","d1","cr1","v2","v4","o2","o4","p2","cr2","auth")
# full rotation (off-peak) vs peak (no deepseek - double cost 04-07 & 09-13 local)
$allModels=@(
 @{P="ollama";M="glm-5.3:cloud"},
 @{P="ollama";M="glm-5.3-flash:cloud"},
 @{P="opencode-go";M="deepseek-v4.1-flash"},
 @{P="opencode-go";M="glm-5.3-flash"},
 @{P="opencode-go";M="qwen3.8-flash"},
 @{P="opencode";M="minimax-m3.1-flash-free"},
 @{P="opencode";M="longcat-2.5-preview-free"}
)
$peakModels=@(
 @{P="ollama";M="glm-5.3:cloud"},
 @{P="ollama";M="glm-5.3-flash:cloud"},
 @{P="opencode-go";M="glm-5.3-flash"},
 @{P="opencode-go";M="qwen3.8-flash"},
 @{P="opencode";M="minimax-m3.1-flash-free"},
 @{P="opencode";M="longcat-2.5-preview-free"}
)
function CurModels(){ $h=(Get-Date).Hour; if(($h -ge 4 -and $h -lt 7) -or ($h -ge 9 -and $h -lt 13)){return $peakModels} else {return $allModels} }
if (Test-Path $statef) { $st=Get-Content $statef -Raw | ConvertFrom-Json } else { $st=[pscustomobject]@{} }
function GetState($k){ if($st.PSObject.Properties.Name -contains $k){return $st.$k} else {$v=[pscustomobject]@{idx=0;stall=0;sig=""}; $st|Add-Member -NotePropertyName $k -NotePropertyValue $v -Force; return $v} }
$maxCycles=180
for($c=1;$c -le $maxCycles;$c++){
 $j=Get-Content $sf -Raw | ConvertFrom-Json
 $models=CurModels
 Add-Content $logf "`n=== cycle $c @ $(Get-Date -Format 'HH:mm:ss') (models=$($models.Count)) ==="
 foreach($k in $keys){
  if(-not $j.$k){continue}
  $sid=$j.$k[0]; $dir=$j.$k[1]; $qd=[uri]::EscapeDataString($dir)
  $commits=0;$dirty=0
  try{ $commits=[int](git -C $dir rev-list --count "$branch..HEAD" 2>$null) }catch{}
  try{ $dirty=((git -C $dir status --porcelain 2>$null)|Measure-Object -Line).Lines }catch{}
  $mc=0;$lastrole="";$err=$false
  try{
    $m=Invoke-RestMethod "$base/session/$sid/message?directory=$qd" -TimeoutSec 20
    $mc=$m.Count; $last=$m|Select-Object -Last 1; $lastrole=$last.info.role
    if($last.info.error -or ($last.parts|Where-Object{$_.type -eq 'error'})){$err=$true}
  }catch{ $err=$true }
  $sig="$commits|$dirty|$mc"
  $s=GetState $k
  if($s.sig -eq $sig){ $s.stall=$s.stall+1 } else { $s.stall=0; $s.sig=$sig }
  $action="ok"
  if($err -or ($s.stall -ge 2 -and $commits -eq 0 -and $dirty -eq 0)){
    $pf=Join-Path $reprompt "$k.txt"
    if(Test-Path $pf){
      $s.idx=($s.idx+1)%$models.Count; $mdl=$models[$s.idx]
      $txt=[IO.File]::ReadAllText($pf)
      try{
        $ns=Invoke-RestMethod -Method Post "$base/session?directory=$qd" -ContentType 'application/json' -Body (@{title="$k-wd$c"}|ConvertTo-Json)
        $body=@{model=@{providerID=$mdl.P;modelID=$mdl.M};parts=@(@{type='text';text=$txt})}|ConvertTo-Json -Depth 6
        Invoke-RestMethod -Method Post "$base/session/$($ns.id)/prompt_async?directory=$qd" -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
        $j.$k[0]=$ns.id; $s.sig=""; $s.stall=0
        $action="REFIRED->$($mdl.P)/$($mdl.M) $($ns.id)"
      }catch{ $action="REFIRE-FAILED $($_.Exception.Message)" }
    } else { $action="stuck-no-prompt-file" }
  }
  Add-Content $logf ("{0,-6} commits={1} dirty={2} msgs={3} role={4} err={5} stall={6} -> {7}" -f $k,$commits,$dirty,$mc,$lastrole,$err,$s.stall,$action)
 }
 $j|ConvertTo-Json -Depth 6 | Set-Content $sf -Encoding UTF8
 $st|ConvertTo-Json -Depth 6 | Set-Content $statef -Encoding UTF8
 Start-Sleep -Seconds 240
}
Add-Content $logf "`n=== watchdog finished after $maxCycles cycles ==="



