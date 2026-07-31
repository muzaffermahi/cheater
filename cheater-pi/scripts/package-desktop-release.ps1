param(
  [string]$Publish = "..\artifacts\kitten-desktop",
  [string]$Out = "..\artifacts\kitten-desktop-bundle",
  [Parameter(Mandatory = $true)][string]$NodeExe,
  # MANDATORY: a release without its installer is how runtime114 shipped with no Kitten.Setup.exe and
  # the README's install instructions became fiction. Every release carries the installer.
  [Parameter(Mandatory = $true)][string]$SetupExe,
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot = Resolve-Path (Join-Path $scriptRoot "..")
$publishPath = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $Publish))
$outPath = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $Out))
$nodePath = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $NodeExe))
$setupPath = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $SetupExe))

if (-not (Test-Path -LiteralPath $publishPath -PathType Container)) { throw "Desktop publish directory does not exist: $publishPath" }
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Bundled node.exe does not exist: $nodePath" }
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw "Native setup executable does not exist: $setupPath" }

$package = Get-Content (Join-Path $packageRoot "package.json") -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]$package.version }

Push-Location $packageRoot
try {
  & node scripts/package-desktop.mjs --publish $publishPath --out $outPath --node $nodePath
  if ($LASTEXITCODE -ne 0) { throw "package-desktop.mjs failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location }

Copy-Item -LiteralPath $setupPath -Destination (Join-Path $outPath "Kitten.Setup.exe") -Force

$signatureStatus = "unsigned-development"
$signingRequired = $env:KITTEN_REQUIRE_SIGNATURE -eq "true" -or $env:KITTEN_REQUIRE_SIGNATURE -eq "1"
$signingCertificate = $env:KITTEN_SIGNING_CERTIFICATE_BASE64
if ($signingRequired -or -not [string]::IsNullOrWhiteSpace($signingCertificate)) {
  $signer = Join-Path $scriptRoot "sign-desktop.ps1"
  $signArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $signer, "-Bundle", $outPath)
  if ($signingRequired) { $signArgs += "-RequireSignature" }
  & powershell.exe @signArgs
  if ($LASTEXITCODE -ne 0) { throw "native executable signing failed" }
  $signatureStatus = "authenticode-verified"
}

$exe = Join-Path $outPath "Kitten.Desktop.exe"
$manifest = Join-Path $outPath "kitten-manifest.json"
$engine = Join-Path $outPath "engine\dist\src\core\desktopEngine.js"
$runtime = Join-Path $outPath "engine\node.exe"
$setup = Join-Path $outPath "Kitten.Setup.exe"
foreach ($required in @($exe, $manifest, $engine, $runtime, $setup)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Release payload is incomplete: $required" }
}

Push-Location $packageRoot
try {
  & node scripts/native-engine-smoke.mjs --bundle $outPath --project-root $packageRoot
  if ($LASTEXITCODE -ne 0) { throw "native engine IPC smoke failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location }

$releaseInfo = [ordered]@{
  product = "Kitten"
  version = $Version
  target = "windows-x64"
  nativeOnly = $true
  browserFallback = $false
  engine = "engine/dist/src/core/desktopEngine.js"
  runtime = "engine/node.exe"
  installer = "Kitten.Setup.exe"
  signature = $signatureStatus
  generatedAt = [DateTime]::UtcNow.ToString("o")
}
$releaseInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outPath "release.json") -Encoding utf8

$zipPath = "$outPath.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $outPath "*") -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $(Split-Path -Leaf $zipPath)" | Set-Content -LiteralPath "$zipPath.sha256" -Encoding ascii
Write-Output "Created native Kitten release: $zipPath"
Write-Output "SHA-256: $hash"
