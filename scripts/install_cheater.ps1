param(
    [switch]$AddToPath
)

$scriptFolder = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectFolder = Split-Path -Parent $scriptFolder

Write-Host "Cheater project folder: $projectFolder"
Write-Host ""
$existing = Get-Command cheater -ErrorAction SilentlyContinue
if ($existing) {
    Write-Warning "Another 'cheater' command is already visible: $($existing.Source)"
}
Write-Host "Recommended install from the repository root:"
Write-Host "  pip install -e ."
Write-Host "  cd cheater-pi; npm install; npm run build; npm link"
Write-Host ""
Write-Host "If you want to expose the script wrapper directly, add this folder to PATH:"
Write-Host "  $scriptFolder"
Write-Host ""

if (-not $AddToPath) {
    Write-Host "To request a safe user-PATH update, run:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\install_cheater.ps1 -AddToPath"
    Write-Host "You will be asked for explicit confirmation before anything changes."
    exit 0
}

$answer = Read-Host "Add this folder to your USER PATH? Type YES to confirm"
if ($answer -cne "YES") {
    Write-Host "Cancelled. PATH was not changed."
    exit 0
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ })
$alreadyPresent = $entries | Where-Object {
    [string]::Equals(
        $_.TrimEnd("\"),
        $scriptFolder.TrimEnd("\"),
        [StringComparison]::OrdinalIgnoreCase
    )
}

if ($alreadyPresent) {
    Write-Host "Cheater is already present in your user PATH."
    exit 0
}

$newPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
    $scriptFolder
} else {
    $userPath.TrimEnd(";") + ";" + $scriptFolder
}

[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
Write-Host "Added Cheater to the user PATH."
Write-Host "Open a new PowerShell window, then run:"
Write-Host "  cheater"
Write-Host ""
Write-Host "Undo: remove this exact folder from your USER PATH:"
Write-Host "  $scriptFolder"
