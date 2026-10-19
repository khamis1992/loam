param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile,[int]$SlideNumber=1)
$ErrorActionPreference='Stop'
$app=$null;$deck=$null;$owns=$false
$existing=@(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LoamPowerPointProcess { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId); }'
try {
 $app=New-Object -ComObject PowerPoint.Application
 [uint32]$previewProcessId=0
 [void][LoamPowerPointProcess]::GetWindowThreadProcessId([IntPtr]$app.HWND,[ref]$previewProcessId)
 if($previewProcessId -gt 0 -and $previewProcessId -notin $existing){$owns=$true;$owned=Get-Process -Id $previewProcessId;@{id=$owned.Id;started=$owned.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json | Set-Content -LiteralPath ($OutputFile+'.owner.json')}
 $security=$app.AutomationSecurity;$alerts=$app.DisplayAlerts
 $app.AutomationSecurity=3;$app.DisplayAlerts=1
 $deck=$app.Presentations.Open($InputFile,$true,$false,$false)
 if($SlideNumber -lt 1 -or $SlideNumber -gt $deck.Slides.Count){throw 'Invalid slide number'}
 $width=1600;$height=[int][Math]::Round($width*$deck.PageSetup.SlideHeight/$deck.PageSetup.SlideWidth)
 if($height -lt 1 -or $height -gt 8000){throw 'Unsupported slide aspect ratio'}
 $deck.Slides.Item($SlideNumber).Export($OutputFile,'PNG',$width,$height)
 # Export completion is separate from COM teardown; only owned processes can
 # be interrupted during teardown without affecting another PowerPoint session.
 if($owns){[IO.File]::WriteAllText($OutputFile+'.ready.tmp','exported');Move-Item -LiteralPath ($OutputFile+'.ready.tmp') -Destination ($OutputFile+'.ready')}
} finally {
 try {if($null -ne $deck){$deck.Close();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)}} finally {
 if($null -ne $app){if($null -ne $security){$app.AutomationSecurity=$security};if($null -ne $alerts){$app.DisplayAlerts=$alerts};if($owns){$app.Quit()};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)}
 }
}
