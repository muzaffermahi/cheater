# Kitten native launcher. The legacy web command remains explicit (`kitten web`) but is never used here.
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
    $env:KITTEN_DESKTOP_EXE,
    (Join-Path $scriptDir "desktop\bin\Kitten.Desktop.exe"),
    (Join-Path $scriptDir "desktop\dist\Kitten.Desktop.exe"),
    (Join-Path $env:LOCALAPPDATA "Kitten\Kitten.Desktop.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
if (-not $candidates) {
    throw "Kitten native desktop app is not installed. Install the desktop package first."
}
Start-Process -FilePath $candidates[0] -WorkingDirectory (Split-Path -Parent $candidates[0]) -WindowStyle Normal
