param(
    [switch]$AddToPath
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Cheater launcher folder: $scriptDir"
Write-Host ""
Write-Host "Preferred install:"
Write-Host "  pip install -e ."
Write-Host "  cd cheater-pi; npm install; npm run build; npm link"
Write-Host ""

if (-not $AddToPath) {
    Write-Host "To use 'cheater' from any PowerShell window, add this folder to your user PATH:"
    Write-Host "  $scriptDir"
    Write-Host ""
    Write-Host "Or let this script add it safely for the current user:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\install_local.ps1 -AddToPath"
    exit 0
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ })
$alreadyPresent = $entries | Where-Object {
    [string]::Equals($_.TrimEnd("\"), $scriptDir.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)
}

if ($alreadyPresent) {
    Write-Host "This folder is already present in your user PATH."
    exit 0
}

$newPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
    $scriptDir
} else {
    $userPath.TrimEnd(";") + ";" + $scriptDir
}

[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
Write-Host "Added to user PATH: $scriptDir"
Write-Host "Open a new PowerShell window, then run:"
Write-Host "  cheater"
