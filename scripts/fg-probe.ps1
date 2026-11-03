# Loam-authored long-lived foreground/cursor probe: reads a line from stdin,
# answers "hwnd,pid,cursorX,cursorY" on stdout, repeats. One process per Loam
# run, killed by its owner. Never writes anywhere else.
Add-Type 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[StructLayout(LayoutKind.Sequential)]public struct P{public int X;public int Y;}[DllImport("user32.dll")]public static extern bool GetCursorPos(out P p);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);}'
while(($l=[Console]::In.ReadLine()) -ne $null){ $p=New-Object M+P; [void][M]::GetCursorPos([ref]$p); $h=[M]::GetForegroundWindow(); $pid2=0; [void][M]::GetWindowThreadProcessId($h,[ref]$pid2); [Console]::Out.WriteLine("$([int64]$h),$pid2,$($p.X),$($p.Y)"); [Console]::Out.Flush() }
