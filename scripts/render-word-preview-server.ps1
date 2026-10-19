param([Parameter(Mandatory=$true)][string]$OwnerFile)
# Persistent dedicated Word session for preview rendering. Reads one JSON command
# per stdin line ({id,input,output} or "quit") and answers one JSON line per command.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$word=$null
$before=@(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
$ownedWord=$null
$visible=$null;$alerts=$null;$security=$null;$links=$null;$normal=$null
function Write-Owner($id,$started) {
  @{id=[int]$id;started=[string]$started} | ConvertTo-Json -Compress | Set-Content -LiteralPath ($OwnerFile+'.tmp') -Encoding UTF8
  Move-Item -LiteralPath ($OwnerFile+'.tmp') -Destination $OwnerFile -Force
}
try {
  $word=New-Object -ComObject Word.Application
  $visible=$word.Visible;$alerts=$word.DisplayAlerts;$security=$word.AutomationSecurity
  $links=$word.Options.UpdateLinksAtOpen;$normal=$word.Options.SaveNormalPrompt
  $word.Visible=$false
  $word.DisplayAlerts=0
  $word.AutomationSecurity=3
  $word.Options.UpdateLinksAtOpen=$false
  $word.Options.SaveNormalPrompt=$false
  # Ownership is recorded at startup, before any document work: a startup or open
  # crash can never leave an unidentified Word process behind.
  $after=@(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
  $new=@($after | Where-Object { $before -notcontains $_ })
  if($new.Count -eq 1) {
    $p=Get-Process -Id $new[0]
    $ownedWord=$new[0]
    Write-Owner $p.Id $p.StartTime.ToUniversalTime().Ticks.ToString()
  }
  [Console]::Out.WriteLine(([ordered]@{hello=$true;owned=($null -ne $ownedWord);pid=$ownedWord} | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  while($true) {
    $line=[Console]::In.ReadLine()
    if($null -eq $line) { break }
    $line=$line.Trim()
    if($line -eq '') { continue }
    if($line -eq 'quit') { break }
    $command=$line | ConvertFrom-Json
    $response=[ordered]@{id=$command.id;ok=$false}
    $document=$null
    try {
      $document=$word.Documents.Open([ref]$command.input,[ref]$false,[ref]$true,[ref]$false)
      $document.Repaginate()
      # Only pagination fields are refreshed; content fields keep their saved values.
      foreach($story in $document.StoryRanges) {
        $range=$story
        while($null -ne $range) {
          foreach($field in $range.Fields) { if($field.Type -in @(26,33,66)) { $field.Locked=$false; [void]$field.Update() } }
          $range=$range.NextStoryRange
        }
      }
      $document.ExportAsFixedFormat($command.output,17,$false,0)
      # Publish only after synchronous export returns; a partial PDF is never ready.
      [IO.File]::WriteAllText($command.output+'.ready.tmp','exported')
      Move-Item -LiteralPath ($command.output+'.ready.tmp') -Destination ($command.output+'.ready') -Force
      $response.ok=$true
    } catch {
      $response.error='render: '+$_.Exception.Message
      # A dead dedicated Word process is a session failure, not a document problem.
      if($null -ne $ownedWord -and -not (Get-Process -Id $ownedWord -ErrorAction SilentlyContinue)) { $response.fatal=$true }
    } finally {
      try {
        if($null -ne $document) { $document.Close([ref]0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
      } catch { }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  }
} finally {
  try {
    if($null -ne $word) {
      if($null -ne $links){$word.Options.UpdateLinksAtOpen=$links}
      if($null -ne $normal){$word.Options.SaveNormalPrompt=$normal}
      if($null -ne $visible){$word.Visible=$visible}
      if($null -ne $alerts){$word.DisplayAlerts=$alerts}
      if($null -ne $security){$word.AutomationSecurity=$security}
      if($null -ne $ownedWord){$word.Quit([ref]0)}
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
  } catch { }
}
