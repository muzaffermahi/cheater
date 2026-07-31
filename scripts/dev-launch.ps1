# Kitten launcher. Finds the app wherever it exists on this machine, makes sure the hidden engine is
# sitting next to it, and starts it. Never opens a browser, a terminal UI, or a console window.
#
# Order of preference: an explicit override, an installed copy, a packaged bundle, then a dev build.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-KittenExe {
    $candidates = @(
        $env:KITTEN_DESKTOP_EXE,
        (Join-Path $env:LOCALAPPDATA "Kitten\Kitten.Desktop.exe"),
        (Join-Path $root "artifacts\kitten-desktop-bundle\Kitten.Desktop.exe"),
        (Join-Path $root "desktop\dist\Kitten.Desktop.exe"),
        (Join-Path $root "desktop\bin\Release\net8.0-windows\win-x64\Kitten.Desktop.exe"),
        (Join-Path $root "desktop\bin\Debug\net8.0-windows\win-x64\Kitten.Desktop.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Find-Dotnet {
    $local = Join-Path $root ".dotnet\dotnet.exe"
    if (Test-Path -LiteralPath $local) { return $local }
    $onPath = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}

$exe = Find-KittenExe
if (-not $exe) {
    # A dev tree with no build yet: build it rather than telling the user to go and find a command.
    $dotnet = Find-Dotnet
    $project = Join-Path $root "desktop\Kitten.Desktop.csproj"
    if (-not $dotnet -or -not (Test-Path -LiteralPath $project)) {
        throw "Kitten is not built or installed. Install the desktop package, or install the .NET 8 SDK and run this again from a source checkout."
    }
    Write-Host "Building Kitten (first run)..."
    & $dotnet build $project -c Release | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Kitten failed to build. Run: dotnet build desktop\Kitten.Desktop.csproj -c Release" }
    $exe = Find-KittenExe
    if (-not $exe) { throw "Kitten built but the executable could not be found." }
}

# The app talks to a hidden Node engine that lives in an `engine` folder beside the executable. An
# installed or packaged copy already ships one; a dev build has to have it staged from the compiled
# TypeScript. Copy-Item onto an existing folder NESTS it (engine\dist\dist) and would leave the app
# running a stale engine, so the destination is always removed first.
$appDir = Split-Path -Parent $exe
$engineDir = Join-Path $appDir "engine"
$engineEntry = Join-Path $engineDir "dist\src\core\desktopEngine.js"
$builtEngine = Join-Path $root "cheater-pi\dist\src\core\desktopEngine.js"

if (Test-Path -LiteralPath $builtEngine) {
    $needsStage = -not (Test-Path -LiteralPath $engineEntry)
    if (-not $needsStage) {
        $needsStage = (Get-Item $builtEngine).LastWriteTimeUtc -gt (Get-Item $engineEntry).LastWriteTimeUtc
    }
    if ($needsStage) {
        Write-Host "Staging the Kitten engine..."
        if (Test-Path -LiteralPath (Join-Path $engineDir "dist")) { Remove-Item -Recurse -Force (Join-Path $engineDir "dist") }
        New-Item -ItemType Directory -Force $engineDir | Out-Null
        Copy-Item -Recurse -Force (Join-Path $root "cheater-pi\dist") (Join-Path $engineDir "dist")
    }
} elseif (-not (Test-Path -LiteralPath $engineEntry)) {
    throw "The Kitten engine is missing. From a source checkout run: cd cheater-pi; npm install; npm run build"
}

# The engine needs a Node runtime. A packaged bundle carries its own; a dev build borrows the one on PATH.
$bundledNode = Join-Path $engineDir "node.exe"
if (-not (Test-Path -LiteralPath $bundledNode)) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { Copy-Item -Force $node.Source $bundledNode }
    else { throw "Node.js is required to run the Kitten engine from a source checkout. Install Node 22+ or use the packaged Kitten build." }
}

Start-Process -FilePath $exe -WorkingDirectory $appDir -WindowStyle Normal
