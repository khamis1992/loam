Add-Type 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);}' -EA 0
Get-Process | ?{$_.MainWindowTitle -eq 'Loam'} | %{ [W]::ShowWindow($_.MainWindowHandle,9) | Out-Null }
