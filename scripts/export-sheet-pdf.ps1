param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
$app=$null;$book=$null;$owns=$false
$existing=@(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
try {
 $app=New-Object -ComObject Excel.Application
 $app.Visible=$false
 if($app.ProcessId -gt 0 -and $app.ProcessId -notin $existing){$owns=$true;$owned=Get-Process -Id $app.ProcessId;@{id=$owned.Id;started=$owned.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json | Set-Content -LiteralPath ($OutputFile+'.owner.json')}
 $alerts=$app.DisplayAlerts
 $app.DisplayAlerts=1
 # Open(path, UpdateLinks=0, ReadOnly=true)
 $book=$app.Workbooks.Open($InputFile,0,$true)
 if($book.Sheets.Count -lt 1){throw 'The workbook has no sheets'}
 # xlTypePDF = 0; Quality := xlQualityStandard (0). Open-after-export stays false.
 $book.ExportAsFixedFormat(0,$OutputFile,0,$false)
 # Export completion is separate from COM teardown; only owned processes can
 # be interrupted during teardown without affecting another Excel session.
 if($owns){[IO.File]::WriteAllText($OutputFile+'.ready.tmp','exported');Move-Item -LiteralPath ($OutputFile+'.ready.tmp') -Destination ($OutputFile+'.ready')}
} finally {
 try {if($null -ne $book){$book.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book)}} finally {
 if($null -ne $app){if($null -ne $alerts){$app.DisplayAlerts=$alerts};if($owns){$app.Quit()};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)}
 }
}
