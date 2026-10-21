param([string]$Agent='agent_mvgzt9ls9fc75b',[string]$Tab='Overview',[string]$Shot,[string]$Grep='')
.\show.ps1
node cdp.mjs reload --to "app://agent/app/agents?agent=$Agent" --wait 6000 | Out-Null
node cdpf.mjs helpers.js | Out-Null
node cdp.mjs eval --js "(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.innerText.includes(document.querySelector('textarea').placeholder.replace('Message ','')));b[b.length-1].click();return 1})()" | Out-Null
Start-Sleep 2
node cdp.mjs eval --js "__click('$Tab')" | Out-Null
Start-Sleep 3
if($Grep){ node cdp.mjs eval --js "document.body.innerText.split('$Grep')[1]?.slice(0,600)" }
node cdp.mjs shot --out $Shot

