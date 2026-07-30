[CmdletBinding()]
param(
  [string]$Package = "@cheater/cheater-pi",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$minimum = [version]"22.5.0"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js >= 22.5.0 is required. Install it from https://nodejs.org/ and run this installer again."
}
$actual = [version](& $node.Source --version).TrimStart("v")
if ($actual -lt $minimum) {
  throw "Node.js $minimum or newer is required; found $actual. Upgrade from https://nodejs.org/ and run this installer again."
}
$spec = if ([string]::IsNullOrWhiteSpace($Version)) { $Package } else { "$Package@$Version" }
Write-Host "Installing Kitten package $spec ..."
& npm install --global $spec
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
Write-Host "Running Kitten doctor..."
& kitten doctor
if ($LASTEXITCODE -ne 0) { Write-Warning "Kitten doctor reported a problem; the installation itself succeeded." }
Write-Host "Kitten is installed. The native Windows app is available from the matching GitHub Release desktop ZIP/installer."
