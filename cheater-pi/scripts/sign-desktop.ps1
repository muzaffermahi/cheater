param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$bundlePath = [System.IO.Path]::GetFullPath($Bundle)
$certificate = $env:KITTEN_SIGNING_CERTIFICATE_BASE64
$password = $env:KITTEN_SIGNING_CERTIFICATE_PASSWORD
if ($null -eq $password) { $password = "" }

if ([string]::IsNullOrWhiteSpace($certificate)) {
  if ($RequireSignature) { throw "KITTEN_SIGNING_CERTIFICATE_BASE64 is required for a signed release" }
  Write-Output "No signing certificate configured; leaving development bundle unsigned."
  exit 0
}

$signTool = Get-ChildItem -LiteralPath (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin") -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signTool) { throw "Windows SDK signtool.exe was not found" }

$pfx = Join-Path ([System.IO.Path]::GetTempPath()) "kitten-signing-$([guid]::NewGuid().ToString('N')).pfx"
try {
  [System.IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($certificate))
  $targets = @(
    (Join-Path $bundlePath "Kitten.Desktop.exe"),
    (Join-Path $bundlePath "Kitten.Setup.exe"),
    (Join-Path $bundlePath "engine\node.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  foreach ($target in $targets) {
    & $signTool.FullName sign /fd SHA256 /f $pfx /p $password /tr "http://timestamp.digicert.com" /td SHA256 $target
    if ($LASTEXITCODE -ne 0) { throw "signtool failed for $target" }
    $signature = Get-AuthenticodeSignature -LiteralPath $target
    if ($signature.Status -ne "Valid") { throw "signature verification failed for $target: $($signature.Status)" }
  }
  Write-Output "Signed and verified $($targets.Count) Kitten executable(s)."
}
finally {
  if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
}
