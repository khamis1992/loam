$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$installedRoot=Join-Path $env:LOCALAPPDATA 'Programs\loam\resources\app'
$before=Invoke-RestMethod 'http://127.0.0.1:3939/api/identity'
$beforeTasks=Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
$backup=Join-Path $projectRoot ('output\verification\before-lemon-rollback-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach($file in @('ui\icons.css','ui\theme.js','ui\app.js')){
 $p=Join-Path $installedRoot $file
 $saved=Join-Path $backup $file
 New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
 Copy-Item -LiteralPath $p -Destination $saved
 $s=[IO.File]::ReadAllText($p)
 if($file -eq 'ui\icons.css'){$s=[regex]::Replace($s,'/\* Lemon daylight identity\.[\s\S]*?\.loam-shell \.hero-glow\{opacity:\.12\}\r?\n?','')}
 if($file -eq 'ui\theme.js'){
  $s=$s.Replace('return t === "dark" ? "dark" : "light";','return "dark";').Replace('var theme = "light";','var theme = "dark";').Replace('localStorage.getItem("manus-theme") || "light"','localStorage.getItem("manus-theme") || "dark"')
  $s=[regex]::Replace($s,'  function applyPagePalette\(\) \{[\s\S]*?window.addEventListener\("hashchange", applyPagePalette\);\r?\n','')
 }
 if($file -eq 'ui\app.js'){$s=$s.Replace('if(view===''chat'' && state.task?.mode)document.documentElement.dataset.palette=state.task.mode===''media''?''creative'':state.task.mode; ','')}
 [IO.File]::WriteAllText($p,$s,[Text.UTF8Encoding]::new($false))
}
$assets=@('ui\assets\loam-symbol.svg','electron\assets\loam.ico','electron\assets\loam.png')
$assets+=@(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'ui\assets\icons') -Filter '*.svg' | ForEach-Object {'ui\assets\icons\'+$_.Name})
foreach($file in $assets){Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination (Join-Path $installedRoot $file)}
Invoke-RestMethod 'http://127.0.0.1:3939/api/settings' -Method Post -ContentType 'application/json' -Body '{"theme":"dark"}' | Out-Null
$after=Invoke-RestMethod 'http://127.0.0.1:3939/api/identity'
$afterTasks=Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
if($before.profileId -ne $after.profileId){throw 'Profile changed'}
if(@($beforeTasks.tasks.id | Where-Object {$_ -notin @($afterTasks.tasks.id)}).Count){throw 'Task missing'}
$css=(Invoke-WebRequest 'http://127.0.0.1:3939/icons.css' -UseBasicParsing).Content
if($css -match 'Lemon daylight|--mode-ink|#fbfce9'){throw 'Lemon palette still served'}
@{version=$after.version;theme=(Invoke-RestMethod 'http://127.0.0.1:3939/api/settings').theme;profilePreserved=$true;tasks=@($afterTasks.tasks).Count;lemonRemoved=$true} | ConvertTo-Json | Tee-Object -FilePath (Join-Path $projectRoot 'output\verification\lemon-rollback.json')
