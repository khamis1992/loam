param([string]$PromptFile,[string]$Title,[string]$Dir,[string]$Provider,[string]$Model)
$base='http://127.0.0.1:4096'; $q="?directory="+[uri]::EscapeDataString($Dir)
$s=Invoke-RestMethod -Method Post "$base/session$q" -ContentType 'application/json' -Body (@{title=$Title}|ConvertTo-Json)
$text=[string][IO.File]::ReadAllText((Resolve-Path $PromptFile))
$body=@{model=@{providerID=$Provider;modelID=$Model};parts=@(@{type='text';text=$text})}|ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post "$base/session/$($s.id)/prompt_async$q" -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
"$Title $($s.id) $Dir"
