param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
$word=$null
$document=$null
$ownsWord=$false
$existingWord=@(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LoamWordProcess { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId); }'
try {
  $word=New-Object -ComObject Word.Application
  $visible=$word.Visible;$alerts=$word.DisplayAlerts;$security=$word.AutomationSecurity
  $word.Visible=$false
  $word.DisplayAlerts=0
  $word.AutomationSecurity=3
  $links=$word.Options.UpdateLinksAtOpen
  $normal=$word.Options.SaveNormalPrompt
  $word.Options.UpdateLinksAtOpen=$false
  $word.Options.SaveNormalPrompt=$false
  $document=$word.Documents.Open([ref]$InputFile,[ref]$false,[ref]$true,[ref]$false)
  [uint32]$wordProcessId=0
  [void][LoamWordProcess]::GetWindowThreadProcessId([IntPtr]$document.ActiveWindow.Hwnd,[ref]$wordProcessId)
  $ownsWord=$wordProcessId -gt 0 -and $wordProcessId -notin $existingWord
  if($ownsWord) {
    $owned=Get-Process -Id $wordProcessId
    @{id=$owned.Id;started=$owned.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json | Set-Content -LiteralPath ($OutputFile+'.owner.json')
  }
  $document.Repaginate()
  # Only pagination fields are refreshed; content fields keep their saved values.
  foreach($story in $document.StoryRanges) {
    $range=$story
    while($null -ne $range) {
      foreach($field in $range.Fields) { if($field.Type -in @(26,33,66)) { $field.Locked=$false; [void]$field.Update() } }
      $range=$range.NextStoryRange
    }
  }
  $document.ExportAsFixedFormat($OutputFile,17,$false,0)
  # Publish only after synchronous export returns; a partial PDF is never ready.
  # Only dedicated processes can be interrupted during cleanup. A reused
  # session must finish restoring its settings before the caller proceeds.
  if($ownsWord) {
    [IO.File]::WriteAllText($OutputFile+'.ready.tmp','exported')
    Move-Item -LiteralPath ($OutputFile+'.ready.tmp') -Destination ($OutputFile+'.ready')
  }
} finally {
  try {
    if($null -ne $document) { $document.Close([ref]0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
  } finally {
    if($null -ne $word) {
      if($null -ne $links){$word.Options.UpdateLinksAtOpen=$links}
      if($null -ne $normal){$word.Options.SaveNormalPrompt=$normal}
      if($null -ne $visible){$word.Visible=$visible}
      if($null -ne $alerts){$word.DisplayAlerts=$alerts}
      if($null -ne $security){$word.AutomationSecurity=$security}
      if($ownsWord){$word.Quit([ref]0)}
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
  }
}
