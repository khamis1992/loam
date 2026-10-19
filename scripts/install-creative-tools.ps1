$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$installedUi=Join-Path $env:LOCALAPPDATA 'Programs\loam\resources\app\ui'
$before=Invoke-RestMethod 'http://127.0.0.1:3939/api/identity'
$beforeTasks=Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
$backup=Join-Path $projectRoot ('output\verification\creative-tools-backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$addonSource=Join-Path $projectRoot 'node_modules\three\examples\jsm'
$addonTarget=Join-Path (Split-Path -Parent $installedUi) 'node_modules\three\examples\jsm'
foreach($module in (Get-ChildItem -LiteralPath $addonSource -Recurse -File -Filter '*.js')){
 $relative=$module.FullName.Substring($addonSource.Length+1)
 $target=Join-Path $addonTarget $relative
 New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
 Copy-Item -LiteralPath $module.FullName -Destination $target
}
# Copy the new dependency before the entry point; no restart or task interruption.
$creativeFiles=@('creative-color.js','creative-editing.js','creative-keyframes.js','creative-timeline-storage.js','creative-render.html','creative-tools.js','creative-json.js','creative-webm.js','creative-media.js','creative-media.css','creative-timeline-model.js','creative-timeline-engine.js','creative-timeline-services.js','creative-export-jobs.js','creative-timeline-recovery.js','creative-timeline.js','creative-timeline.css','creative.css','creative.js')
foreach($file in $creativeFiles){
 $target=Join-Path $installedUi $file
 if(Test-Path -LiteralPath $target){Copy-Item -LiteralPath $target -Destination (Join-Path $backup $file)}
 Copy-Item -LiteralPath (Join-Path $projectRoot ('ui\'+$file)) -Destination $target
 if((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath (Join-Path $projectRoot ('ui\'+$file))).Hash){throw "File mismatch: $file"}
}
$after=Invoke-RestMethod 'http://127.0.0.1:3939/api/identity'
$afterTasks=Invoke-RestMethod 'http://127.0.0.1:3939/api/tasks'
if($before.profileId -ne $after.profileId){throw 'Profile changed'}
if(@($beforeTasks.tasks.id | Where-Object {$_ -notin @($afterTasks.tasks.id)}).Count){throw 'Task missing'}
@{version=$after.version;profilePreserved=$true;tasks=@($afterTasks.tasks).Count;files=$creativeFiles.Count;backup=$backup} | ConvertTo-Json | Tee-Object -FilePath (Join-Path $projectRoot 'output\verification\creative-tools-installed.json')
