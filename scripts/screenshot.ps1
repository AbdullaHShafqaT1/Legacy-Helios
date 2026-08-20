Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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
    $s = $screens[$idx]
    $Bounds = $s.Bounds
    $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
    $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
    $Graphics.CopyFromScreen($Bounds.X, $Bounds.Y, 0, 0, $Bounds.Size)
    $Bitmap.Save($targetFile)
    $Graphics.Dispose()
    $Bitmap.Dispose()
}
