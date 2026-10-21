param([string]$PromptFile,[string]$Title,[string]$Session='')
$base='http://127.0.0.1:4096'; $dir='C:\Users\khamis\Desktop\manus-local'; $q="?directory="+[uri]::EscapeDataString($dir)
if(-not $Session){ $s=Invoke-RestMethod -Method Post "$base/session$q" -ContentType 'application/json' -Body (@{title=$Title}|ConvertTo-Json); $Session=$s.id }
$text=[string][IO.File]::ReadAllText((Resolve-Path $PromptFile))
$body=@{model=@{providerID=$env:OC_PROVIDER;modelID=$env:OC_MODEL};parts=@(@{type='text';text=$text})}|ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post "$base/session/$Session/prompt_async$q" -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
Start-Sleep 20
for($i=0;$i -lt 75;$i++){ $st=Invoke-RestMethod "$base/session/status$q"; if(-not $st.PSObject.Properties[$Session] -or $st.$Session.type -eq 'idle'){break}; Start-Sleep 10 }
$m=(Invoke-WebRequest "$base/session/$Session/message$q" -UseBasicParsing).Content|ConvertFrom-Json; $l=$m[$m.Count-1]
"SESSION=$Session idleAfter=$i err=$($l.info.error.name) $($l.info.error.data.message)"
(($l.parts|?{$_.type -eq 'text'}|%{$_.text}) -join "`n")





