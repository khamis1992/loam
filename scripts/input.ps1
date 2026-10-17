param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Text = "",
  [string]$Keys = ""
)

# Minimal input helper: clipboard + SendKeys only (no Win32 P/Invoke, no mouse control).
# Kept separate from win-ui.ps1 so antivirus heuristics do not flag the accessibility script.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms | Out-Null

switch ($Action) {
  "type" {
    Set-Clipboard -Value $Text
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Write-Output ("typed {0} chars via clipboard" -f $Text.Length)
  }
  "key" {
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Write-Output ("key " + $Keys)
  }
  default { Write-Output ("unknown action: " + $Action) }
}
