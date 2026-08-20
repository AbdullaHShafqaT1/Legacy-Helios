Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Signature = @"
using System;
using System.Runtime.InteropServices;

public class User32 {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
Add-Type -TypeDefinition $Signature -ErrorAction SilentlyContinue

$action = $args[0]

if ($action -eq "move" -or $action -eq "click" -or $action -eq "doubleclick" -or $action -eq "rightclick") {
    $x = [int]$args[1]
    $y = [int]$args[2]
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
    
    if ($action -eq "click") {
        [User32]::mouse_event(0x02, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 50
        [User32]::mouse_event(0x04, 0, 0, 0, 0)
    }
    elseif ($action -eq "doubleclick") {
        [User32]::mouse_event(0x02, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 50
        [User32]::mouse_event(0x04, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 100
        [User32]::mouse_event(0x02, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 50
        [User32]::mouse_event(0x04, 0, 0, 0, 0)
    }
    elseif ($action -eq "rightclick") {
        [User32]::mouse_event(0x08, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 50
        [User32]::mouse_event(0x10, 0, 0, 0, 0)
    }
}
elseif ($action -eq "scroll") {
    $amount = [int]$args[1]
    [User32]::mouse_event(0x0800, 0, 0, $amount, 0)
}
elseif ($action -eq "type") {
    $text = $args[1]
    [System.Windows.Forms.SendKeys]::SendWait($text)
}
elseif ($action -eq "press" -or $action -eq "hotkey") {
    $keys = $args[1]
    [System.Windows.Forms.SendKeys]::SendWait($keys)
}
else {
    Write-Error "Invalid desktop action: $action"
    exit 1
}
