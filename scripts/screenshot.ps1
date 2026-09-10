Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue

$screens = [System.Windows.Forms.Screen]::AllScreens

if ($args[0] -eq "list") {
    for ($i = 0; $i -lt $screens.Length; $i++) {
        $s = $screens[$i]
        Write-Output "$i`t$($s.Bounds.Width)`t$($s.Bounds.Height)`t$($s.Bounds.X)`t$($s.Bounds.Y)"
    }
} else {
    $targetFile = $args[0]
    $idx = 0
    if ($args.Length -gt 1) {
        $idx = [int]$args[1]
    }

    if ($idx -lt 0 -or $idx -ge $screens.Length) {
        Write-Error "Invalid display index: $idx"
        exit 1
    }

    # Attempt high-fidelity capture via Python with desktop session attachment
    try {
        $pyCmd = "import ctypes, pyautogui, sys; user32=ctypes.windll.user32; h=user32.OpenDesktopW('default',0,False,0x10000000); user32.SetThreadDesktop(h) if h else None; pyautogui.screenshot().save(sys.argv[1]); size=pyautogui.size(); print(f'{size[0]}x{size[1]}')"
        $output = & python -c $pyCmd $targetFile 2>$null
        if ($LASTEXITCODE -eq 0 -and (Test-Path $targetFile)) {
            Write-Output $output
            exit 0
        }
    } catch {
        # Fall through to native GDI
    }

    # Fallback to standard GDI CopyFromScreen
    if ($idx -lt 0 -or $idx -ge $screens.Length) {
        $idx = 0
    }
    $s = $screens[$idx]
    $Bounds = $s.Bounds
    $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
    $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
    $Graphics.CopyFromScreen($Bounds.X, $Bounds.Y, 0, 0, $Bounds.Size)
    $Bitmap.Save($targetFile)
    $Graphics.Dispose()
    $Bitmap.Dispose()
    Write-Output "$($Bounds.Width)x$($Bounds.Height)"
}
