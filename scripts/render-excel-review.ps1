param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
$app=$null;$book=$null;$owns=$false
$existing=@(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LoamExcelReviewProcess { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId); }'
try {
 $app=New-Object -ComObject Excel.Application
 [uint32]$reviewProcessId=0
 [void][LoamExcelReviewProcess]::GetWindowThreadProcessId([IntPtr]$app.Hwnd,[ref]$reviewProcessId)
 $owns=$reviewProcessId -gt 0 -and $reviewProcessId -notin $existing
 $security=$app.AutomationSecurity;$alerts=$app.DisplayAlerts;$events=$app.EnableEvents;$links=$app.AskToUpdateLinks
 $app.AutomationSecurity=3;$app.DisplayAlerts=$false;$app.EnableEvents=$false;$app.AskToUpdateLinks=$false
 $book=$app.Workbooks.Open($InputFile,0,$true)
 $book.ExportAsFixedFormat(0,$OutputFile)
} finally {
 try {if($null -ne $book){$book.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book)}} finally {
  if($null -ne $app){if($null -ne $security){$app.AutomationSecurity=$security};if($null -ne $alerts){$app.DisplayAlerts=$alerts};if($null -ne $events){$app.EnableEvents=$events};if($null -ne $links){$app.AskToUpdateLinks=$links};if($owns){$app.Quit()};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)}
 }
}
