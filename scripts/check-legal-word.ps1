param(
  [Parameter(Mandatory=$true)][string]$InputFile,
  [Parameter(Mandatory=$true)][string]$OutputDir,
  [string]$OldText = '',
  [string]$NewText = ''
)
$ErrorActionPreference = 'Stop'
if ($OldText -eq '') { $OldText = -join [char[]](1610, 1604, 1578, 1586, 1605) }
if ($NewText -eq '') { $NewText = -join [char[]](1610, 1578, 1593, 1610, 1606, 32, 1593, 1604, 1610) }
$word = $null
$document = $null
$ownsWord = $false
$existingWord = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LegalWordProcess { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId); }'
$input = (Resolve-Path -LiteralPath $InputFile).Path
$output = [IO.Path]::GetFullPath($OutputDir)
[IO.Directory]::CreateDirectory($output) | Out-Null
$accepted = Join-Path $output 'accepted.docx'
$rejected = Join-Path $output 'rejected.docx'
Copy-Item -LiteralPath $input -Destination $accepted -Force
Copy-Item -LiteralPath $input -Destination $rejected -Force
function Open-Document([string]$Path) {
  $script:document = $word.Documents.Open([ref]$Path, [ref]$false, [ref]$false, [ref]$false)
  [uint32]$processId = 0
  [void][LegalWordProcess]::GetWindowThreadProcessId([IntPtr]$script:document.ActiveWindow.Hwnd, [ref]$processId)
  if ($processId -gt 0 -and $processId -notin $existingWord) { $script:ownsWord = $true }
}
function Close-Document([bool]$Save) {
  if ($null -ne $script:document) {
    $script:document.Close([ref]($(if ($Save) { -1 } else { 0 })))
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:document)
    $script:document = $null
  }
}
try {
  $word = New-Object -ComObject Word.Application
  $visible = $word.Visible; $alerts = $word.DisplayAlerts; $security = $word.AutomationSecurity
  $word.Visible = $false; $word.DisplayAlerts = 0; $word.AutomationSecurity = 3
  $normal = $word.Options.SaveNormalPrompt; $links = $word.Options.UpdateLinksAtOpen
  $word.Options.SaveNormalPrompt = $false; $word.Options.UpdateLinksAtOpen = $false
  Open-Document $input
  $revisions = $document.Revisions.Count
  if ($revisions -lt 1) { throw 'The input DOCX has no tracked revisions.' }
  Close-Document $false
  Open-Document $accepted
  $document.AcceptAllRevisions()
  $acceptedText = $document.Content.Text
  $acceptedRevisions = $document.Revisions.Count
  Close-Document $true
  Open-Document $rejected
  $document.RejectAllRevisions()
  $rejectedText = $document.Content.Text
  $rejectedRevisions = $document.Revisions.Count
  Close-Document $true
  if ($acceptedRevisions -ne 0 -or $rejectedRevisions -ne 0) { throw 'Tracked revisions remain after Accept All / Reject All.' }
  $acceptedText = $acceptedText.Replace([char]1609, [char]1610)
  $rejectedText = $rejectedText.Replace([char]1609, [char]1610)
  if (-not $acceptedText.Contains($NewText) -or $acceptedText.Contains($OldText)) { throw 'Accept All did not produce the revised Arabic text.' }
  if (-not $rejectedText.Contains($OldText) -or $rejectedText.Contains($NewText)) { throw 'Reject All did not restore the original Arabic text.' }
  [pscustomobject]@{
    ok = $true; revisions = $revisions; acceptedRevisions = $acceptedRevisions; rejectedRevisions = $rejectedRevisions
    accepted = $accepted; rejected = $rejected; oldText = $OldText; newText = $NewText
  } | ConvertTo-Json -Compress
} finally {
  try { Close-Document $false } finally {
    if ($null -ne $word) {
      if ($null -ne $links) { $word.Options.UpdateLinksAtOpen = $links }
      if ($null -ne $normal) { $word.Options.SaveNormalPrompt = $normal }
      if ($null -ne $visible) { $word.Visible = $visible }
      if ($null -ne $alerts) { $word.DisplayAlerts = $alerts }
      if ($null -ne $security) { $word.AutomationSecurity = $security }
      if ($ownsWord) { $word.Quit([ref]0) }
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
  }
}
