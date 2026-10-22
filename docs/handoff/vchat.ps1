param([string]$Agent='agent_mvgzt9ls9fc75b',[string]$Msg,[int]$Wait=60,[string]$Shot)
.\show.ps1
node cdp.mjs reload --to "app://agent/app/agents?agent=$Agent" --wait 6000 | Out-Null
node cdpf.mjs helpers.js | Out-Null
$Msg | Out-File -Encoding utf8 _m.txt
"window.__send(" + (ConvertTo-Json ([IO.File]::ReadAllText("$PWD\_m.txt").Trim())) + ")" | Out-File -Encoding utf8 _m.js
node cdpf.mjs _m.js
Start-Sleep $Wait
node cdp.mjs eval --js "document.body.innerText.split('Open in task view')[1].slice(-900)"
if($Shot){ node cdp.mjs shot --out $Shot }

