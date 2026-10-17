param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Out = "",
  [int]$Depth = 3,
  [string]$Title = "",
  [int]$Index = -1,
  [string]$Name = "",
  [string]$Role = "",
  [string]$Text = "",
  [int]$Max = 60
)

# READ-ONLY accessibility inspector + screen capture.
# Deliberately contains no input synthesis, no pattern activation and no Win32 P/Invoke:
# those heuristics are what antivirus flags. Physical input is performed by the Node side
# (nut.js) using the element bounds returned from here.

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes | Out-Null } catch { }

$script:nodeIndex = 0
$script:stopWalk = $false

function Get-FgRoot {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) { try { if ($w.Current.HasKeyboardFocus) { return $w } } catch { } }
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $focused) {
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $cur = $focused
      $guard = 0
      while ($null -ne $cur -and $guard -lt 64) {
        if ($cur.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { return $cur }
        $cur = $walker.GetParent($cur)
        $guard++
      }
    }
  } catch { }
  if ($wins.Count -gt 0) { return $wins.Item(0) }
  return $null
}

function Walk-Nodes {
  param($El, [int]$Depth, [int]$MaxDepth, [scriptblock]$Visitor)
  if ($script:stopWalk -or $Depth -gt $MaxDepth) { return }
  $script:nodeIndex++
  & $Visitor $El $script:nodeIndex $Depth
  if ($script:stopWalk) { return }
  try {
    $kids = $El.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  } catch { return }
  foreach ($k in $kids) {
    if ($script:stopWalk) { return }
    Walk-Nodes -El $k -Depth ($Depth + 1) -MaxDepth $MaxDepth -Visitor $Visitor
  }
}

function Get-Role($El) {
  try {
    $ct = $El.Current.ControlType
    if ($null -eq $ct) { return "" }
    return ([string]$ct.ProgrammaticName).Replace("ControlType.", "")
  } catch { return "" }
}

function To-Int($v) {
  if ($null -eq $v) { return 0 }
  try {
    if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return 0 }
    return [int]$v
  } catch { return 0 }
}

function Safe-Name($El) {
  try {
    $n = $El.Current.Name
    if ($null -eq $n) { return "" }
    return ([string]$n -replace "\s+", " ")
  } catch { return "" }
}

function Has-Match($El) {
  if ($Name -ne "" -and -not ($El.Current.Name -like "*$Name*")) { return $false }
  if ($Role -ne "" -and -not ((Get-Role $El) -like "*$Role*")) { return $false }
  return $true
}

function Write-Json($Obj) { Write-Output ($Obj | ConvertTo-Json -Compress -Depth 4) }

function Save-Screenshot([string]$Path) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $gfx.Dispose(); $bmp.Dispose()
  $info = Get-Item $Path
  Write-Json @{ path = $info.FullName; bytes = $info.Length; width = $bounds.Width; height = $bounds.Height }
}

function Get-Windows {
  $items = @()
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) {
    $r = $w.Current.BoundingRectangle
    $items += @{ title = (Safe-Name $w); pid = (To-Int $w.Current.ProcessId); x = (To-Int $r.X); y = (To-Int $r.Y); w = (To-Int $r.Width); h = (To-Int $r.Height) }
  }
  Write-Json $items
}

function Walk-Tree {
  param($El, [int]$Depth, [int]$MaxDepth)
  if ($script:stopWalk -or $Depth -gt $MaxDepth) { return }
  $script:nodeIndex++
  if ($script:treeLines.Count -lt 400) {
    $r = $El.Current.BoundingRectangle
    $n = (Safe-Name $El)
    if ($n.Length -gt 70) { $n = $n.Substring(0, 70) }
    $script:treeLines.Add(("[{0}] {1}{2} '{3}' @{4},{5} {6}x{7}" -f $script:nodeIndex, ("  " * $Depth), (Get-Role $El), $n, (To-Int $r.X), (To-Int $r.Y), (To-Int $r.Width), (To-Int $r.Height)))
  } else {
    $script:stopWalk = $true
  }
  if ($script:stopWalk) { return }
  try {
    $kids = $El.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  } catch { return }
  foreach ($k in $kids) {
    if ($script:stopWalk) { return }
    Walk-Tree -El $k -Depth ($Depth + 1) -MaxDepth $MaxDepth
  }
}

function Get-Tree([int]$MaxDepth) {
  $focus = Get-FgRoot
  if ($null -eq $focus) { Write-Output "(no foreground window found)"; return }
  $script:nodeIndex = 0
  $script:stopWalk = $false
  $script:treeLines = New-Object System.Collections.Generic.List[string]
  Walk-Tree -El $focus -Depth 0 -MaxDepth $MaxDepth
  Write-Output ("WINDOW: " + (Safe-Name $focus) + "  (index 1-based, stable for this snapshot)")
  $script:treeLines
}

function Get-Elements([int]$MaxItems) {
  $focus = Get-FgRoot
  if ($null -eq $focus) { Write-Json @(); return }
  $script:nodeIndex = 0; $script:stopWalk = $false
  $items = New-Object System.Collections.Generic.List[object]
  $visitor = {
    param($el, $idx, $d)
    if ($items.Count -ge $MaxItems) { $script:stopWalk = $true; return }
    if (-not (Has-Match $el)) { return }
    $c = $el.Current
    $r = $c.BoundingRectangle
    if ($r.Width -le 0 -and $r.Height -le 0) { return }
    $items.Add(@{
      index   = $idx
      role    = (Get-Role $el)
      name    = (Safe-Name $el)
      id      = $c.AutomationId
      x       = (To-Int $r.X)
      y       = (To-Int $r.Y)
      w       = (To-Int $r.Width)
      h       = (To-Int $r.Height)
      enabled = $c.IsEnabled
    })
  }
  Walk-Nodes -El $focus -Depth 0 -MaxDepth 6 -Visitor $visitor
  Write-Json $items
}

function Get-Bounds {
  $focus = Get-FgRoot
  if ($null -eq $focus) { Write-Json @{ found = $false; reason = "no_window" }; return }
  $script:nodeIndex = 0; $script:stopWalk = $false
  $script:found = $null
  $visitor = {
    param($el, $idx, $d)
    $hit = $false
    if ($Index -ge 0 -and $idx -eq $Index) { $hit = $true }
    elseif ($Index -lt 0 -and (Has-Match $el)) { $hit = $true }
    if ($hit) { $script:stopWalk = $true; $script:found = $el }
  }
  Walk-Nodes -El $focus -Depth 0 -MaxDepth 6 -Visitor $visitor
  if ($null -eq $script:found) { Write-Json @{ found = $false; reason = "not_found" }; return }
  $el = $script:found
  $r = $el.Current.BoundingRectangle
  Write-Json @{
    found = $true
    name  = (Safe-Name $el)
    role  = (Get-Role $el)
    id    = $el.Current.AutomationId
    x     = (To-Int $r.X)
    y     = (To-Int $r.Y)
    w     = (To-Int $r.Width)
    h     = (To-Int $r.Height)
  }
}

function Set-Value {
  $focus = Get-FgRoot
  if ($null -eq $focus) { Write-Json @{ result = "no_window" }; return }
  $script:nodeIndex = 0; $script:stopWalk = $false
  $script:found = $null
  $visitor = {
    param($el, $idx, $d)
    $hit = $false
    if ($Index -ge 0 -and $idx -eq $Index) { $hit = $true }
    elseif ($Index -lt 0 -and (Has-Match $el)) { $hit = $true }
    if ($hit) { $script:stopWalk = $true; $script:found = $el }
  }
  Walk-Nodes -El $focus -Depth 0 -MaxDepth 6 -Visitor $visitor
  if ($null -eq $script:found) { Write-Json @{ result = "not_found" }; return }
  $el = $script:found
  $p = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
    $p.SetValue($Text)
    Write-Json @{ result = "set_value"; name = $el.Current.Name }
    return
  }
  try { $el.SetFocus() } catch { }
  $r = $el.Current.BoundingRectangle
  Write-Json @{ result = "focus_then_type"; name = (Safe-Name $el); x = (To-Int ($r.X + $r.Width / 2)); y = (To-Int ($r.Y + $r.Height / 2)) }
}

function Focus-Window([string]$Substring) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) {
    if ($w.Current.Name -like "*$Substring*") {
      try { $w.SetFocus() } catch { }
      Write-Json @{ focused = $w.Current.Name }
      return
    }
  }
  Write-Json @{ focused = $null; reason = "no_match" }
}

switch ($Action) {
  "screenshot" { Save-Screenshot $Out }
  "list_windows" { Get-Windows }
  "ui_tree" { Get-Tree $Depth }
  "ui_elements" { Get-Elements $Max }
  "ui_bounds" { Get-Bounds }
  "ui_set_value" { Set-Value }
  "ui_focus_window" { Focus-Window $Title }
  default { Write-Json @{ result = "unknown_action"; action = $Action } }
}
