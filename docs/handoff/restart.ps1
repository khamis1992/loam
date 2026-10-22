$pids=(Get-NetTCPConnection -LocalPort 3939 -State Listen -EA 0).OwningProcess | Select -Unique
foreach($x in $pids){ $pp=(Get-CimInstance Win32_Process -Filter "ProcessId=$x").ParentProcessId; Stop-Process -Id $x -Force -EA 0; Stop-Process -Id $pp -Force -EA 0 }
Start-Sleep 2
Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '/c','npm start > docs\handoff\server.log 2>&1' -WorkingDirectory 'C:\Users\khamis\Desktop\manus-local'
for($i=0;$i -lt 60;$i++){ try{ Invoke-WebRequest http://127.0.0.1:8787/api/health -UseBasicParsing -TimeoutSec 2 | Out-Null; "up after $i"; break }catch{ Start-Sleep 2 } }
