param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
$app=$null;$deck=$null;$owns=$false
$existing=@(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LoamDeckPdfProcess { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId); }'
try {
 $app=New-Object -ComObject PowerPoint.Application
 [uint32]$pdfProcessId=0
 [void][LoamDeckPdfProcess]::GetWindowThreadProcessId([IntPtr]$app.HWND,[ref]$pdfProcessId)
 if($pdfProcessId -gt 0 -and $pdfProcessId -notin $existing){$owns=$true;$owned=Get-Process -Id $pdfProcessId;@{id=$owned.Id;started=$owned.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json | Set-Content -LiteralPath ($OutputFile+'.owner.json')}
 $security=$app.AutomationSecurity;$alerts=$app.DisplayAlerts
 $app.AutomationSecurity=3;$app.DisplayAlerts=1
 $deck=$app.Presentations.Open($InputFile,$true,$false,$false)
 if($deck.Slides.Count -lt 1){throw 'The presentation has no slides'}
 # Export(...) with the "PDF" format writes the whole deck; ppSaveAsPDF SaveAs would rename the file.
 $deck.Export($OutputFile,'PDF')
 # Export completion is separate from COM teardown; only owned processes can
 # be interrupted during teardown without affecting another PowerPoint session.
 if($owns){[IO.File]::WriteAllText($OutputFile+'.ready.tmp','exported');Move-Item -LiteralPath ($OutputFile+'.ready.tmp') -Destination ($OutputFile+'.ready')}
} finally {
 try {if($null -ne $deck){$deck.Close();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)}} finally {
 if($null -ne $app){if($null -ne $security){$app.AutomationSecurity=$security};if($null -ne $alerts){$app.DisplayAlerts=$alerts};if($owns){$app.Quit()};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)}
 }
}
